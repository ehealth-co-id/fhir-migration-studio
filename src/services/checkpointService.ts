/**
 * Checkpoint Service — persists migration state to disk using @tauri-apps/plugin-fs.
 *
 * Checkpoint files are written to:
 *   {AppLocalData}/checkpoints/{jobId}.json
 *
 * A checkpoint is saved after every successful bundle upload so that if the app
 * crashes or the server goes down, the migration can be resumed from the last
 * successful point without creating duplicates on the target server.
 *
 * The checkpoint contains (v2 schema):
 *   - All ID mappings (both user-defined and server-assigned)
 *   - Which resource types have been fully completed
 *   - Whether Patient.link.other has been restored
 */

import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
  readDir,
  remove,
} from '@tauri-apps/plugin-fs';
import type { MigrationCheckpoint, CheckpointSummary } from '../types/migration';
import type { FhirResourceType } from '../types/fhir';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHECKPOINT_DIR = 'checkpoints';
const BASE_DIR = BaseDirectory.AppLocalData;
const CURRENT_VERSION = 2;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function ensureDir(): Promise<void> {
  const dirExists = await exists(CHECKPOINT_DIR, { baseDir: BASE_DIR });
  if (!dirExists) {
    await mkdir(CHECKPOINT_DIR, { baseDir: BASE_DIR, recursive: true });
  }
}

function filename(jobId: string): string {
  return `${CHECKPOINT_DIR}/${jobId}.json`;
}

// ---------------------------------------------------------------------------
// Public API — persistence
// ---------------------------------------------------------------------------

/**
 * Save (create or overwrite) a checkpoint to disk.
 * Non-fatal — migration continues even if checkpoint write fails.
 */
export async function saveCheckpoint(checkpoint: MigrationCheckpoint): Promise<void> {
  try {
    await ensureDir();
    const json = JSON.stringify(checkpoint, null, 2);
    await writeTextFile(filename(checkpoint.jobId), json, { baseDir: BASE_DIR });
  } catch (err) {
    console.warn('[CheckpointService] Failed to save checkpoint:', err);
  }
}

/**
 * Load a checkpoint from disk by job ID.
 * Returns null if the file does not exist, cannot be parsed, or is an
 * incompatible version (v1 checkpoints are not usable with the v2 pipeline).
 */
export async function loadCheckpoint(jobId: string): Promise<MigrationCheckpoint | null> {
  try {
    const fileExists = await exists(filename(jobId), { baseDir: BASE_DIR });
    if (!fileExists) return null;

    const json = await readTextFile(filename(jobId), { baseDir: BASE_DIR });
    const parsed = JSON.parse(json) as MigrationCheckpoint;

    if (parsed.version !== CURRENT_VERSION) {
      console.warn(
        `[CheckpointService] Checkpoint ${jobId} uses schema v${parsed.version}, ` +
        `but v${CURRENT_VERSION} is required. Cannot resume — checkpoint is incompatible.`,
      );
      return null;
    }

    return parsed;
  } catch (err) {
    console.warn('[CheckpointService] Failed to load checkpoint:', err);
    return null;
  }
}

/**
 * List all checkpoints that are NOT yet fully done (have remaining resource types to process).
 * Used by the UI to show "Resume Migration" options.
 */
