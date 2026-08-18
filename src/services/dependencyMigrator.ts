/**
 * Dependency Migrator — generic pipeline that migrates every resource type
 * in dependency order (per docs/FHIR_RULES.md §New Migration Strategy).
 *
 * Strategy:
 *   For each resource type (in DEPENDENCY_ORDER):
 *     1. Skip types the user did not select (no download, no count request)
 *     2. Skip types already completed in the checkpoint (resume support)
 *     3. Download all resources of that type from the source server
 *     4. Rewrite all references using ResourceMappingService (destination IDs)
 *     5. Split into batches of `bundleSize` resources (default: DEFAULT_BUNDLE_SIZE)
 *     6. For each batch:
 *        a. Build a Transaction Bundle (single resource type per bundle)
 *        b. Upload the bundle
 *        c. Register new server-assigned IDs in ResourceMappingService
 *        d. Persist new mappings + updated checkpoint to disk
 *     7. Mark the resource type as completed in the checkpoint
 *
 * Special case — Patient:
 *   Step 4a: Upload all Patients WITHOUT Patient.link.other (link field stripped)
 *   Step 4b: After ALL Patients are uploaded and their IDs are known, send a PUT
 *            bundle to restore Patient.link.other with mapped destination IDs.
 *
 * Special case — Composition:
 *   Step 4a: Upload all Compositions WITHOUT relatesTo (field stripped)
 *   Step 4b: After ALL Compositions are uploaded and their IDs are known, send a
 *            PUT bundle to restore Composition.relatesTo with mapped destination IDs.
 *
 * Special case — Observation:
 *   Step 4a: Upload all Observations WITHOUT related (field stripped)
 *   Step 4b: After ALL Observations are uploaded and their IDs are known, send a
 *            PUT bundle to restore Observation.related with mapped destination IDs.
 *            Observation.related.target may reference another Observation, so the
 *            reference can only be rewritten once every Observation ID is known.
 *
 * Per docs/FHIR_RULES.md:
 *   - Each Transaction Bundle contains only resources of a single resource type
 *   - Bundle size is configurable (default 100)
 *   - Every reference must be rewritten to destination IDs before bundling
 *   - Successfully migrated bundles must never be migrated again
 *   - Every bundle is independently retryable
 */

import { downloadResourceType } from './downloader';
import { buildResourceTypeBundle, splitPreparedEntries, splitBundleEntries } from './bundleBuilder';
import type { PreparedEntry } from './bundleBuilder';
import { rewriteResourceRefs } from './referenceRewriter';
import { uploadSingleBundle } from './uploader';
import {
  saveCheckpoint,
  checkpointWithMappings,
  checkpointWithCompletedType,
  checkpointWithPatientLinkPatched,
  checkpointWithCompositionRelatesToPatched,
  checkpointWithObservationRelatedPatched,
  isResourceTypeComplete,
} from './checkpointService';
import { DEPENDENCY_ORDER, sortByDependencyOrder } from './dependencyGraph';
import { log } from '../store/logStore';
import { useMigrationStore } from '../store/migrationStore';
import type { ResourceMappingService } from './resourceMappingService';
import type { MigrationCheckpoint } from '../types/migration';
import type { ServerConfig } from '../types/server';
import type { FhirResource, FhirResourceType } from '../types/fhir';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default maximum resources per Transaction Bundle.
 * Per docs/FHIR_RULES.md: configurable, default 100.
 */
