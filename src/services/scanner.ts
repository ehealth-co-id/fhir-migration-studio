/**
 * Scanner — counts resources on the source server per resource type.
 * Uses FHIR _summary=count to get totals without fetching full resources.
 */

import { fhirClient } from './fhirClient';
import { log } from '../store/logStore';
import type { ServerConfig } from '../types/server';
import type { FhirResourceType } from '../types/fhir';

export type ScanResult = Partial<Record<FhirResourceType, number>>;

/**
 * Scans the source server for resource counts.
 * @param config Source server configuration
 * @param resourceTypes Resource types to scan
 * @param dateFrom Optional start date for _lastUpdated range (inclusive, ISO date)
 * @param dateTo Optional end date for _lastUpdated range (inclusive, ISO date)
 * @returns Record of resourceType → count
 */
export async function scanResourceCounts(
  config: ServerConfig,
  resourceTypes: FhirResourceType[],
  onProgress?: (resourceType: FhirResourceType, count: number) => void,
  shouldContinue?: () => Promise<boolean> | boolean,
  dateFrom?: string,
  dateTo?: string,
): Promise<ScanResult> {
  const result: ScanResult = {};

  for (const resourceType of resourceTypes) {
    if (shouldContinue) {
      const keepGoing = await shouldContinue();
      if (!keepGoing) {
        log({ level: 'warn', message: `Scanning cancelled/stopped for ${resourceType}` });
        break;
      }
    }

    try {
      const params: Record<string, string | string[]> = { _summary: 'count' };
      const lastUpdated: string[] = [];
      if (dateFrom) lastUpdated.push(`ge${dateFrom}`);
      if (dateTo) lastUpdated.push(`le${dateTo}`);
      if (lastUpdated.length > 0) params['_lastUpdated'] = lastUpdated;

      const bundle = await fhirClient.search(config, resourceType, params);
      const count = bundle.total ?? 0;
      result[resourceType] = count;
      
      if (onProgress) {
        onProgress(resourceType, count);
      }

      log({
        level: 'info',
        message: `Found ${count} ${resourceType} resources`,
        resourceType,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log({
        level: 'warn',
        message: `Could not scan ${resourceType}: ${msg}`,
        resourceType,
      });
      result[resourceType] = 0;
      
      if (onProgress) {
        onProgress(resourceType, 0);
      }
    }
  }

  return result;
}
