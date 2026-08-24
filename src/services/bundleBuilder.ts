/**
 * Bundle Builder — builds FHIR DSTU3 Transaction Bundles.
 *
 * Two exported builders:
 *
 * 1. buildTransactionBundle / buildTransactionBundles  (NDJSON import path)
 *    Simple batch builder — each resource gets a random urn:uuid, no cross-reference
 *    rewriting. Suitable for NDJSON import where refs are already resolved.
 *
 * 2. buildResourceTypeBundle  (Dependency Migration Pipeline)
 *    Builds a Transaction Bundle for a batch of resources of a SINGLE resource type.
 *    References have already been rewritten by the caller (via referenceRewriter +
 *    ResourceMappingService) before this function is called.
 *    Returns the ordered list of original refs alongside the bundle so the caller can
 *    register the server-assigned IDs in ResourceMappingService.
 *
 * Per docs/FHIR_RULES.md §Transaction Bundles:
 *   Each bundle should only contain resources of a single resource type.
 *   Bundle size is configurable (default 100).
 */

import type { Bundle, BundleEntry, FhirResource } from '../types/fhir';
import { useSettingsStore } from '../store/settingsStore';

// ---------------------------------------------------------------------------
// Constants / Settings
// ---------------------------------------------------------------------------

/**
 * @deprecated Use useSettingsStore to get dynamic bundle limits.
 */
export const MAX_REQUEST_SIZE_BYTES = 3 * 1024 * 1024;

/**
 * @deprecated Use useSettingsStore to get dynamic bundle limits.
 */
export const MAX_BUNDLE_RESOURCE_COUNT = 100;

const encoder = new TextEncoder();

/**
 * Calculate the serialized size of a FHIR Bundle in bytes.
 */
export function calculateSerializedSize(bundle: Bundle): number {
  return encoder.encode(JSON.stringify(bundle)).length;
}

/**
 * Extension stamped onto every resource sent to the target server.
 * Allows easy identification of migrated resources in the future.
 */
const MIGRATION_MARKER: { url: string; valueString: string } = {
  url: 'https://ehealth.co.id/terminology/initiator-component',
  valueString: 'fhir-migration-tool',
};

/**
 * Generate a new urn:uuid identifier.
 * Exported so callers can pre-generate uuid maps.
 */
export function generateUrn(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `urn:uuid:${crypto.randomUUID()}`;
  }
  // Fallback — not cryptographically secure but fine for IDs
  const hex = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return `urn:uuid:${hex()}-${hex().slice(0, 4)}-4${hex().slice(0, 3)}-${hex().slice(0, 4)}-${hex()}${hex().slice(0, 4)}`;
}

/**
 * Strip server-assigned meta fields (versionId, lastUpdated), keep everything
 * else (extension, profile, tag), and inject the migration marker extension.
 * Always returns a Meta object — never undefined.
 */
function cleanMeta(meta: FhirResource['meta']): FhirResource['meta'] {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { versionId: _v, lastUpdated: _l, ...rest } = (meta ?? {}) as NonNullable<FhirResource['meta']>;
  return {
    ...rest,
    extension: [...(rest.extension ?? []), MIGRATION_MARKER],
  } as FhirResource['meta'];
}

/**
 * Builds a single FHIR Transaction Bundle from a list of resources.
 * Each resource gets a new random urn:uuid fullUrl and a POST request entry.
 * No internal cross-reference rewriting is performed.
 */
export function buildTransactionBundle(resources: FhirResource[]): Bundle {
  const entries: BundleEntry[] = resources.map((resource) => {
    const { id: _id, meta, ...rest } = resource;
    void _id;

    return {
      fullUrl: generateUrn(),
      resource: { ...rest, meta: cleanMeta(meta) } as FhirResource,
      request: { method: 'POST', url: resource.resourceType },
    };
  });

  return { resourceType: 'Bundle', type: 'transaction', entry: entries };
}

export interface PreparedEntry {
  entry: BundleEntry;
  originalRef?: string;
}

/**
 * Extract all inline attachment data values (keys named "data") from a bundle
 * entry's resource.
 *
 * Used to avoid HAPI FHIR BinaryStorageEntity collisions: when two resources in
 * the same transaction bundle share identical inline binary content (e.g. the
 * same Patient photo or Media content.data), HAPI tries to insert the same blob
 * ID twice in one session and fails with EntityExistsException (HAPI-0389).
 */
export function extractInlineDataKeys(entry: PreparedEntry): string[] {
  const keys: string[] = [];

  const walk = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'data' && typeof value === 'string' && value.length > 0) {
          keys.push(value);
        } else {
          walk(value);
        }
      }
    }
  };

  walk(entry.entry.resource);
  return keys;
}

