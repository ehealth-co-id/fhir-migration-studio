/**
 * Migration Orchestrator — coordinates the full dependency-driven migration pipeline.
 *
 * Two entry points:
 *
 *   runDirectMigration   — starts a brand new migration, creates a fresh checkpoint
 *   resumeDirectMigration — resumes from an existing checkpoint file on disk
 *
 * Pipeline (per docs/FHIR_RULES.md §New Migration Strategy):
 *   Each resource type is migrated completely (all bundles) before moving to the next.
 *   Resource types are processed in DEPENDENCY_ORDER.
 *   Each Transaction Bundle contains only resources of a single resource type.
 *   Bundle size is configurable (default: DEFAULT_BUNDLE_SIZE = 100).
 *
 * Special handling:
 *   Patient.link.other is handled in two stages:
 *     Stage 1 — upload all Patients without link.other
 *     Stage 2 — PUT to restore link.other after all Patient IDs are known
 *
 * On success the checkpoint file is deleted.
 * On error/cancellation the checkpoint file is kept for future resume.
 *
 * See docs/FHIR_RULES.md for the full specification.
 */

import { scanResourceCounts } from './scanner';
import { ResourceMappingService } from './resourceMappingService';
import { runDependencyMigration, DEFAULT_BUNDLE_SIZE } from './dependencyMigrator';
import { loadPersistentMappings, savePersistentMappings } from './persistentMappingStore';
import {
  createCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  deleteCheckpoint,
  checkpointAsDone,
} from './checkpointService';
import { log } from '../store/logStore';
import { useMigrationStore } from '../store/migrationStore';
import type { ServerConfig } from '../types/server';
import type { FhirResourceType } from '../types/fhir';
import type { MappingRule } from '../types/mapping';
import type { MigrationCheckpoint } from '../types/migration';
import { createDefaultJob } from '../types/migration';
import { MIGRATABLE_RESOURCE_TYPES } from '../types/fhir';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Resource types that already exist on the target server and are referenced
 * but NOT migrated. Their IDs are rewritten via user-defined MappingRules.
 */
