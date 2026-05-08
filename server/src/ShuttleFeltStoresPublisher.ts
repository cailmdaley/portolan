import { resolve } from 'path';

import type { PersistedCity } from './CityPersistence.js';

const SHUTTLE_FELT_STORES_URL =
  process.env.SHUTTLE_FELT_STORES_URL || 'http://127.0.0.1:4000/api/v1/felt-stores';

export function localPinnedFeltStores(cities: PersistedCity[]): string[] {
  return [...new Set(
    cities
      .filter((city) => city.originId === 'local')
      .map((city) => resolve(city.path)),
  )];
}

export async function publishShuttleFeltStores(
  cities: PersistedCity[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; feltStores: string[] }> {
  const feltStores = localPinnedFeltStores(cities);

  try {
    const response = await fetchImpl(SHUTTLE_FELT_STORES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ felt_stores: feltStores }),
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(body ? `HTTP ${response.status}: ${body}` : `HTTP ${response.status}`);
    }

    return { ok: true, feltStores };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!process.env.VITEST) {
      console.warn(`[Shuttle] felt-store registration failed: ${msg}`);
    }
    return { ok: false, feltStores };
  }
}