/**
 * Split prepared entries into transaction bundles using global settings limits.
 *
 * When a `getCollisionKeys` extractor is provided, entries whose keys collide
 * with an earlier entry in the same bundle are moved into a new bundle. This
 * prevents HAPI FHIR BinaryStorageEntity EntityExistsException when multiple
 * resources in one transaction share identical inline binary content.
 */
export function splitPreparedEntries(
  prepared: PreparedEntry[],
  getCollisionKeys?: (entry: PreparedEntry) => string[],
): { bundle: Bundle; originalRefs: string[] }[] {
  const settings = useSettingsStore.getState();
  const maxCount = settings.maxBundleResourceCount;
  const maxSize = settings.maxBundleRequestSizeMb * 1024 * 1024;

  const results: { bundle: Bundle; originalRefs: string[] }[] = [];
  let currentBatch: PreparedEntry[] = [];
  let currentKeys = new Set<string>();

  const finalizeBatch = (batch: PreparedEntry[]): void => {
    if (batch.length === 0) return;
    results.push({
      bundle: {
        resourceType: 'Bundle',
        type: 'transaction',
        entry: batch.map(x => x.entry),
      },
      originalRefs: batch.map(x => x.originalRef).filter((ref): ref is string => ref !== undefined),
    });
  };

  for (const item of prepared) {
    const candidateBatch = [...currentBatch, item];
    const candidateBundle: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: candidateBatch.map(x => x.entry),
    };
    const size = calculateSerializedSize(candidateBundle);

    const itemKeys = getCollisionKeys?.(item) ?? [];
    const collides =
      currentBatch.length > 0 && itemKeys.some((key) => currentKeys.has(key));

    if (currentBatch.length > 0 && (collides || size > maxSize || currentBatch.length >= maxCount)) {
      finalizeBatch(currentBatch);
      currentBatch = [];
      currentKeys = new Set();
    }

    currentBatch.push(item);
    for (const key of itemKeys) currentKeys.add(key);
  }

  finalizeBatch(currentBatch);
  return results;
}

/**
 * Split raw bundle entries into transaction bundles using global settings limits.
 */
export function splitBundleEntries(
  entries: BundleEntry[],
  getCollisionKeys?: (entry: PreparedEntry) => string[],
): Bundle[] {
  return splitPreparedEntries(entries.map(entry => ({ entry })), getCollisionKeys).map(res => res.bundle);
}

/**
 * Split a large list of resources into multiple Transaction Bundles.
 */
export function buildTransactionBundles(
  resources: FhirResource[],
): Bundle[] {
  const bundle = buildTransactionBundle(resources);
  return splitBundleEntries(bundle.entry ?? []);
}

// ---------------------------------------------------------------------------
// 2. Resource-type bundle (Dependency Migration Pipeline)
// ---------------------------------------------------------------------------

export interface ResourceTypeBundleResult {
  bundle: Bundle;
  /**
   * Original "ResourceType/id" refs in the same order as bundle.entry[].
   * Used by the caller to register old→new mappings after the server responds.
   */
  originalRefs: string[];
}

/**
 * Build a Transaction Bundle for a batch of resources of a SINGLE resource type.
 *
 * Each resource:
 *   - Gets a stable urn:uuid as fullUrl
 *   - Has its id stripped (the server assigns a new one)
 *   - Has meta cleaned and migration marker injected
 *
 * IMPORTANT: References must have already been rewritten by the caller before
 * passing resources here (using rewriteResourceRefs + ResourceMappingService).
 *
 * @param resources    Batch of resources — must all be the same resource type
 * @param stripFields  Optional extra top-level fields to remove (e.g. ["link"]
 *                     to strip Patient.link before Phase 1a upload)
 */
export function buildResourceTypeBundle(
  resources: FhirResource[],
  stripFields: string[] = [],
): ResourceTypeBundleResult {
  const originalRefs: string[] = [];

  const entries: BundleEntry[] = resources.map((resource) => {
    const urn = generateUrn();
    const originalRef = resource.id ? `${resource.resourceType}/${resource.id}` : null;
    if (originalRef) originalRefs.push(originalRef);
    else originalRefs.push(urn); // edge case: resource without id

    // Strip server-assigned id + meta + any caller-specified fields
    const { id: _id, meta, ...rest } = resource;
    void _id;

    let body: Record<string, unknown> = { ...rest, meta: cleanMeta(meta) };
    for (const field of stripFields) {
      delete body[field];
    }
    // Remove undefined values
    body = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));

    return {
      fullUrl: urn,
      resource: { resourceType: resource.resourceType, ...body } as FhirResource,
      request: { method: 'POST', url: resource.resourceType },
    };
  });

  return {
    bundle: { resourceType: 'Bundle', type: 'transaction', entry: entries },
    originalRefs,
  };
}

/**
 * @deprecated Use buildResourceTypeBundle instead.
 * Kept for backward compatibility during the transition.
 */
export const buildSharedResourceBundle = buildResourceTypeBundle;