export const DEFAULT_BUNDLE_SIZE = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DependencyMigratorOptions {
  source: ServerConfig;
  target: ServerConfig;
  /** Maximum resources per Transaction Bundle. Defaults to DEFAULT_BUNDLE_SIZE. */
  bundleSize?: number;
  jobId: string;
  /**
   * Resource types selected by the user. Only these types will be downloaded
   * and migrated. Types NOT in this list are completely ignored — no count
   * requests, no downloads.
   */
  selectedResourceTypes: FhirResourceType[];
  /** Optional start date for _lastUpdated range (inclusive, ISO date string). */
  dateFrom?: string;
  /** Optional end date for _lastUpdated range (inclusive, ISO date string). */
  dateTo?: string;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the full dependency-driven migration pipeline.
 *
 * @param options        Source/target server configs, bundle size, selected types
 * @param mappingService Central ID mapping store (mutated in-place)
 * @param checkpoint     Current checkpoint state
 * @param onCheckpoint   Called with the updated checkpoint after each save
 * @param checkStatus    Returns false when the migration has been cancelled/paused
 */
export async function runDependencyMigration(
  options: DependencyMigratorOptions,
  mappingService: ResourceMappingService,
  checkpoint: MigrationCheckpoint,
  onCheckpoint: (updated: MigrationCheckpoint) => void,
  checkStatus: () => Promise<boolean>,
): Promise<MigrationCheckpoint> {
  const {
    source,
    target,
    bundleSize = DEFAULT_BUNDLE_SIZE,
    jobId,
    selectedResourceTypes,
    dateFrom,
    dateTo,
  } = options;

  // Sort selected types by dependency order
  const orderedTypes = sortByDependencyOrder(
    DEPENDENCY_ORDER.filter((rt) => selectedResourceTypes.includes(rt)),
  );

  // Keep Patients in memory for the Patient.link.other restoration step
  let patientResources: FhirResource[] = [];
  // Keep Compositions in memory for the Composition.relatesTo restoration step
  let compositionResources: FhirResource[] = [];
  // Keep Observations in memory for the Observation.related restoration step
  let observationResources: FhirResource[] = [];

  for (const resourceType of orderedTypes) {
    if (!(await checkStatus())) return checkpoint;

    // Skip resource types already completed in a previous (resumed) run
    if (isResourceTypeComplete(checkpoint, resourceType)) {
      log({
        level: 'info',
        message: `[Migration] Skipping ${resourceType} — already completed (checkpoint)`,
        resourceType,
        jobId,
      });

      // Still need patient resources for the link.other step — download but don't upload
      if (resourceType === 'Patient' && !checkpoint.patientLinkPatched) {
        patientResources = await downloadAllResources(source, resourceType, jobId, undefined, dateFrom, dateTo);
      }

      // Still need Composition resources for the relatesTo step — download but don't upload
      if (resourceType === 'Composition' && !checkpoint.compositionRelatesToPatched) {
        compositionResources = await downloadAllResources(source, resourceType, jobId, undefined, dateFrom, dateTo);
      }

      // Still need Observation resources for the related step — download but don't upload
      if (resourceType === 'Observation' && !checkpoint.observationRelatedPatched) {
        observationResources = await downloadAllResources(source, resourceType, jobId, undefined, dateFrom, dateTo);
      }

      continue;
    }

    log({
      level: 'info',
      message: `[Migration] Starting ${resourceType}...`,
      resourceType,
      jobId,
    });

    // Download all resources of this type
    const resources = await downloadAllResources(source, resourceType, jobId, (downloaded, total) => {
      useMigrationStore.getState().updateResourceProgress(resourceType, { total, downloaded });
    }, dateFrom, dateTo);

    if (!(await checkStatus())) return checkpoint;

    log({
      level: 'info',
      message: `[Migration] Downloaded ${resources.length} ${resourceType}`,
      resourceType,
      jobId,
    });

    if (resourceType === 'Patient') {
      // Stage 1: Upload Patients WITHOUT link.other
      patientResources = resources;
      checkpoint = await uploadResourceTypeBatches(
        resources,
        resourceType,
        bundleSize,
        target,
        mappingService,
        checkpoint,
        onCheckpoint,
        jobId,
        checkStatus,
        ['link'], // strip Patient.link to remove link.other
      );
    } else if (resourceType === 'Composition') {
      // Stage 1: Upload Compositions WITHOUT relatesTo
      compositionResources = resources;
      checkpoint = await uploadResourceTypeBatches(
        resources,
        resourceType,
        bundleSize,
        target,
        mappingService,
        checkpoint,
        onCheckpoint,
        jobId,
        checkStatus,
        ['relatesTo'], // strip Composition.relatesTo
      );
    } else if (resourceType === 'Observation') {
      // Stage 1: Upload Observations WITHOUT related
      // Observation.related.target may reference another Observation whose
      // destination ID is not known yet, so related is restored in Stage 2.
      observationResources = resources;
      checkpoint = await uploadResourceTypeBatches(
        resources,
        resourceType,
        bundleSize,
        target,
        mappingService,
        checkpoint,
        onCheckpoint,
        jobId,
        checkStatus,
        ['related'], // strip Observation.related
      );
    } else {
      // Normal upload: rewrite references then upload
      checkpoint = await uploadResourceTypeBatches(
        resources,
        resourceType,
        bundleSize,
        target,
        mappingService,
        checkpoint,
        onCheckpoint,
        jobId,
        checkStatus,
      );
    }

    if (!(await checkStatus())) return checkpoint;

    // Mark this resource type as fully completed
    checkpoint = checkpointWithCompletedType(checkpoint, resourceType);
    onCheckpoint(checkpoint);
    await saveCheckpoint(checkpoint);

    log({
      level: 'success',
      message: `[Migration] ${resourceType} complete`,
      resourceType,
      jobId,
    });
  }

  // ---------------------------------------------------------------------------
  // Patient Stage 2: Restore Patient.link.other
  // ---------------------------------------------------------------------------
  if (
    selectedResourceTypes.includes('Patient') &&
    !checkpoint.patientLinkPatched
  ) {
    checkpoint = await restorePatientLinks(
      patientResources,
      target,
      mappingService,
      checkpoint,
      onCheckpoint,
      jobId,
    );
  }

  // ---------------------------------------------------------------------------
  // Composition Stage 2: Restore Composition.relatesTo
  // ---------------------------------------------------------------------------
  if (
    selectedResourceTypes.includes('Composition') &&
    !checkpoint.compositionRelatesToPatched
  ) {
    checkpoint = await restoreCompositionRelatesTo(
      compositionResources,
      target,
      mappingService,
      checkpoint,
      onCheckpoint,
      jobId,
    );
  }

  // ---------------------------------------------------------------------------
  // Observation Stage 2: Restore Observation.related
  // ---------------------------------------------------------------------------
  if (
    selectedResourceTypes.includes('Observation') &&
    !checkpoint.observationRelatedPatched
  ) {
    checkpoint = await restoreObservationRelated(
      observationResources,
      target,
      mappingService,
      checkpoint,
      onCheckpoint,
      jobId,
    );
  }

  return checkpoint;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Download all pages of a resource type and return the complete list.
 * Updates UI progress if an onProgress callback is provided.
 */
async function downloadAllResources(
  source: ServerConfig,
  resourceType: FhirResourceType,
  jobId: string,
  onProgress?: (downloaded: number, total: number) => void,
  dateFrom?: string,
  dateTo?: string,
): Promise<FhirResource[]> {
  const resources: FhirResource[] = [];
  await downloadResourceType(source, resourceType, {
    onPage: (page, downloaded, total) => {
      resources.push(...page);
      onProgress?.(downloaded, total);
    },
    shouldContinue: () => {
      const s = useMigrationStore.getState().current?.status;
      return s !== 'cancelled' && s !== 'paused';
    },
  }, dateFrom, dateTo);
  void jobId; // used by caller for context; kept for future structured logging
  return resources;
}

/**
 * Rewrite references, split into batches of bundleSize, build a Transaction Bundle
 * for each batch, upload, register mappings, and save checkpoint.
 * Returns the updated checkpoint.
 *
 * Per FHIR_RULES.md:
 *   - Each bundle contains only resources of a single resource type
 *   - Every reference must be rewritten to destination IDs before bundling
 *   - Each bundle is independently retryable
 */
async function uploadResourceTypeBatches(
  resources: FhirResource[],
  resourceType: FhirResourceType,
  bundleSize: number,
  target: ServerConfig,
  mappingService: ResourceMappingService,
  checkpoint: MigrationCheckpoint,
  onCheckpoint: (updated: MigrationCheckpoint) => void,
  jobId: string,
  checkStatus: () => Promise<boolean>,
  stripFields: string[] = [],
): Promise<MigrationCheckpoint> {
  if (resources.length === 0) return checkpoint;
  void bundleSize;

  let totalUploaded = 0;
  let totalFailed = 0;

  // Prepare all entries with their original references first
  const preparedEntries: PreparedEntry[] = resources.map((resource) => {
    const rewritten = rewriteResourceRefs(resource, mappingService.getMap());
    const { bundle, originalRefs } = buildResourceTypeBundle([rewritten], stripFields);
    return {
      entry: bundle.entry![0],
      originalRef: originalRefs[0],
    };
  });

  // Use the shared bundle splitting algorithm.
   // For Media resource type, upload one resource per bundle to avoid
   // HAPI FHIR BinaryStorageEntity collision (EntityExistsException) when
   // multiple Media resources share identical inline content.data within
   // the same transaction.
   const batches = resourceType === 'Media'
     ? preparedEntries.map((entry) => ({
         bundle: {
           resourceType: 'Bundle' as const,
           type: 'transaction' as const,
           entry: [entry.entry],
         },
         originalRefs: entry.originalRef ? [entry.originalRef] : [],
       }))
     : splitPreparedEntries(preparedEntries);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    if (!(await checkStatus())) return checkpoint;

    const { bundle, originalRefs } = batches[batchIndex];
    const currentBatchSize = bundle.entry?.length ?? 0;

    log({
      level: 'info',
      message: `[Migration] Uploading ${resourceType} bundle ${batchIndex + 1} (${currentBatchSize} resources)`,
      resourceType,
      jobId,
    });

    try {
      const responseBundle = await uploadSingleBundle(target, bundle);
      const entries = responseBundle.entry ?? [];

      // Register new server-assigned IDs in memory
      mappingService.registerResponseMappings(originalRefs, entries);

      // Build a plain-object diff of only the NEW mappings from this batch
      const newMappings: Record<string, string> = {};
      for (let j = 0; j < originalRefs.length; j++) {
        const newRef = mappingService.get(originalRefs[j]);
        if (newRef) newMappings[originalRefs[j]] = newRef;
      }

      // Persist new mappings to checkpoint
      checkpoint = checkpointWithMappings(checkpoint, newMappings);
      onCheckpoint(checkpoint);
      await saveCheckpoint(checkpoint);

      // Count results
      let success = 0;
      let failed = 0;
      for (const entry of entries) {
        const code = parseInt((entry.response?.status ?? '').split(' ')[0], 10);
        if (code >= 200 && code < 300) success++;
        else failed++;
      }

      totalUploaded += success;
      totalFailed += failed;

      useMigrationStore.getState().updateResourceProgress(resourceType, {
        uploaded: totalUploaded,
        failed: totalFailed,
      });

      log({
        level: failed > 0 ? 'warn' : 'success',
        message: `[Migration] ${resourceType} bundle ${batchIndex + 1}: ${success} ok, ${failed} failed`,
        resourceType,
        jobId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      totalFailed += currentBatchSize;
      useMigrationStore.getState().updateResourceProgress(resourceType, { failed: totalFailed });
      log({
        level: 'error',
        message: `[Migration] ${resourceType} bundle ${batchIndex + 1} failed: ${msg}`,
        resourceType,
        jobId,
      });
    }
  }

  return checkpoint;
}

/**
 * Patient Stage 2 — restore Patient.link.other.
 *
 * After ALL Patients have been uploaded (Stage 1), send a Transaction Bundle of
 * PUT entries to restore each Patient's link.other references using the now-available
 * destination Patient IDs from ResourceMappingService.
 *
 * Per docs/FHIR_RULES.md §Patient.link.other:
 *   Stage 1: Create all Patients without link.other
 *   Stage 2: Update Patients and restore link.other using mapped IDs
 */
async function restorePatientLinks(
  patients: FhirResource[],
  target: ServerConfig,
  mappingService: ResourceMappingService,
  checkpoint: MigrationCheckpoint,
  onCheckpoint: (updated: MigrationCheckpoint) => void,
  jobId: string,
): Promise<MigrationCheckpoint> {
  if (checkpoint.patientLinkPatched) {
    log({
      level: 'info',
      message: '[Migration] Patient link.other already restored (checkpoint) — skipping',
      jobId,
    });
    return checkpoint;
  }

  const patientsWithLinks = patients.filter(
    (p) => Array.isArray((p as Record<string, unknown>).link),
  );

  if (patientsWithLinks.length === 0) {
    log({
      level: 'info',
      message: '[Migration] No Patients have link.other — skipping restore step',
      jobId,
    });
    checkpoint = checkpointWithPatientLinkPatched(checkpoint);
    onCheckpoint(checkpoint);
    await saveCheckpoint(checkpoint);
    return checkpoint;
  }

  log({
    level: 'info',
    message: `[Migration] Restoring link.other for ${patientsWithLinks.length} Patients...`,
    resourceType: 'Patient',
    jobId,
  });

  useMigrationStore.getState().updateStatus('patching');

  const { fhirClient } = await import('./fhirClient');
  const { generateUrn } = await import('./bundleBuilder');

  const MIGRATION_MARKER = {
    url: 'https://ehealth.co.id/terminology/initiator-component',
    valueString: 'fhir-migration-tool',
  };

  const entries = patientsWithLinks.map((patient) => {
    const newRef = patient.id ? mappingService.get(`Patient/${patient.id}`) : undefined;
    if (!newRef) return null; // Patient wasn't successfully uploaded — skip

    const newId = newRef.split('/')[1];

    // Rewrite link.other references using the mapping
    const rewritten = rewriteResourceRefs(patient, mappingService.getMap());
    const { id: _id, resourceType: _rt, meta, ...rest } = rewritten;
    void _id;
    void _rt;

    // Inline meta cleaning: strip versionId/lastUpdated, inject migration marker
    const { versionId: _v, lastUpdated: _l, ...metaRest } =
      (meta ?? {}) as NonNullable<FhirResource['meta']>;
    void _v; void _l;
    const metaCleaned = {
      ...metaRest,
      extension: [...(metaRest.extension ?? []), MIGRATION_MARKER],
    };

    return {
      fullUrl: generateUrn(),
      resource: { resourceType: 'Patient' as const, id: newId, ...rest, meta: metaCleaned } as FhirResource,
      request: { method: 'PUT' as const, url: `Patient/${newId}` },
    };
  }).filter((e): e is NonNullable<typeof e> => e !== null);

  if (entries.length === 0) {
    log({
      level: 'warn',
      message: '[Migration] No Patients could be patched (mapping missing)',
      jobId,
    });
  } else {
    const batches = splitBundleEntries(entries);
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const patchBundle = batches[batchIndex];
      try {
        await fhirClient.post(target, '/', patchBundle);
        log({
          level: 'success',
          message: `[Migration] Restored link.other for batch ${batchIndex + 1} (${patchBundle.entry?.length ?? 0} Patients)`,
          resourceType: 'Patient',
          jobId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log({
          level: 'error',
          message: `[Migration] Patient link.other restore batch ${batchIndex + 1} failed: ${msg}`,
          resourceType: 'Patient',
          jobId,
        });
      }
    }
  }

  checkpoint = checkpointWithPatientLinkPatched(checkpoint);
  onCheckpoint(checkpoint);
  await saveCheckpoint(checkpoint);
  return checkpoint;
}

/**
 * Composition Stage 2 — restore Composition.relatesTo.
 *
 * After ALL Compositions (and other resource types) have been uploaded (Stage 1),
 * send a Transaction Bundle of PUT entries to restore each Composition's relatesTo
 * references using the destination Composition IDs from ResourceMappingService.
 */
async function restoreCompositionRelatesTo(
  compositions: FhirResource[],
  target: ServerConfig,
  mappingService: ResourceMappingService,
  checkpoint: MigrationCheckpoint,
  onCheckpoint: (updated: MigrationCheckpoint) => void,
  jobId: string,
): Promise<MigrationCheckpoint> {
  if (checkpoint.compositionRelatesToPatched) {
    log({
      level: 'info',
      message: '[Migration] Composition relatesTo already restored (checkpoint) — skipping',
      jobId,
    });
    return checkpoint;
  }

  const compositionsWithRelatesTo = compositions.filter(
    (c) => Array.isArray((c as Record<string, unknown>).relatesTo),
  );

  if (compositionsWithRelatesTo.length === 0) {
    log({
      level: 'info',
      message: '[Migration] No Compositions have relatesTo — skipping restore step',
      jobId,
    });
    checkpoint = checkpointWithCompositionRelatesToPatched(checkpoint);
    onCheckpoint(checkpoint);
    await saveCheckpoint(checkpoint);
    return checkpoint;
  }

  log({
    level: 'info',
    message: `[Migration] Restoring relatesTo for ${compositionsWithRelatesTo.length} Compositions...`,
    resourceType: 'Composition',
    jobId,
  });

  useMigrationStore.getState().updateStatus('patching');

  const { fhirClient } = await import('./fhirClient');
  const { generateUrn } = await import('./bundleBuilder');

  const MIGRATION_MARKER = {
    url: 'https://ehealth.co.id/terminology/initiator-component',
    valueString: 'fhir-migration-tool',
  };

  const entries = compositionsWithRelatesTo.map((composition) => {
    const newRef = composition.id ? mappingService.get(`Composition/${composition.id}`) : undefined;
    if (!newRef) return null; // Composition wasn't successfully uploaded — skip

    const newId = newRef.split('/')[1];

    // Rewrite relatesTo references using the mapping
    const rewritten = rewriteResourceRefs(composition, mappingService.getMap());
    const { id: _id, resourceType: _rt, meta, ...rest } = rewritten;
    void _id;
    void _rt;

    // Inline meta cleaning: strip versionId/lastUpdated, inject migration marker
    const { versionId: _v, lastUpdated: _l, ...metaRest } =
      (meta ?? {}) as NonNullable<FhirResource['meta']>;
    void _v; void _l;
    const metaCleaned = {
      ...metaRest,
      extension: [...(metaRest.extension ?? []), MIGRATION_MARKER],
    };

    return {
      fullUrl: generateUrn(),
      resource: { resourceType: 'Composition' as const, id: newId, ...rest, meta: metaCleaned } as FhirResource,
      request: { method: 'PUT' as const, url: `Composition/${newId}` },
    };
  }).filter((e): e is NonNullable<typeof e> => e !== null);

  if (entries.length === 0) {
    log({
      level: 'warn',
      message: '[Migration] No Compositions could be patched (mapping missing)',
      jobId,
    });
  } else {
    const batches = splitBundleEntries(entries);
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const patchBundle = batches[batchIndex];
      try {
        await fhirClient.post(target, '/', patchBundle);
        log({
          level: 'success',
          message: `[Migration] Restored relatesTo for batch ${batchIndex + 1} (${patchBundle.entry?.length ?? 0} Compositions)`,
          resourceType: 'Composition',
          jobId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log({
          level: 'error',
          message: `[Migration] Composition relatesTo restore batch ${batchIndex + 1} failed: ${msg}`,
          resourceType: 'Composition',
          jobId,
        });
      }
    }
  }

  checkpoint = checkpointWithCompositionRelatesToPatched(checkpoint);
  onCheckpoint(checkpoint);
  await saveCheckpoint(checkpoint);
  return checkpoint;
}

/**
 * Observation Stage 2 — restore Observation.related.
 *
 * After ALL Observations (and other resource types) have been uploaded (Stage 1),
 * send a Transaction Bundle of PUT entries to restore each Observation's related
 * references using the destination Observation IDs from ResourceMappingService.
 *
 * Observation.related.target may reference another Observation (e.g. derived-from,
 * has-member), so it can only be rewritten once every Observation ID is known.
 */
async function restoreObservationRelated(
  observations: FhirResource[],
  target: ServerConfig,
  mappingService: ResourceMappingService,
  checkpoint: MigrationCheckpoint,
  onCheckpoint: (updated: MigrationCheckpoint) => void,
  jobId: string,
): Promise<MigrationCheckpoint> {
  if (checkpoint.observationRelatedPatched) {
    log({
      level: 'info',
      message: '[Migration] Observation related already restored (checkpoint) — skipping',
      jobId,
    });
    return checkpoint;
  }

  const observationsWithRelated = observations.filter(
    (o) => Array.isArray((o as Record<string, unknown>).related),
  );

  if (observationsWithRelated.length === 0) {
    log({
      level: 'info',
      message: '[Migration] No Observations have related — skipping restore step',
      jobId,
    });
    checkpoint = checkpointWithObservationRelatedPatched(checkpoint);
    onCheckpoint(checkpoint);
    await saveCheckpoint(checkpoint);
    return checkpoint;
  }

  log({
    level: 'info',
    message: `[Migration] Restoring related for ${observationsWithRelated.length} Observations...`,
    resourceType: 'Observation',
    jobId,
  });

  useMigrationStore.getState().updateStatus('patching');

  const { fhirClient } = await import('./fhirClient');
  const { generateUrn } = await import('./bundleBuilder');

  const MIGRATION_MARKER = {
    url: 'https://ehealth.co.id/terminology/initiator-component',
    valueString: 'fhir-migration-tool',
  };

  const entries = observationsWithRelated.map((observation) => {
    const newRef = observation.id ? mappingService.get(`Observation/${observation.id}`) : undefined;
    if (!newRef) return null; // Observation wasn't successfully uploaded — skip

    const newId = newRef.split('/')[1];

    // Rewrite related references using the mapping
    const rewritten = rewriteResourceRefs(observation, mappingService.getMap());
    const { id: _id, resourceType: _rt, meta, ...rest } = rewritten;
    void _id;
    void _rt;

    // Inline meta cleaning: strip versionId/lastUpdated, inject migration marker
    const { versionId: _v, lastUpdated: _l, ...metaRest } =
      (meta ?? {}) as NonNullable<FhirResource['meta']>;
    void _v; void _l;
    const metaCleaned = {
      ...metaRest,
      extension: [...(metaRest.extension ?? []), MIGRATION_MARKER],
    };

    return {
      fullUrl: generateUrn(),
      resource: { resourceType: 'Observation' as const, id: newId, ...rest, meta: metaCleaned } as FhirResource,
      request: { method: 'PUT' as const, url: `Observation/${newId}` },
    };
  }).filter((e): e is NonNullable<typeof e> => e !== null);

  if (entries.length === 0) {
    log({
      level: 'warn',
      message: '[Migration] No Observations could be patched (mapping missing)',
      jobId,
    });
  } else {
    const batches = splitBundleEntries(entries);
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const patchBundle = batches[batchIndex];
      try {
        await fhirClient.post(target, '/', patchBundle);
        log({
          level: 'success',
          message: `[Migration] Restored related for batch ${batchIndex + 1} (${patchBundle.entry?.length ?? 0} Observations)`,
          resourceType: 'Observation',
          jobId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log({
          level: 'error',
          message: `[Migration] Observation related restore batch ${batchIndex + 1} failed: ${msg}`,
          resourceType: 'Observation',
          jobId,
        });
      }
    }
  }

  checkpoint = checkpointWithObservationRelatedPatched(checkpoint);
  onCheckpoint(checkpoint);
  await saveCheckpoint(checkpoint);
  return checkpoint;
}
