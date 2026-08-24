import { create } from 'zustand';
import type { FhirResource, FhirResourceType } from '../types/fhir';
import type { ServerConfig } from '../types/server';
import type { MappingRule } from '../types/mapping';
import { rewriteReferences } from '../services/mapper';
import { buildTransactionBundles, extractInlineDataKeys } from '../services/bundleBuilder';
import { uploadBundles } from '../services/uploader';
import { log } from './logStore';

export interface ParsedFile {
  resources: FhirResource[];
  byType: Partial<Record<FhirResourceType, number>>;
  lineCount: number;
  errors: number;
}

export interface UploadState {
  status: 'idle' | 'uploading' | 'done' | 'error';
  success: number;
  failed: number;
  total: number;
  progress: number;
}

interface ImportState {
  parsed: ParsedFile | null;
  fileName: string;
  uploadState: UploadState;
  isCancelled: boolean;

  setFile: (fileName: string, parsed: ParsedFile | null) => void;
  startImport: (target: ServerConfig, rules: MappingRule[]) => Promise<void>;
  cancelImport: () => void;
  reset: () => void;
}

export const useImportStore = create<ImportState>()((set, get) => ({
  parsed: null,
  fileName: '',
  uploadState: {
    status: 'idle',
    success: 0,
    failed: 0,
    total: 0,
    progress: 0,
  },
  isCancelled: false,

  setFile: (fileName, parsed) =>
    set({
      fileName,
      parsed,
      uploadState: {
        status: 'idle',
        success: 0,
        failed: 0,
        total: parsed ? parsed.resources.length : 0,
        progress: 0,
      },
      isCancelled: false,
    }),

  startImport: async (target, rules) => {
    const { parsed, fileName, uploadState } = get();
    if (!parsed || uploadState.status === 'uploading' || !target.baseUrl) return;

    set({
      uploadState: {
        status: 'uploading',
        success: 0,
        failed: 0,
        total: parsed.resources.length,
        progress: 0,
      },
      isCancelled: false,
    });

    log({ level: 'info', message: `Starting NDJSON import: ${parsed.resources.length} resources from ${fileName}` });

    // Apply mapping rules
    const mapped = parsed.resources.map((r) => rewriteReferences(r, rules));

    // Group by resource type
    const byType = new Map<FhirResourceType, FhirResource[]>();
    for (const r of mapped) {
      const rt = r.resourceType;
      if (!byType.has(rt)) byType.set(rt, []);
      byType.get(rt)!.push(r);
    }

    let totalSuccess = 0;
    let totalFailed = 0;
    let processed = 0;

    try {
      for (const [rt, resources] of byType.entries()) {
        if (get().isCancelled) break;

        // Pass extractInlineDataKeys so resources sharing identical inline
        // binary content (e.g. Patient photo data) are never placed in the
        // same transaction bundle (HAPI-0389 BinaryStorageEntity collision).
        const bundles = buildTransactionBundles(resources, extractInlineDataKeys);
        
        await uploadBundles(
          target,
          bundles,
          rt,
          (result) => {
            // Because other resource types might have already completed,
            // we calculate completed amounts for the current batch + completed batches.
            // Wait, uploadBundles callback returns progress for the current resource type batch.
            // Let's compute overall counts.
            // Since uploadBundles runs sequentially, we can track total completed across resource types.
            const finishedSuccess = totalSuccess + result.success;
            const finishedFailed = totalFailed + result.failed;
            const overallProcessed = processed + result.success + result.failed;

            set({
              uploadState: {
                status: 'uploading',
                success: finishedSuccess,
                failed: finishedFailed,
                total: parsed.resources.length,
                progress: Math.round((overallProcessed / parsed.resources.length) * 100),
              },
            });
          },
          () => !get().isCancelled
        );

        // Keep rolling totals of completed types
        // Note: we can only add completed resources once uploadBundles resolves for that type.
        // Wait, what if it was cancelled mid-way? The shouldContinue callback inside uploadBundles will abort it,
        // and we will break out of the resource type loop too.
        
        if (get().isCancelled) {
          break;
        }

        // Loop completes for resource type `rt`, add completed counts
        const typeCount = resources.length;
        processed += typeCount;
        
        // Wait, did some fail? Let's check how many were uploaded/failed by comparing totals after uploadBundles resolves.
        // We can keep tracking the running totalSuccess and totalFailed by updating them.
        // To be safe, let's keep them in sync with the last progress call.
        // Actually, we can read the current state of uploadState to get the exact counts!
        const currentUploadState = get().uploadState;
        totalSuccess = currentUploadState.success;
        totalFailed = currentUploadState.failed;
      }

      if (get().isCancelled) {
        log({ level: 'warn', message: 'NDJSON import cancelled by user.' });
        set((s) => ({
          uploadState: {
            ...s.uploadState,
            status: 'idle',
          },
        }));
        return;
      }

      set((s) => ({
        uploadState: {
          ...s.uploadState,
          status: 'done',
          progress: 100,
        },
      }));
      log({ level: 'success', message: `Import complete: ${get().uploadState.success} ok, ${get().uploadState.failed} failed` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set((s) => ({
        uploadState: {
          ...s.uploadState,
          status: 'error',
        },
      }));
      log({ level: 'error', message: `Import failed: ${msg}` });
    }
  },

  cancelImport: () => {
    set({ isCancelled: true });
    set((s) => ({
      uploadState: {
        ...s.uploadState,
        status: 'idle',
      },
    }));
  },

  reset: () => {
    set({
      parsed: null,
      fileName: '',
      uploadState: {
        status: 'idle',
        success: 0,
        failed: 0,
        total: 0,
        progress: 0,
      },
      isCancelled: false,
    });
  },
}));
