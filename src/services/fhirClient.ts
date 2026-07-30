/**
 * FHIR HTTP Client.
 *
 * Wraps fetch with:
 * - Optional Bearer token Authorization header
 * - Optional X-Tenant-Id header
 * - JSON content type for POST requests
 *
 * Uses the native browser fetch API (works in Tauri webview for same-network requests).
 * If you encounter CORS issues with the FHIR server, enable Tauri's http plugin.
 */

import type { ServerConfig } from '../types/server';
import type { Bundle, CapabilityStatement, FhirResource } from '../types/fhir';
import { log } from '../store/logStore';

export class FhirClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'FhirClientError';
  }
}

function buildHeaders(config: ServerConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: '*/*',
    'Content-Type': 'application/json',
  };

  if (config.auth?.token) {
    headers['Authorization'] = `Bearer ${config.auth.token}`;
  }

  if (config.tenantId) {
    headers['X-Tenant-Id'] = config.tenantId;
  }

  return headers;
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

async function handleResponse<T>(response: Response, context: string, requestUrl?: string): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const detail = [
      requestUrl ? `URL: ${requestUrl}` : null,
      body ? `Response body: ${body.slice(0, 1000)}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    throw new FhirClientError(
      `${context} failed: HTTP ${response.status} ${response.statusText}`,
      response.status,
      detail || body,
    );
  }
  return response.json() as Promise<T>;
}

export const fhirClient = {
  /**
   * GET a FHIR resource or search result.
   * @param config Server configuration
   * @param path Path relative to base URL (e.g. "/Patient?_count=50")
   */
  async get<T = FhirResource>(config: ServerConfig, path: string): Promise<T> {
    const base = normalizeBaseUrl(config.baseUrl);
    const url = `${base}${path}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(config),
    });
    return handleResponse<T>(response, `GET ${path}`, url);
  },

  /**
   * POST a FHIR resource or Transaction Bundle.
   */
  async post<T = FhirResource>(config: ServerConfig, path: string, body: unknown): Promise<T> {
    const base = normalizeBaseUrl(config.baseUrl);
    const url = `${base}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify(body),
    });
    return handleResponse<T>(response, `POST ${path}`, url);
  },

  /**
   * Test connectivity by reading the CapabilityStatement (metadata endpoint).
   * Returns the FHIR version string on success.
   */
  async testConnection(config: ServerConfig): Promise<CapabilityStatement> {
    log({ level: 'info', message: `Testing connection to ${config.baseUrl}` });
    try {
      const cs = await fhirClient.get<CapabilityStatement>(config, '/metadata');
      log({
        level: 'success',
        message: `Connected to ${config.name} (FHIR ${cs.fhirVersion ?? 'unknown'})`,
        detail: cs.software?.name
          ? `Software: ${cs.software.name} ${cs.software.version ?? ''}`
          : undefined,
      });
      return cs;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const detail = err instanceof FhirClientError ? err.body : undefined;
      log({ level: 'error', message: `Connection failed: ${msg}`, detail });
      throw err;
    }
  },

  /**
   * Search a resource type with optional query params.
   * Returns the full Bundle (searchset).
   *
   * Values can be strings or string[] — arrays are emitted as repeated
   * query parameters (e.g. _lastUpdated=ge2024-01-01&_lastUpdated=le2024-12-31).
   */
  async search(
    config: ServerConfig,
    resourceType: string,
    params: Record<string, string | string[]> = {},
  ): Promise<Bundle> {
    const sp = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        for (const item of value) sp.append(key, item);
      } else {
        sp.append(key, value);
      }
    }
    const qs = sp.toString();
    const path = `/${resourceType}${qs ? `?${qs}` : ''}`;
    return fhirClient.get<Bundle>(config, path);
  },

  /**
   * Fetch the next page of a search result using the Bundle's next link.
   *
   * FHIR servers return absolute URLs in the "next" relation link that use
   * the server's own internal hostname/port. We discard that origin and use
   * only the query string, re-attaching it to the user-configured base URL.
   *
   * Example next URL returned by server:
   *   https://api.internal.example.com/fhir/?_getpages=abc&_getpagesoffset=50&_count=50
   * Configured base URL:
   *   http://localhost:9090/fhir
   * Resolved URL used for request:
   *   http://localhost:9090/fhir/?_getpages=abc&_getpagesoffset=50&_count=50
   */
  async nextPage(config: ServerConfig, nextUrl: string): Promise<Bundle> {
    const base = normalizeBaseUrl(config.baseUrl);
    let url: string;

    if (nextUrl.startsWith('http')) {
      // Extract only the query string from the server-returned absolute URL,
      // then apply it to the user-configured base URL.
      try {
        const parsed = new URL(nextUrl);
        url = `${base}/${parsed.search}`;
      } catch {
        // Fallback: use as-is if URL parsing fails
        url = nextUrl;
      }
    } else {
      // Relative URL — append directly
      url = `${base}${nextUrl}`;
    }

    log({
      level: 'info',
      message: `Fetching next page`,
      detail: `Original next link: ${nextUrl}\nResolved URL: ${url}`,
    });

    const response = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(config),
    });
    return handleResponse<Bundle>(response, `GET next page`, url);
  },
};
