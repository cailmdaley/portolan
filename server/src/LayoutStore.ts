/**
 * LayoutStore - Persisted pin positions for vellum cards on the portolan map.
 *
 * See fiber `tapestry-dissolves`. Per-city JSON at
 *   ~/.portolan/layouts/{cityId}.json
 * Each pin is a fiber slug placed at cartesian world coords {x, z} on the
 * hex plane. World-space rendering means these numbers are the source of
 * truth for where a card sits in the scene.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
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
  pins: Pin[];
}

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_\-/.]*$/;

function isSafeId(id: string): boolean {
  return SLUG_RE.test(id) && !id.includes('..');
}

export class LayoutStore {
  private readonly dataDir: string;
  private readonly layoutsDir: string;
  private readonly cache = new Map<string, Map<string, Pin>>();

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
      return;
    }

    const data: LayoutFile = {
      version: 1,
      cityId,
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

  setPin(cityId: string, slug: string, pos: PinPosition): Pin | null {
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
    this.save(cityId);
    return pin;
  }

  removePin(cityId: string, slug: string): boolean {
    if (!isSafeId(cityId) || !isSafeId(slug)) return false;
    const pins = this.loadCity(cityId);
    const existed = pins.delete(slug);
    if (existed) this.save(cityId);
    return existed;
  }
}
