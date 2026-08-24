/**
 * Uploader — POSTs Transaction Bundles to the target server.
 * Includes retry logic with exponential backoff.
 *
 * HAPI-0389 safety net:
 * If a transaction bundle fails with a BinaryStorageEntity EntityExistsException
 * (two entries sharing identical inline binary content in one transaction — see
 * docs/FHIR_RULES.md §Inline Binary Content), the bundle is automatically retried
 * as single-entry transactions so no resource is lost from the migration.
 */

import { fhirClient, FhirClientError } from './fhirClient';
import { log } from '../store/logStore';
import type { ServerConfig } from '../types/server';
import type { Bundle, BundleEntry } from '../types/fhir';
import type { FhirResourceType } from '../types/fhir';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export interface UploadResult {
  success: number;
  failed: number;
  total: number;
  errors: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect a HAPI-0389 BinaryStorageEntity EntityExistsException in an error.
 */
export function isBinaryStorageCollisionError(err: unknown): boolean {
  if (!(err instanceof FhirClientError)) return false;
  return (err.body ?? '').includes('BinaryStorageEntity');
}

// ---------------------------------------------------------------------------
// Binary-unsafe servers (HAPI <= 6.x deferred-blob defect)
// ---------------------------------------------------------------------------
//
// On older HAPI JPA servers (verified against 6.4.4), BinaryStorageInterceptor
// keeps deferred blob targets in TransactionDetails-scoped state and re-stores
// EVERY previously deferred blob once per additional resource committed in the
// same transaction (DatabaseBlobBinaryStorageSvcImpl.storeBlob uses persist()).
// Result: any transaction containing >= 2 resources with inline binary data
// fails with HAPI-0389 EntityExistsException — regardless of whether the
// contents are identical.
//
// Single-entry transactions are always safe: the deferred list then holds at
// most one entry, which is stored exactly once.
//
// Once a server exhibits the defect we remember it (per base URL, for the app
// session) and send all further bundles as single-entry transactions without
// another failing round-trip.

const binaryUnsafeServers = new Set<string>();

function serverKey(config: ServerConfig): string {
  return config.baseUrl.trim().toLowerCase();
}

/** Mark a target server as exhibiting the HAPI-0389 multi-binary defect. */
export function markServerBinaryUnsafe(config: ServerConfig): void {
  binaryUnsafeServers.add(serverKey(config));
}

/** Whether this target server is known to fail multi-binary transactions. */
export function isServerBinaryUnsafe(config: ServerConfig): boolean {
  return binaryUnsafeServers.has(serverKey(config));
}

/**
 * Count how many entries in a bundle carry inline binary data (a non-empty
 * `data` field anywhere in the resource). Single-entry fallback is only needed
 * when a transaction would contain >= 2 such entries — the HAPI 6.x defect
 * triggers on ANY transaction with two or more binary-bearing resources, but
 * bundles with 0 or 1 binary entry are safe to send as a normal batch.
 */
function countBinaryEntries(bundle: Bundle): number {
  let count = 0;
  const walk = (node: unknown): boolean => {
    if (node === null || node === undefined) return false;
    if (Array.isArray(node)) {
      for (const item of node) if (walk(item)) return true;
      return false;
    }
    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'data' && typeof value === 'string' && value.length > 0) {
          return true;
        }
        if (walk(value)) return true;
      }
      return false;
    }
    return false;
  };

  for (const entry of bundle.entry ?? []) {
    if (walk(entry.resource)) count++;
  }
  return count;
}

/**
 * Extract a "ResourceType/id" location from an error response body.
 *
 * When a transaction fails partway, HAPI reports entries it already processed
 * as per-entry OperationOutcomes that still carry the assigned location
 * (e.g. "location": "Patient/123/_history/1"). The per-entry fallback uses
 * this to recover the real destination IDs so old→new ID mappings stay
 * correct even when individual requests come back as errors.
 */
function extractLocationFromBody(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { location?: unknown };
    const loc = parsed.location;
    if (typeof loc === 'string' && /[A-Z][a-zA-Z]+\/[^/\s]+/.test(loc)) {
      return loc;
    }
  } catch {
    // Body is not JSON — nothing to recover.
  }
  return undefined;
}

/**
 * Upload each entry of a bundle as its own single-entry transaction.
 *
 * Returns a synthetic transaction-response Bundle whose entry[] positions match
 * the input order, so positional response handling keeps working. Entries that
 * fail individually are reported with their error status — unless HAPI exposed
 * the created resource's location in the error body, in which case a success
 * status with the REAL location is emitted so mappings can be registered.
 *
 * Retries up to MAX_RETRIES times on transient errors (5xx).
 */