const MANUALLY_MAPPED_TYPES = new Set<string>([
  'Practitioner',
  'Location',
  'HealthcareService',
  'Organization',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MigrationOptions {
  source: ServerConfig;
  target: ServerConfig;
  /**
   * Resource types selected by the user. Only these types will be downloaded
   * and migrated. Types not in this list are ignored entirely.
   * Defaults to all MIGRATABLE_RESOURCE_TYPES.
   */
  resourceTypes?: FhirResourceType[];
  /** User-defined reference mapping rules (Practitioner, Location, HealthcareService, Organization) */
  mappingRules: MappingRule[];
  /**
   * Maximum number of resources per Transaction Bundle.
   * Defaults to DEFAULT_BUNDLE_SIZE (100).
   */
  bundleSize?: number;
  /** Optional start date for _lastUpdated range (inclusive, ISO date string). */
  dateFrom?: string;
  /** Optional end date for _lastUpdated range (inclusive, ISO date string). */
  dateTo?: string;
  /**
   * User-provided migration name used to persist ID mappings across runs.
   * When provided, mappings are loaded from and saved to the persistent
   * mapping store under this name.
   */
  migrationName?: string;
}

/**
 * Start a brand-new direct server-to-server migration.
 * Creates a fresh checkpoint file at the start.
 * Updates the Zustand migration store throughout so the UI stays in sync.
 */
export async function runDirectMigration(options: MigrationOptions): Promise<void> {
  const {
    source,
    target,
    resourceTypes = MIGRATABLE_RESOURCE_TYPES,
    mappingRules,
    bundleSize = DEFAULT_BUNDLE_SIZE,
    dateFrom,
    dateTo,
    migrationName,
  } = options;

  const store = useMigrationStore.getState();
  const job = createDefaultJob('direct', resourceTypes);
  job.startedAt = new Date().toISOString();
  store.setJob(job);

  log({ level: 'info', message: `Migration ${job.id} started (new)`, jobId: job.id });

  // Build user-defined mappings record (Practitioner/Location/HealthcareService/Organization)
  const userDefinedMappings: Record<string, string> = {};
  for (const rule of mappingRules) {
    userDefinedMappings[`${rule.resourceType}/${rule.sourceId}`] =
      `${rule.resourceType}/${rule.targetId}`;
  }

  // Create fresh checkpoint including user-defined mappings
  const initialCheckpoint = createCheckpoint(
    job.id,
    source.baseUrl,
    target.baseUrl,
    resourceTypes,
    userDefinedMappings,
    dateFrom,
    dateTo,
    migrationName,
  );
  await saveCheckpoint(initialCheckpoint);

  await _runMigration({
    job,
    source,
    target,
    selectedResourceTypes: resourceTypes,
    bundleSize,
    checkpoint: initialCheckpoint,
    dateFrom,
    dateTo,
    migrationName,
  });
}

/**
 * Resume a migration from an existing checkpoint.
 * Restores all ID mappings from disk — no need to re-define mapping rules
 * (they were included in the checkpoint when the migration was first started).
 */
export async function resumeDirectMigration(
  jobId: string,
  serverOverrides: { source: ServerConfig; target: ServerConfig },
): Promise<void> {
  const checkpoint = await loadCheckpoint(jobId);
  if (!checkpoint) {
    throw new Error(
      `No compatible checkpoint found for job ID: ${jobId}. ` +
      `This may be a v1 checkpoint that is not compatible with the current pipeline.`,
    );
  }

  const { source, target } = serverOverrides;
  const selectedResourceTypes = checkpoint.selectedResourceTypes ?? MIGRATABLE_RESOURCE_TYPES;

  const store = useMigrationStore.getState();
  const job = createDefaultJob('direct', selectedResourceTypes);
  // Preserve original start time for display
  job.id = jobId;
  job.startedAt = checkpoint.startedAt;
  store.setJob(job);

  log({ level: 'info', message: `Migration ${jobId} resuming from checkpoint`, jobId });
  log({
    level: 'info',
    message: `Checkpoint: completed [${checkpoint.completedResourceTypes.join(', ')}] | ${Object.keys(checkpoint.idMappings).length} mappings`,
    jobId,
  });

  // No mappingRules needed — they're already baked into checkpoint.idMappings
  await _runMigration({
    job,
    source,
    target,
    selectedResourceTypes,
    bundleSize: DEFAULT_BUNDLE_SIZE,
    checkpoint,
    dateFrom: checkpoint.dateFrom,
    dateTo: checkpoint.dateTo,
    migrationName: checkpoint.migrationName,
  });
}

// ---------------------------------------------------------------------------
// Internal — shared migration runner
// ---------------------------------------------------------------------------

interface RunMigrationArgs {
  job: ReturnType<typeof createDefaultJob>;
  source: ServerConfig;
  target: ServerConfig;
  selectedResourceTypes: FhirResourceType[];
  bundleSize: number;
  checkpoint: MigrationCheckpoint;
  dateFrom?: string;
  dateTo?: string;
  migrationName?: string;
}

async function _runMigration(args: RunMigrationArgs): Promise<void> {
  const { job, source, target, selectedResourceTypes, bundleSize, checkpoint: initialCheckpoint, dateFrom, dateTo, migrationName } = args;
  const store = useMigrationStore.getState();

  // Mutable checkpoint — updated and saved after every successful batch
  let checkpoint = initialCheckpoint;
  const onCheckpoint = (updated: MigrationCheckpoint) => { checkpoint = updated; };

  // Declared here so it's accessible in both try and catch blocks
  const mappingService = new ResourceMappingService();

  try {
    // Initialize progress entries for all selected resource types
    for (const rt of selectedResourceTypes) {
      useMigrationStore.getState().updateResourceProgress(rt, {
        total: 0, downloaded: 0, uploaded: 0, failed: 0, skipped: 0,
      });
    }

    // -------------------------------------------------------------------------
    // Pause/cancel check helper
    // -------------------------------------------------------------------------
    const checkStatus = async (): Promise<boolean> => {
      let status = useMigrationStore.getState().current?.status;
      if (status === 'cancelled') return false;
      if (status === 'paused') {
        await waitForResume();
        status = useMigrationStore.getState().current?.status;
        if (status === 'cancelled') return false;
      }
      return true;
    };

    // -------------------------------------------------------------------------
    // Scan — count resources per type (UI feedback only)
    // Only count selected resource types; skip unselected entirely
    // -------------------------------------------------------------------------
    store.updateStatus('scanning');
    log({ level: 'info', message: 'Scanning source server...', jobId: job.id });

    await scanResourceCounts(
      source,
      selectedResourceTypes,
      (rt, count) => {
        useMigrationStore.getState().updateResourceProgress(rt, { total: count });
      },
      checkStatus,
      dateFrom,
      dateTo,
    );

    if (!(await checkStatus())) {
      log({ level: 'warn', message: `Migration ${job.id} cancelled during scanning`, jobId: job.id });
      return;
    }

    // -------------------------------------------------------------------------
    // Restore ResourceMappingService from checkpoint
    // -------------------------------------------------------------------------
    for (const [oldRef, newRef] of Object.entries(checkpoint.idMappings)) {
      mappingService.set(oldRef, newRef);
    }

    // -------------------------------------------------------------------------
    // Load persistent mappings from previous migrations for this name
    // -------------------------------------------------------------------------
    if (migrationName) {
      const persistentMappings = await loadPersistentMappings(migrationName);
      let persistentMappingsLoaded = 0;
      for (const [oldRef, newRef] of Object.entries(persistentMappings)) {
        if (!mappingService.has(oldRef)) {
          mappingService.set(oldRef, newRef);
          persistentMappingsLoaded++;
        }
      }

      if (persistentMappingsLoaded > 0) {
        log({
          level: 'info',
          message: `Loaded ${persistentMappingsLoaded} persistent mappings from "${migrationName}" (${Object.keys(persistentMappings).length} total available, ${Object.keys(checkpoint.idMappings).length} already in checkpoint)`,
          jobId: job.id,
        });
      }
    }

    log({
      level: 'info',
      message: `Restored ${mappingService.size} ID mappings from checkpoint + persistent store`,
      jobId: job.id,
    });

    // -------------------------------------------------------------------------
    // Run the dependency-driven migration pipeline
    // -------------------------------------------------------------------------
    store.updateStatus('uploading');
    log({
      level: 'info',
      message: `[Migration] Starting dependency-driven pipeline (bundle size: ${bundleSize})`,
      jobId: job.id,
    });

    checkpoint = await runDependencyMigration(
      { source, target, bundleSize, jobId: job.id, selectedResourceTypes, dateFrom, dateTo, migrationName },
      mappingService,
      checkpoint,
      onCheckpoint,
      checkStatus,
    );

    if (!(await checkStatus())) {
      log({ level: 'warn', message: `Migration ${job.id} cancelled`, jobId: job.id });
      return;
    }

    log({
      level: 'success',
      message: `[Migration] Pipeline complete. ${mappingService.size} total ID mappings.`,
      jobId: job.id,
    });

    // -------------------------------------------------------------------------
    // Complete the job FIRST — the report page depends only on this.
    // Persistent-store saves and checkpoint cleanup below are best-effort and
    // must NEVER be able to block or prevent the job from being marked done.
    // -------------------------------------------------------------------------
    store.updateStatus('validating');
    await new Promise((r) => setTimeout(r, 500));

    store.completeJob();
    log({ level: 'success', message: `Migration ${job.id} completed`, jobId: job.id });

    // Best-effort: persist all mappings for future runs (wrapped — non-fatal)
    if (migrationName) {
      try {
        const allMappings: Record<string, string> = {};
        for (const [key, value] of mappingService.getMap()) {
          allMappings[key] = value;
        }
        await savePersistentMappings(migrationName, source.baseUrl, target.baseUrl, allMappings);
        log({
          level: 'info',
          message: `Saved ${Object.keys(allMappings).length} mappings to persistent store "${migrationName}"`,
          jobId: job.id,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log({
          level: 'warn',
          message: `Could not save mappings to persistent store: ${msg}`,
          jobId: job.id,
        });
      }
    }

    // Best-effort: write the 'done' marker then clean up the checkpoint file
    try {
      checkpoint = checkpointAsDone(checkpoint);
      await saveCheckpoint(checkpoint);  // write 'done' state first
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log({
        level: 'warn',
        message: `Could not write done marker to checkpoint: ${msg} (migration data is unaffected)`,
        jobId: job.id,
      });
    }

    // Delete last — even if this hangs or fails, the job is already done.
    try {
      await deleteCheckpoint(job.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log({
        level: 'warn',
        message: `Could not delete checkpoint: ${msg} (leftover file is harmless)`,
        jobId: job.id,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    store.setError(msg);
    // Checkpoint is intentionally NOT deleted on error — kept for resume
    // Also save whatever mappings we have to persistent store so partial progress isn't lost
    if (migrationName) {
      try {
        const allMappings: Record<string, string> = {};
        for (const [key, value] of mappingService.getMap()) {
          allMappings[key] = value;
        }
        await savePersistentMappings(migrationName, source.baseUrl, target.baseUrl, allMappings);
      } catch {
        // Non-fatal — persistent store save failure should not affect the migration
      }
    }
    log({
      level: 'error',
      message: `Migration ${job.id} failed: ${msg} (checkpoint preserved for resume)`,
      jobId: job.id,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForResume(): Promise<void> {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      const status = useMigrationStore.getState().current?.status;
      if (status !== 'paused') {
        clearInterval(interval);
        resolve();
      }
    }, 500);
  });
}

export { MANUALLY_MAPPED_TYPES };
export type { MigrationOptions as DirectMigrationOptions };