export async function listIncompleteCheckpoints(): Promise<CheckpointSummary[]> {
  try {
    await ensureDir();
    const entries = await readDir(CHECKPOINT_DIR, { baseDir: BASE_DIR });
    const summaries: CheckpointSummary[] = [];

    for (const entry of entries) {
      if (!entry.name?.endsWith('.json')) continue;

      try {
        const json = await readTextFile(`${CHECKPOINT_DIR}/${entry.name}`, { baseDir: BASE_DIR });
        const cp = JSON.parse(json) as MigrationCheckpoint;

        // Only show compatible v2 checkpoints that are not done
        if (cp.version !== CURRENT_VERSION) continue;
        if ((cp as MigrationCheckpoint & { done?: boolean }).done) continue;

        summaries.push({
          jobId: cp.jobId,
          startedAt: cp.startedAt,
          sourceUrl: cp.sourceUrl,
          targetUrl: cp.targetUrl,
          completedResourceTypes: cp.completedResourceTypes,
          totalMappings: Object.keys(cp.idMappings).length,
          dateFrom: cp.dateFrom,
          dateTo: cp.dateTo,
          migrationName: cp.migrationName,
        });
      } catch {
        // Skip corrupted files
      }
    }

    // Sort newest first
    return summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  } catch {
    return [];
  }
}

/**
 * Delete a checkpoint file from disk.
 * Called when migration completes successfully.
 */
export async function deleteCheckpoint(jobId: string): Promise<void> {
  try {
    const fileExists = await exists(filename(jobId), { baseDir: BASE_DIR });
    if (fileExists) {
      await remove(filename(jobId), { baseDir: BASE_DIR });
    }
  } catch (err) {
    console.warn('[CheckpointService] Failed to delete checkpoint:', err);
  }
}

// ---------------------------------------------------------------------------
// Checkpoint mutation helpers (pure functions — return new checkpoint object)
// ---------------------------------------------------------------------------

/** Create a fresh v2 checkpoint for a new migration job. */
export function createCheckpoint(
  jobId: string,
  sourceUrl: string,
  targetUrl: string,
  selectedResourceTypes: FhirResourceType[],
  userDefinedMappings: Record<string, string> = {},
  dateFrom?: string,
  dateTo?: string,
  migrationName?: string,
): MigrationCheckpoint {
  return {
    version: 2,
    jobId,
    startedAt: new Date().toISOString(),
    sourceUrl,
    targetUrl,
    selectedResourceTypes,
    completedResourceTypes: [],
    patientLinkPatched: false,
    compositionRelatesToPatched: false,
    idMappings: { ...userDefinedMappings },
    dateFrom,
    dateTo,
    migrationName,
  };
}

/** Add new server-assigned ID mappings to the checkpoint and return updated copy. */
export function checkpointWithMappings(
  checkpoint: MigrationCheckpoint,
  newMappings: Record<string, string>,
): MigrationCheckpoint {
  return {
    ...checkpoint,
    idMappings: { ...checkpoint.idMappings, ...newMappings },
  };
}

/** Mark a resource type as fully completed (all bundles uploaded). */
export function checkpointWithCompletedType(
  checkpoint: MigrationCheckpoint,
  resourceType: FhirResourceType,
): MigrationCheckpoint {
  if (checkpoint.completedResourceTypes.includes(resourceType)) return checkpoint;
  return {
    ...checkpoint,
    completedResourceTypes: [...checkpoint.completedResourceTypes, resourceType],
  };
}

/** Mark the Patient.link.other restore step as completed. */
export function checkpointWithPatientLinkPatched(checkpoint: MigrationCheckpoint): MigrationCheckpoint {
  return { ...checkpoint, patientLinkPatched: true };
}

/** Mark the Composition.relatesTo restore step as completed. */
export function checkpointWithCompositionRelatesToPatched(checkpoint: MigrationCheckpoint): MigrationCheckpoint {
  return { ...checkpoint, compositionRelatesToPatched: true };
}

/** Mark the migration as fully done (used before deletion). */
export function checkpointAsDone(checkpoint: MigrationCheckpoint): MigrationCheckpoint {
  return { ...checkpoint, done: true } as MigrationCheckpoint & { done: boolean };
}

// ---------------------------------------------------------------------------
// Resume helpers
// ---------------------------------------------------------------------------

/** True if a resource type has already been fully completed in this checkpoint. */
export function isResourceTypeComplete(cp: MigrationCheckpoint, resourceType: FhirResourceType): boolean {
  return cp.completedResourceTypes.includes(resourceType);
}
