/**
 * LayoutStore - Persisted pin positions for vellum cards on the portolan map.
 *
 * See fiber `tapestry-dissolves`. Per-city JSON at
 *   ~/.portolan/layouts/{cityId}.json
 * Each pin is a fiber slug placed at cartesian world coords {x, z} on the
 * hex plane. World-space rendering means these numbers are the source of
 * truth for where a card sits in the scene.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface PinPosition {
  x: number;
  z: number;
}

export interface Pin extends PinPosition {
  slug: string;
  pinnedAt: number;
}

interface LayoutFile {
  version: 1;
  cityId: string;
  /**
   * Stable origin+path key the cityId was derived from
   * (`${originId}:${absolutePath}`). Optional for backward compatibility with
   * pre-2026-04 layout files. Recorded so a later GC pass can detect orphans
   * (project moved → new cityId, old layout file unreachable) without re-deriving
   * cityIds from CityManager state.
   */
  cityKey?: string;
  pins: Pin[];
}

export interface PinMeta {
  /** `${originId}:${absolutePath}` for the city this layout belongs to. */
  cityKey?: string;
}

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_\-/.]*$/;

function isSafeId(id: string): boolean {
  return SLUG_RE.test(id) && !id.includes('..');
}

export class LayoutStore {
  private readonly dataDir: string;
  private readonly layoutsDir: string;
  private readonly cache = new Map<string, Map<string, Pin>>();
  private readonly cityKeys = new Map<string, string>();

  constructor() {
    this.dataDir = join(homedir(), '.portolan');
    this.layoutsDir = join(this.dataDir, 'layouts');
  }

  private pathFor(cityId: string): string {
    return join(this.layoutsDir, `${cityId}.json`);
  }

  private loadCity(cityId: string): Map<string, Pin> {
    const cached = this.cache.get(cityId);
    if (cached) return cached;

    const pins = new Map<string, Pin>();
    const file = this.pathFor(cityId);
    if (existsSync(file)) {
      try {
        const data: LayoutFile = JSON.parse(readFileSync(file, 'utf-8'));
        if (data.version === 1 && Array.isArray(data.pins)) {
          for (const pin of data.pins) {
            if (pin && typeof pin.slug === 'string') pins.set(pin.slug, pin);
          }
          if (typeof data.cityKey === 'string') this.cityKeys.set(cityId, data.cityKey);
        } else {
          console.warn(`Unknown layouts version for ${cityId}: ${data.version}`);
        }
      } catch (err) {
        console.error(`Failed to load layout for ${cityId}:`, err);
      }
    }
    this.cache.set(cityId, pins);
    return pins;
  }

  private save(cityId: string): void {
    const pins = this.cache.get(cityId);
    if (!pins) return;

    if (!existsSync(this.layoutsDir)) {
      mkdirSync(this.layoutsDir, { recursive: true });
    }

    const file = this.pathFor(cityId);

    if (pins.size === 0) {
      if (existsSync(file)) {
        try { unlinkSync(file); } catch (err) { console.error(`Failed to remove empty layout ${file}:`, err); }
      }
      this.cityKeys.delete(cityId);
      return;
    }

    const cityKey = this.cityKeys.get(cityId);
    const data: LayoutFile = {
      version: 1,
      cityId,
      ...(cityKey ? { cityKey } : {}),
      pins: [...pins.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    };

    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, file);
  }

  getPins(cityId: string): Pin[] {
    if (!isSafeId(cityId)) return [];
    const pins = this.loadCity(cityId);
    return [...pins.values()];
  }

  getPin(cityId: string, slug: string): Pin | null {
    if (!isSafeId(cityId) || !isSafeId(slug)) return null;
    return this.loadCity(cityId).get(slug) ?? null;
  }

  setPin(cityId: string, slug: string, pos: PinPosition, meta?: PinMeta): Pin | null {
    if (!isSafeId(cityId) || !isSafeId(slug)) return null;
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return null;
    const pins = this.loadCity(cityId);
    const existing = pins.get(slug);
    const pin: Pin = {
      slug,
      x: pos.x,
      z: pos.z,
      pinnedAt: existing?.pinnedAt ?? Date.now(),
    };
    pins.set(slug, pin);
    if (meta?.cityKey) this.cityKeys.set(cityId, meta.cityKey);
    this.save(cityId);
    return pin;
  }

  /**
   * Diagnostic: list every layout file on disk with the cityKey it was last
   * written under (or `null` if the file predates cityKey recording).
   */
  scanLayouts(): Array<{ cityId: string; cityKey: string | null; file: string }> {
    if (!existsSync(this.layoutsDir)) return [];
    const entries: Array<{ cityId: string; cityKey: string | null; file: string }> = [];
    let names: string[] = [];
    try { names = readdirSync(this.layoutsDir); } catch { return []; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const cityId = name.slice(0, -5);
      if (!isSafeId(cityId)) continue;
      const file = join(this.layoutsDir, name);
      let cityKey: string | null = null;
      try {
        const data: LayoutFile = JSON.parse(readFileSync(file, 'utf-8'));
        if (typeof data.cityKey === 'string') cityKey = data.cityKey;
      } catch { /* malformed file: report it anyway */ }
      entries.push({ cityId, cityKey, file });
    }
    return entries;
  }

  removePin(cityId: string, slug: string): boolean {
    if (!isSafeId(cityId) || !isSafeId(slug)) return false;
    const pins = this.loadCity(cityId);
    const existed = pins.delete(slug);
    if (existed) this.save(cityId);
    return existed;
  }
}
