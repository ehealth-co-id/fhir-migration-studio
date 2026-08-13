/**
 * Persistent Mapping Store — stores old→new FHIR ID mappings across migration
 * runs so subsequent migrations can reuse previously established mappings.
 *
 * Unlike checkpoints (which are deleted on success), this store is NEVER
 * automatically deleted. It is keyed by a user-provided migration name so that
 * different migration contexts (even with the same server URLs) can maintain
 * independent mapping sets.
 *
 * File location: {projectRoot}/data/persistent-mappings.json
 * Stored in the project repo so it can be committed to git and shared.
 */

import {
  BaseDirectory,
  exists,
  readTextFile,
  writeTextFile,
  mkdir,
} from '@tauri-apps/plugin-fs';
import { log } from '../store/logStore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Path relative to BaseDirectory.Resource (= src-tauri/ in dev mode).
 * "../data" resolves to {projectRoot}/data/.
 */
const FILENAME = '../data/persistent-mappings.json';
const DATA_DIR = '../data';
const BASE_DIR = BaseDirectory.Resource;
const CURRENT_VERSION = 2; // v1 → v2: key changed from URL-based to name-based

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistentMappingEntry {
  /** User-provided migration name (e.g. "Migrasi Klinik A Premium ke A Lite") */
  name: string;
  /** Source FHIR server URL at time of last save (for display only) */
  sourceUrl: string;
  /** Target FHIR server URL at time of last save (for display only) */
  targetUrl: string;
  /** All known "ResourceType/id" → "ResourceType/id" mappings */
  mappings: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** Summary returned for the mapping set picker UI */
export interface PersistentMappingSummary {
  name: string;
  sourceUrl: string;
  targetUrl: string;
  mappingCount: number;
  createdAt: string;
  updatedAt: string;
}

interface PersistentMappingData {
  version: number;
  /** Keyed by user-provided migration name (case-sensitive, trimmed) */
  entries: Record<string, PersistentMappingEntry>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeName(name: string): string {
  return name.trim();
}

async function ensureDataDir(): Promise<void> {
  try {
    const dirExists = await exists(DATA_DIR, { baseDir: BASE_DIR });
    if (!dirExists) {
      await mkdir(DATA_DIR, { baseDir: BASE_DIR, recursive: true });
    }
  } catch {
    // Non-fatal — dir may exist or permissions may prevent creation
  }
}

async function loadAll(): Promise<PersistentMappingData> {
  try {
    const fileExists = await exists(FILENAME, { baseDir: BASE_DIR });
    if (!fileExists) {
      return { version: CURRENT_VERSION, entries: {} };
    }

    const json = await readTextFile(FILENAME, { baseDir: BASE_DIR });
    const parsed = JSON.parse(json) as PersistentMappingData;

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
    await ensureDataDir();
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
 * Load persistent mappings for a given migration name.
 * Returns a flat Record of "ResourceType/id" → "ResourceType/id".
 */
export async function loadPersistentMappings(
  name: string,
): Promise<Record<string, string>> {
  const data = await loadAll();
  const key = normalizeName(name);
  const entry = data.entries[key];
  if (!entry) return {};

  log({
    level: 'info',
    message: `Loaded ${Object.keys(entry.mappings).length} persistent mappings for "${key}"`,
  });

  return { ...entry.mappings };
}

/**
 * Save (merge) new mappings into the persistent store under a migration name.
 * Existing keys for the same name are overwritten (latest mapping wins).
 *
 * @param name         User-provided migration name
 * @param sourceUrl    Source FHIR server for metadata
 * @param targetUrl    Target FHIR server for metadata
 * @param newMappings  New "ResourceType/id" → "ResourceType/id" mappings to merge
 */
export async function savePersistentMappings(
  name: string,
  sourceUrl: string,
  targetUrl: string,
  newMappings: Record<string, string>,
): Promise<void> {
  if (Object.keys(newMappings).length === 0) return;

  const key = normalizeName(name);
  if (!key) return;

  const data = await loadAll();
  const now = new Date().toISOString();

  const existing = data.entries[key];
  const merged: Record<string, string> = {
    ...(existing?.mappings ?? {}),
    ...newMappings,
  };

  data.entries[key] = {
    name: key,
    sourceUrl: sourceUrl.endsWith('/') ? sourceUrl.slice(0, -1) : sourceUrl,
    targetUrl: targetUrl.endsWith('/') ? targetUrl.slice(0, -1) : targetUrl,
    mappings: merged,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await saveAll(data);

  log({
    level: 'info',
    message: `Saved ${Object.keys(newMappings).length} new mappings to "${key}" (${Object.keys(merged).length} total)`,
  });
}

/**
 * List all saved mapping sets for the picker UI.
 * Returns newest first.
 */
export async function listMappingSets(): Promise<PersistentMappingSummary[]> {
  const data = await loadAll();
  return Object.values(data.entries)
    .map((entry) => ({
      name: entry.name,
      sourceUrl: entry.sourceUrl,
      targetUrl: entry.targetUrl,
      mappingCount: Object.keys(entry.mappings).length,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Delete a mapping set by name.
 */
export async function deleteMappingSet(name: string): Promise<void> {
  const key = normalizeName(name);
  if (!key) return;

  const data = await loadAll();
  if (data.entries[key]) {
    delete data.entries[key];
    await saveAll(data);
    log({
      level: 'info',
      message: `Deleted persistent mapping set "${key}"`,
    });
  }
}
