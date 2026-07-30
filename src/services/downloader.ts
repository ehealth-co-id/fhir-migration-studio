/**
 * Downloader — fetches all pages of a resource type from the source server.
 * Streams pages and invokes onPage callback for incremental processing.
 */

import { fhirClient } from './fhirClient';
import { log } from '../store/logStore';
import type { ServerConfig } from '../types/server';
import type { FhirResource, FhirResourceType } from '../types/fhir';

export const PAGE_SIZE = 100000;

export interface DownloadOptions {
  /** Called for each page of resources received */
  onPage: (resources: FhirResource[], downloaded: number, total: number) => void;
  /** Called to check if migration was paused/cancelled — should return true to continue */
  shouldContinue?: () => boolean;
}

/**
 * Downloads all resources of a given type from the server, page by page.
 * @param config Source server configuration
 * @param resourceType The FHIR resource type to download
 * @param options Callbacks for progress and cancellation
 * @returns All resources fetched across all pages
 */
export async function downloadResourceType(
  config: ServerConfig,
  resourceType: FhirResourceType,
  options: DownloadOptions,
  dateFrom?: string,
  dateTo?: string,
): Promise<FhirResource[]> {
  const all: FhirResource[] = [];
  let pageNum = 0;

  log({ level: 'info', message: `Starting download: ${resourceType}`, resourceType });

  // Build search params including optional date range
  const searchParams: Record<string, string | string[]> = {
    _count: String(PAGE_SIZE),
  };
  const lastUpdated: string[] = [];
  if (dateFrom) lastUpdated.push(`ge${dateFrom}`);
  if (dateTo) lastUpdated.push(`le${dateTo}`);
  if (lastUpdated.length > 0) searchParams['_lastUpdated'] = lastUpdated;

  // First page
  let bundle = await fhirClient.search(config, resourceType, searchParams);

  const total = bundle.total ?? 0;

  while (true) {
    pageNum++;
    const resources = (bundle.entry ?? [])
      .map((e) => e.resource)
      .filter((r): r is FhirResource => r !== undefined);

    all.push(...resources);
    options.onPage(resources, all.length, total);

    log({
      level: 'info',
      message: `Downloaded page ${pageNum}: ${resources.length} ${resourceType} (${all.length}/${total})`,
      resourceType,
    });

    // Check continuation
    if (options.shouldContinue && !options.shouldContinue()) {
      log({ level: 'warn', message: `Download paused/cancelled: ${resourceType}`, resourceType });
      break;
    }

    // Find next page link
    const nextLink = bundle.link?.find((l) => l.relation === 'next');
    if (!nextLink) break;

    bundle = await fhirClient.nextPage(config, nextLink.url);
  }

  log({
    level: 'success',
    message: `Download complete: ${all.length} ${resourceType} resources`,
    resourceType,
  });

  return all;
}
