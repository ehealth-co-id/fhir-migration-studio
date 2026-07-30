/**
 * Patient Detector — auto-discovers existing Patient ID mappings between
 * source and target servers by matching NIK (business identifier).
 *
 * Flow:
 *   1. Fetch all Patients from the source server (with optional date filter)
 *   2. For each Patient, extract NIK from both identifier systems:
 *        - system: "KTP"
 *        - system: "https://fhir.kemkes.go.id/id/nik"
 *   3. Search the target server for a Patient with the same NIK
 *   4. Record the mapping: Patient/{sourceId} → Patient/{targetId}
 *
 * The resulting mappings are saved to the Persistent Mapping Store so
 * that subsequent migrations can correctly rewrite Patient references.
 */

import { fhirClient } from './fhirClient';
import { log } from '../store/logStore';
import type { ServerConfig } from '../types/server';
import type { FhirResource } from '../types/fhir';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PATIENT_IDENTIFIER_SYSTEMS = [
  'KTP',
  'https://fhir.kemkes.go.id/id/nik',
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PatientDetectionResult {
  /** Total Patients scanned on source */
  totalScanned: number;
  /** Number of Patients successfully matched on target */
  matched: number;
  /** Number of Patients not found on target */
  notFound: number;
  /** Number that couldn't be searched (e.g., no NIK available) */
  skipped: number;
  /** The built mappings: "Patient/{sourceId}" → "Patient/{targetId}" */
  mappings: Record<string, string>;
}

export interface PatientDetectionOptions {
  source: ServerConfig;
  target: ServerConfig;
  /** Optional date range filter for source patients */
  dateFrom?: string;
  dateTo?: string;
  /** Called after each batch of patients is processed */
  onProgress?: (scanned: number, matched: number) => void;
  /** Returns false to abort */
  shouldContinue?: () => boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract NIK values from a Patient resource's identifier array.
 * Checks both known identifier systems ("KTP" and "https://fhir.kemkes.go.id/id/nik").
 */
function extractNiks(patient: FhirResource): string[] {
  const identifiers = patient.identifier;
  if (!identifiers || identifiers.length === 0) return [];

  const niks: string[] = [];
  for (const id of identifiers) {
    if (
      PATIENT_IDENTIFIER_SYSTEMS.includes(id.system as typeof PATIENT_IDENTIFIER_SYSTEMS[number]) &&
      id.value
    ) {
      niks.push(id.value);
    }
  }
  return niks;
}

/**
 * Search the target server for a Patient with the given NIK.
 * Tries both KTP and NIK identifier systems.
 * Returns the target Patient ID (just the id string) or null if not found.
 */
async function findPatientByNik(
  target: ServerConfig,
  nik: string,
): Promise<string | null> {
  for (const system of PATIENT_IDENTIFIER_SYSTEMS) {
    try {
      const params: Record<string, string | string[]> = {
        identifier: `${system}|${nik}`,
        'active:not': 'false',
      };
      const bundle = await fhirClient.search(target, 'Patient', params);
      const entries = bundle.entry ?? [];
      const patients = entries
        .map((e) => e.resource)
        .filter((r): r is FhirResource => r !== undefined && r.resourceType === 'Patient');

      if (patients.length === 1 && patients[0].id) {
        return patients[0].id;
      }

      // If multiple found, log a warning but take the first
      if (patients.length > 1 && patients[0].id) {
        log({
          level: 'warn',
          message: `Multiple Patients found for NIK ${nik} (system: ${system}), using first match`,
        });
        return patients[0].id;
      }
    } catch {
      // Try next identifier system
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const PAGE_SIZE = 100000;

/**
 * Detect existing Patient ID mappings by matching NIK between source and target.
 *
 * This function:
 *  1. Downloads all Patients from the source (with optional date filter)
 *  2. Extracts NIK from each Patient
 *  3. Queries the target server to find matching Patients by NIK
 *  4. Returns a mapping of Patient/{sourceId} → Patient/{targetId}
 */
export async function detectPatientMappings(
  options: PatientDetectionOptions,
): Promise<PatientDetectionResult> {
  const { source, target, dateFrom, dateTo, onProgress, shouldContinue } = options;

  const result: PatientDetectionResult = {
    totalScanned: 0,
    matched: 0,
    notFound: 0,
    skipped: 0,
    mappings: {},
  };

  log({
    level: 'info',
    message: `[PatientDetector] Starting Patient NIK matching. Source: ${source.baseUrl} → Target: ${target.baseUrl}`,
    detail: dateFrom || dateTo
      ? `Date range: ${dateFrom ?? '…'} to ${dateTo ?? '…'}`
      : 'No date filter — scanning all Patients',
  });

  // Fetch all Patients from source, page by page
  const searchParams: Record<string, string | string[]> = {
    _count: String(PAGE_SIZE),
  };
  const lastUpdated: string[] = [];
  if (dateFrom) lastUpdated.push(`ge${dateFrom}`);
  if (dateTo) lastUpdated.push(`le${dateTo}`);
  if (lastUpdated.length > 0) searchParams['_lastUpdated'] = lastUpdated;

  try {
    let bundle = await fhirClient.search(source, 'Patient', searchParams);

    while (true) {
      if (shouldContinue && !shouldContinue()) break;

      const resources = (bundle.entry ?? [])
        .map((e) => e.resource)
        .filter((r): r is FhirResource => r !== undefined && r.resourceType === 'Patient');

      for (const patient of resources) {
        result.totalScanned++;

        const niks = extractNiks(patient);
        if (niks.length === 0) {
          result.skipped++;
          continue;
        }

        // Try each NIK until we find a match
        let targetId: string | null = null;
        for (const nik of niks) {
          targetId = await findPatientByNik(target, nik);
          if (targetId) break;
        }

        if (targetId && patient.id) {
          result.mappings[`Patient/${patient.id}`] = `Patient/${targetId}`;
          result.matched++;
        } else {
          result.notFound++;
        }
      }

      onProgress?.(result.matched, result.totalScanned);

      // Find next page link
      const nextLink = bundle.link?.find((l) => l.relation === 'next');
      if (!nextLink) break;

      bundle = await fhirClient.nextPage(source, nextLink.url);
    }

    log({
      level: 'success',
      message: `[PatientDetector] Complete: scanned=${result.totalScanned}, matched=${result.matched}, notFound=${result.notFound}, skipped=${result.skipped}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({
      level: 'error',
      message: `[PatientDetector] Failed: ${msg}`,
    });
    throw err;
  }

  return result;
}