async function uploadEntriesIndividually(
  config: ServerConfig,
  bundle: Bundle,
): Promise<Bundle> {
  const entries = bundle.entry ?? [];
  const responseEntries: BundleEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const single: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [entry],
    };
    try {
      // A single-entry transaction response carries the real destination
      // location in entry[0].response.location. Surface it so the caller
      // registers the old→new ID mapping — without this, references to this
      // resource stay as raw source IDs and the target rejects them with
      // HAPI-1094 "not found".
      const resp = await uploadSingleBundle(config, single);
      const location = resp.entry?.[0]?.response?.location;
      responseEntries.push({
        fullUrl: entry.fullUrl,
        response: location
          ? { status: '201 Created', location }
          : { status: '201 Created' },
      });
    } catch (err) {
      // HAPI often includes the assigned location in the per-entry outcome of
      // a failed request — the resource itself WAS created. Surface it so the
      // caller registers the real old→new ID mapping instead of losing it.
      const location =
        err instanceof FhirClientError ? extractLocationFromBody(err.body) : undefined;
      if (location) {
        responseEntries.push({
          fullUrl: entry.fullUrl,
          response: { status: '201 Created', location },
        });
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      log({
        level: 'error',
        message: `Single-resource retry ${i + 1}/${entries.length} failed: ${msg}`,
      });
      responseEntries.push({
        fullUrl: entry.fullUrl,
        response: { status: '500 Error' },
      });
    }
  }

  return { resourceType: 'Bundle', type: 'transaction-response', entry: responseEntries };
}

/**
 * Upload a single Transaction Bundle to the target server.
 * Returns the raw response Bundle (transaction-response type).
 * Retries up to MAX_RETRIES times on transient errors (5xx).
 */
export async function uploadSingleBundle(
  config: ServerConfig,
  bundle: Bundle,
  attempt = 1,
): Promise<Bundle> {
  try {
    return await fhirClient.post<Bundle>(config, '/', bundle);
  } catch (err) {
    const isRetryable =
      err instanceof FhirClientError &&
      err.status !== undefined &&
      err.status >= 500;

    if (isRetryable && attempt < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      log({ level: 'warn', message: `Upload failed (attempt ${attempt}), retrying in ${delay}ms...` });
      await sleep(delay);
      return uploadSingleBundle(config, bundle, attempt + 1);
    }

    throw err;
  }
}

/**
 * Upload a bundle, falling back to per-entry transactions when the target
 * server rejects multi-resource bundles with a BinaryStorageEntity collision
 * (HAPI-0389 — see the binary-unsafe servers note above).
 *
 * The HAPI 6.x deferred-blob defect only affects bundles containing >= 2
 * entries with inline binary data. Bundles with 0 or 1 such entry are safe to
 * send as a normal batch, so even on a binary-unsafe server we only fall back
 * to single-entry when the bundle actually needs it (avoids needlessly
 * slowing down pure/near-pure non-binary types like Appointment, Condition...).
 */
export async function uploadSingleBundleWithFallback(
  config: ServerConfig,
  bundle: Bundle,
): Promise<Bundle> {
  const binaryCount = countBinaryEntries(bundle);
  if (isServerBinaryUnsafe(config) && binaryCount >= 2) {
    return uploadEntriesIndividually(config, bundle);
  }
  try {
    return await uploadSingleBundle(config, bundle);
  } catch (err) {
    if (!isBinaryStorageCollisionError(err)) throw err;
    markServerBinaryUnsafe(config);
    const size = bundle.entry?.length ?? 0;
    log({
      level: 'warn',
      message: `HAPI-0389 detected on ${config.baseUrl} — this server fails transactions with multiple inline binaries (old HAPI deferred-blob defect). Retrying ${size} resource(s) individually; subsequent bundles with >=2 inline binaries will be sent single-entry.`,
    });
    return uploadEntriesIndividually(config, bundle);
  }
}

/**
 * Count successes and failures from a transaction-response Bundle.
 */
function parseResponse(responseBundle: Bundle): { success: number; failed: number; errors: string[] } {
  const entries = responseBundle.entry ?? [];
  let success = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const entry of entries) {
    const status = entry.response?.status ?? '';
    const code = parseInt(status.split(' ')[0], 10);
    if (code >= 200 && code < 300) {
      success++;
    } else {
      failed++;
      errors.push(`Entry ${entry.fullUrl ?? '?'}: ${status}`);
    }
  }

  return { success, failed, errors };
}

/**
 * Upload multiple bundles sequentially, reporting progress per bundle.
 */
export async function uploadBundles(
  config: ServerConfig,
  bundles: Bundle[],
  resourceType: FhirResourceType,
  onProgress: (result: UploadResult) => void,
  shouldContinue?: () => boolean,
): Promise<UploadResult> {
  const aggregate: UploadResult = { success: 0, failed: 0, total: 0, errors: [] };

  for (let i = 0; i < bundles.length; i++) {
    if (shouldContinue && !shouldContinue()) {
      log({ level: 'warn', message: `Upload aborted: ${resourceType}`, resourceType });
      break;
    }
    const bundle = bundles[i];
    const bundleSize = bundle.entry?.length ?? 0;
    aggregate.total += bundleSize;

    try {
      log({
        level: 'info',
        message: `Uploading ${resourceType} bundle ${i + 1}/${bundles.length} (${bundleSize} resources)`,
        resourceType,
      });

      const responseBundle = await uploadSingleBundleWithFallback(config, bundle);
      const { success, failed, errors } = parseResponse(responseBundle);

      aggregate.success += success;
      aggregate.failed += failed;
      aggregate.errors.push(...errors);

      log({
        level: failed > 0 ? 'warn' : 'success',
        message: `Bundle ${i + 1}/${bundles.length}: ${success} ok, ${failed} failed`,
        resourceType,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      aggregate.failed += bundleSize;
      aggregate.errors.push(`Bundle ${i + 1}: ${msg}`);

      log({
        level: 'error',
        message: `Bundle ${i + 1}/${bundles.length} upload failed: ${msg}`,
        resourceType,
      });
    }

    onProgress({ ...aggregate });
  }

  return aggregate;
}
