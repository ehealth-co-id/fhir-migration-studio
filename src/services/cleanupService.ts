import { fhirClient } from './fhirClient';
import { log } from '../store/logStore';
import { useCleanupStore } from '../store/cleanupStore';
import { splitBundleEntries } from './bundleBuilder';
import { sortByDependencyOrder } from './dependencyGraph';
import type { ServerConfig } from '../types/server';
import type { FhirResource, FhirResourceType, Bundle, BundleEntry } from '../types/fhir';

export function belongsToMigrationTool(resource: FhirResource, initiatorComponent: string): boolean {
  return !!resource.meta?.extension?.some(
    (ext) =>
      (ext.url === 'https://ehealth.co.id/terminology/initiator-component' ||
        ext.url === 'initiator-component') &&
      ext.valueString === initiatorComponent
  );
}

export interface ScanOptions {
  target: ServerConfig;
  selectedTypes: FhirResourceType[];
  dateFrom?: string;
  dateTo?: string;
  initiatorComponent: string;
  checkStatus: () => Promise<boolean>;
}

export async function scanCleanupResources(options: ScanOptions): Promise<Record<string, FhirResource[]>> {
  const { target, selectedTypes, dateFrom, dateTo, initiatorComponent, checkStatus } = options;
  const store = useCleanupStore.getState();
  const results: Record<string, FhirResource[]> = {};

  const orderedTypes = sortByDependencyOrder(selectedTypes);

  for (const rt of orderedTypes) {
    if (!(await checkStatus())) break;

    log({
      level: 'info',
      message: `[Cleanup Scan] Scanning ${rt}...`,
      resourceType: rt,
    });

    const matchedResources: FhirResource[] = [];
    const queryParts = [
      `_count=250`,
      // `initiator-component=${initiatorComponent}`
    ];
    if (dateFrom) queryParts.push(`_lastUpdated=ge${dateFrom}`);
    if (dateTo) queryParts.push(`_lastUpdated=le${dateTo}`);
    const path = `/${rt}?${queryParts.join('&')}`;

    try {
      let bundle = await fhirClient.get<Bundle>(target, path);
      let pageNum = 1;

      while (true) {
        if (!(await checkStatus())) break;

        const pageResources = (bundle.entry ?? [])
          .map((e) => e.resource)
          .filter((r): r is FhirResource => r !== undefined);

        const matched = pageResources.filter(r => belongsToMigrationTool(r, initiatorComponent));
        matchedResources.push(...matched);

        // Update scan progress incrementally
        store.updateResourceProgress(rt, {
          total: matchedResources.length,
        });

        const nextLink = bundle.link?.find((l) => l.relation === 'next');
        if (!nextLink) break;

        pageNum++;
        bundle = await fhirClient.nextPage(target, nextLink.url);
      }

      results[rt] = matchedResources;
      log({
        level: 'info',
        message: `[Cleanup Scan] Found ${matchedResources.length} matching resources for ${rt}`,
        resourceType: rt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log({
        level: 'error',
        message: `[Cleanup Scan] Failed scanning ${rt}: ${msg}`,
        resourceType: rt,
      });
      results[rt] = [];
      store.updateResourceProgress(rt, { total: 0 });
    }
  }

  return results;
}

export interface CleanupOptions {
  target: ServerConfig;
  selectedTypes: FhirResourceType[];
  resourcesMap: Record<string, FhirResource[]>;
  isDryRun: boolean;
  jobId: string;
  checkStatus: () => Promise<boolean>;
}

export async function executeCleanup(options: CleanupOptions): Promise<void> {
  const { target, selectedTypes, resourcesMap, isDryRun, jobId, checkStatus } = options;
  const store = useCleanupStore.getState();

  // Cleanup must execute using the reverse migration dependency order to minimize referential integrity violations
  const orderedTypes = sortByDependencyOrder(selectedTypes).reverse();

  log({
    level: 'info',
    message: `[Cleanup] Starting cleanup execution (Reverse Dependency Order). Dry Run: ${isDryRun}`,
    jobId,
  });

  try {
    for (const rt of orderedTypes) {
      if (!(await checkStatus())) {
        store.updateStatus('cancelled');
        log({
          level: 'warn',
          message: `[Cleanup] Cleanup cancelled`,
          jobId,
        });
        return;
      }

      const resources = resourcesMap[rt] ?? [];
      if (resources.length === 0) {
        log({
          level: 'info',
          message: `[Cleanup] No resources to clean up for ${rt}`,
          resourceType: rt,
          jobId,
        });
        store.updateResourceProgress(rt, { deleted: 0, failed: 0 });
        continue;
      }

      log({
        level: 'info',
        message: `[Cleanup] Deleting ${resources.length} resources of type ${rt}...`,
        resourceType: rt,
        jobId,
      });

      // Build DELETE entries
      const entries: BundleEntry[] = resources.map((r) => ({
        request: {
          method: 'DELETE',
          url: `${r.resourceType}/${r.id}`,
        },
      }));

      // Split entries into bundles using the shared builder
      const bundles = splitBundleEntries(entries);

      if (isDryRun) {
        log({
          level: 'info',
          message: `[Cleanup Dry-Run] Estimated ${bundles.length} Transaction Bundles for ${rt}`,
          resourceType: rt,
          jobId,
        });
        store.updateResourceProgress(rt, { deleted: resources.length, failed: 0 });
        continue;
      }

      let deletedCount = 0;
      let failedCount = 0;

      for (let bundleIndex = 0; bundleIndex < bundles.length; bundleIndex++) {
        if (!(await checkStatus())) {
          store.updateStatus('cancelled');
          return;
        }

        const bundle = bundles[bundleIndex];
        const bundleResourceCount = bundle.entry?.length ?? 0;

        log({
          level: 'info',
          message: `[Cleanup] Sending bundle ${bundleIndex + 1}/${bundles.length} of ${rt} (${bundleResourceCount} resources)`,
          resourceType: rt,
          jobId,
        });

        try {
          const responseBundle = await fhirClient.post<Bundle>(target, '/', bundle);
          const responseEntries = responseBundle.entry ?? [];

          let bundleSuccess = 0;
          let bundleFailed = 0;
          const failedDetails: string[] = [];

          for (let entryIdx = 0; entryIdx < responseEntries.length; entryIdx++) {
            const entry = responseEntries[entryIdx];
            const statusStr = entry.response?.status ?? '500';
            const code = parseInt(statusStr.split(' ')[0], 10);

            if (code >= 200 && code < 300) {
              bundleSuccess++;
            } else {
              bundleFailed++;
              const resourceUrl = bundle.entry?.[entryIdx]?.request?.url ?? 'Unknown';
              failedDetails.push(`${resourceUrl} (Status: ${statusStr})`);
            }
          }

          deletedCount += bundleSuccess;
          failedCount += bundleFailed;

          store.updateResourceProgress(rt, {
            deleted: deletedCount,
            failed: failedCount,
          });

          if (bundleFailed > 0) {
            log({
              level: 'warn',
              message: `[Cleanup] Bundle ${bundleIndex + 1} of ${rt} had ${bundleFailed} failures`,
              resourceType: rt,
              jobId,
              detail: `Failed resources:\n${failedDetails.join('\n')}`,
            });
          } else {
            log({
              level: 'success',
              message: `[Cleanup] Bundle ${bundleIndex + 1} of ${rt} deleted successfully`,
              resourceType: rt,
              jobId,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failedCount += bundleResourceCount;
          store.updateResourceProgress(rt, {
            failed: failedCount,
          });

          const resourceList = bundle.entry?.map((e) => e.request?.url).join('\n') ?? 'None';
          log({
            level: 'error',
            message: `[Cleanup] Bundle ${bundleIndex + 1} of ${rt} failed: ${msg}`,
            resourceType: rt,
            jobId,
            detail: `Server response: ${msg}\nResources in bundle:\n${resourceList}`,
          });
        }
      }
    }

    store.completeJob();
    log({
      level: 'success',
      message: `[Cleanup] Cleanup completed successfully.`,
      jobId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    store.setError(msg);
    log({
      level: 'error',
      message: `[Cleanup] Cleanup failed: ${msg}`,
      jobId,
    });
  }
}
