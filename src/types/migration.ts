/**
 * Migration job and progress types.
 */

import type { FhirResourceType } from './fhir';

export type MigrationStatus =
  | 'idle'
  | 'scanning'
  | 'downloading'
  | 'mapping'
  | 'uploading'
  | 'patching'     // Restoring Patient.link.other after all Patients are created
  | 'validating'
  | 'done'
  | 'error'
  | 'paused'
  | 'cancelled';

export type MigrationMode = 'direct' | 'export' | 'import';

export interface ResourceProgress {
  total: number;
  downloaded: number;
  uploaded: number;
  failed: number;
  skipped: number;
}

export interface MigrationJob {
  id: string;
  mode: MigrationMode;
  status: MigrationStatus;
  resourceTypes: FhirResourceType[];
  progress: Partial<Record<FhirResourceType, ResourceProgress>>;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  /** Running counters across all resource types */
  totals: {
    total: number;
    downloaded: number;
    uploaded: number;
    failed: number;
    skipped: number;
  };
}

export interface MigrationReport {
  jobId: string;
  mode: MigrationMode;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  resourceTypes: FhirResourceType[];
  summary: Partial<Record<FhirResourceType, ResourceProgress>>;
  totals: MigrationJob['totals'];
  status: MigrationStatus;
  error?: string;
}

/**
 * Checkpoint persisted to disk after each successful bundle upload.
 * Used to resume a migration after an app crash or server disconnection.
 *
 * File location: {AppLocalData}/checkpoints/{jobId}.json
 *
 * v2 — Replaces the old phase1/phase1b/phase2 structure with a flat
 *       per-resource-type tracking model that matches the new dependency-driven
 *       migration pipeline. v1 checkpoints are NOT compatible.
 */
export interface MigrationCheckpoint {
  /** Schema version — bump if the shape changes incompatibly */
  version: 2;
  jobId: string;
  startedAt: string;
  /** Base URL of the source FHIR server (for display purposes on resume) */
  sourceUrl: string;
  /** Base URL of the target FHIR server (for display purposes on resume) */
  targetUrl: string;
  /**
   * Resource types that have been fully uploaded (all batches successful).
   * Used to skip already-completed types when resuming.
   */
  completedResourceTypes: FhirResourceType[];
  /**
   * The list of resource types selected for migration by the user.
   */
  selectedResourceTypes?: FhirResourceType[];
  /**
   * True once the Patient.link.other restore step (PUT) has completed.
   */
  patientLinkPatched: boolean;
  /**
   * True once the Composition.relatesTo restore step (PUT) has completed.
   */
  compositionRelatesToPatched: boolean;
  /**
   * True once the Observation.related restore step (PUT) has completed.
   */
  observationRelatedPatched: boolean;
  /**
   * All known ID mappings — both user-defined (Practitioner/Location/
   * HealthcareService/Organization) and server-assigned (Patient/Coverage/…).
   * Format: { "Patient/100": "Patient/987", "HealthcareService/6301787": "HealthcareService/105" }
   */
  idMappings: Record<string, string>;
  /** Optional start date for _lastUpdated range (inclusive, ISO date string). */
  dateFrom?: string;
  /** Optional end date for _lastUpdated range (inclusive, ISO date string). */
  dateTo?: string;
  /** User-provided migration name for persistent mapping store lookups. */
  migrationName?: string;
}

/** Summary shown in the UI "Resume Migration" list */
export interface CheckpointSummary {
  jobId: string;
  startedAt: string;
  sourceUrl: string;
  targetUrl: string;
  completedResourceTypes: FhirResourceType[];
  totalMappings: number;
  dateFrom?: string;
  dateTo?: string;
  migrationName?: string;
}


export function createDefaultJob(
  mode: MigrationMode,
  resourceTypes: FhirResourceType[],
): MigrationJob {
  return {
    id: `MIG-${Date.now()}`,
    mode,
    status: 'idle',
    resourceTypes,
    progress: {},
    totals: { total: 0, downloaded: 0, uploaded: 0, failed: 0, skipped: 0 },
  };
}

/** Compute overall percentage 0–100 */
export function computeOverallProgress(job: MigrationJob): number {
  const { total, uploaded, failed, skipped } = job.totals;
  if (total === 0) return 0;
  return Math.round(((uploaded + failed + skipped) / total) * 100);
}
