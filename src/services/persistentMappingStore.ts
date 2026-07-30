/**
 * Persistent Mapping Store — stores old→new FHIR ID mappings across migration
 * runs so subsequent migrations can reuse previously established mappings.
 *
 * Unlike checkpoints (which are deleted on success), this store is NEVER
 * automatically deleted. It is keyed by source+target URL combination so
 * different server pairs maintain independent mapping sets.
 *
 * File location: {AppLocalData}/persistent-mappings.json
 */

import {
  BaseDirectory,
  exists,
  readTextFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs';
import { log } from '../store/logStore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILENAME = 'persistent-mappings.json';
const BASE_DIR = BaseDirectory.AppLocalData;
const CURRENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistentMappingEntry {
  sourceUrl: string;
  targetUrl: string;
  /** All known "ResourceType/id" → "ResourceType/id" mappings for this server pair */
  mappings: Record<string, string>;
  updatedAt: string;
}

interface PersistentMappingData {
  version: number;
  /** Keyed by "sourceUrl|targetUrl" */
  entries: Record<string, PersistentMappingEntry>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeKey(sourceUrl: string, targetUrl: string): string {
  // Normalize trailing slashes for consistent keys
  const src = sourceUrl.endsWith('/') ? sourceUrl.slice(0, -1) : sourceUrl;
  const tgt = targetUrl.endsWith('/') ? targetUrl.slice(0, -1) : targetUrl;
  return `${src}|${tgt}`;
}

async function loadAll(): Promise<PersistentMappingData> {
  try {
    const fileExists = await exists(FILENAME, { baseDir: BASE_DIR });
    if (!fileExists) {
      return { version: CURRENT_VERSION, entries: {} };
    }

    const json = await readTextFile(FILENAME, { baseDir: BASE_DIR });
    const parsed = JSON.parse(json) as PersistentMappingData;

    // Version check — if incompatible, start fresh
    if (parsed.version !== CURRENT_VERSION) {
      console.warn(
        `[PersistentMappingStore] Store version ${parsed.version} is incompatible with v${CURRENT_VERSION}. Starting fresh.`,
      );
      return { version: CURRENT_VERSION, entries: {} };
    }

    return parsed;
  } catch (err) {
    console.warn('[PersistentMappingStore] Failed to load persistent mappings:', err);
    return { version: CURRENT_VERSION, entries: {} };
  }
}

async function saveAll(data: PersistentMappingData): Promise<void> {
  try {
    const json = JSON.stringify(data, null, 2);
    await writeTextFile(FILENAME, json, { baseDir: BASE_DIR });
  } catch (err) {
    console.warn('[PersistentMappingStore] Failed to save persistent mappings:', err);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load all persistent mappings for a given source→target server pair.
 * Returns a flat Record of "ResourceType/id" → "ResourceType/id".
 */
export async function loadPersistentMappings(
  sourceUrl: string,
  targetUrl: string,
): Promise<Record<string, string>> {
  const data = await loadAll();
  const key = makeKey(sourceUrl, targetUrl);
  const entry = data.entries[key];
  if (!entry) return {};

  log({
    level: 'info',
    message: `Loaded ${Object.keys(entry.mappings).length} persistent mappings for ${sourceUrl} → ${targetUrl}`,
  });

  return { ...entry.mappings };
}

/**
 * Merge new mappings into the persistent store for a given server pair.
 * Existing keys are overwritten (latest mapping wins).
 *
 * @param sourceUrl  Source FHIR server base URL
 * @param targetUrl  Target FHIR server base URL
 * @param newMappings  New "ResourceType/id" → "ResourceType/id" mappings to add
 */
export async function savePersistentMappings(
  sourceUrl: string,
  targetUrl: string,
  newMappings: Record<string, string>,
): Promise<void> {
  if (Object.keys(newMappings).length === 0) return;

  const data = await loadAll();
  const key = makeKey(sourceUrl, targetUrl);

  const existing = data.entries[key];
  const merged: Record<string, string> = {
    ...(existing?.mappings ?? {}),
    ...newMappings,
  };

  data.entries[key] = {
    sourceUrl: sourceUrl.endsWith('/') ? sourceUrl.slice(0, -1) : sourceUrl,
    targetUrl: targetUrl.endsWith('/') ? targetUrl.slice(0, -1) : targetUrl,
    mappings: merged,
    updatedAt: new Date().toISOString(),
  };

  await saveAll(data);

  log({
    level: 'info',
    message: `Saved ${Object.keys(newMappings).length} new persistent mappings (${Object.keys(merged).length} total) for ${sourceUrl} → ${targetUrl}`,
  });
}

/**
 * Get a summary of all stored server pairs for display.
 */
export async function getPersistentMappingSummary(): Promise<{ sourceUrl: string; targetUrl: string; mappingCount: number }[]> {
  const data = await loadAll();
  return Object.values(data.entries).map((entry) => ({
    sourceUrl: entry.sourceUrl,
    targetUrl: entry.targetUrl,
    mappingCount: Object.keys(entry.mappings).length,
  }));
}
