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
import { createHash } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';

export interface PinPosition {
  x: number;
  z: number;
}

/**
 * What kind of content the pin points at — drives renderer dispatch on the
 * frontend. Absent (`undefined`) means a legacy fiber-slug pin where the slug
 * itself identifies the fiber and no explicit source is recorded; this is the
 * pre-2026-04 default and is still the path drag-to-pin from the HUD takes.
 *
 * See [[pin-any-file-type]] and [[tapestry-dissolves]] Open Question 3.
 */
export type PinKind = 'fiber' | 'markdown' | 'pdf' | 'image' | 'html' | 'other';

export const PIN_KINDS: readonly PinKind[] = [
  'fiber', 'markdown', 'pdf', 'image', 'html', 'other',
];

/**
 * Where the pin's content lives. Either a project-relative file handle
 * (originId + absolute path, resolvable via /project-file/...) OR a URL.
 * Mutually exclusive: validators reject pins that mix the two.
 */
export interface PinSource {
  originId?: string;
  path?: string;
  url?: string;
}

export interface Pin extends PinPosition {
  /** Stable key. For fiber pins, the fiber slug. For file pins, derived from the source. */
  slug: string;
  pinnedAt: number;
  /** Optional content kind. Absent = legacy fiber-slug pin. */
  kind?: PinKind;
  /** Optional source handle for non-fiber pins. Absent = the slug IS the fiber identifier. */
  source?: PinSource;
}

export interface PinExtras {
  kind?: PinKind;
  source?: PinSource;
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
            if (pin && typeof pin.slug === 'string') {
              pins.set(pin.slug, normalizeStoredPin(pin));
            }
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

  setPin(
    cityId: string,
    slug: string,
    pos: PinPosition,
    meta?: PinMeta,
    extras?: PinExtras,
  ): Pin | null {
    if (!isSafeId(cityId) || !isSafeId(slug)) return null;
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return null;
    if (extras?.kind && !PIN_KINDS.includes(extras.kind)) return null;
    const cleanSource = extras?.source ? sanitizeSource(extras.source) : undefined;
    if (extras?.source && !cleanSource) return null;
    const pins = this.loadCity(cityId);
    const existing = pins.get(slug);
    const pin: Pin = {
      slug,
      x: pos.x,
      z: pos.z,
      pinnedAt: existing?.pinnedAt ?? Date.now(),
      // Extras update if provided, otherwise preserve what's already on disk.
      ...((extras?.kind ?? existing?.kind) ? { kind: (extras?.kind ?? existing?.kind)! } : {}),
      ...((cleanSource ?? existing?.source) ? { source: (cleanSource ?? existing?.source)! } : {}),
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

/**
 * Derive a stable, idempotent slug for a file pin. Pinning the same file
 * twice updates the same pin (matching the slug-pin contract). The prefix
 * keeps file pins visually distinct from fiber slugs in URLs and disk files.
 *
 * - file handle  → `file-${sha256(originId+':'+absolutePath)[:16]}`
 * - url          → `url-${sha256(url)[:16]}`
 */
export function slugForSource(source: PinSource): string | null {
  const clean = sanitizeSource(source);
  if (!clean) return null;
  if (clean.url) {
    return 'url-' + createHash('sha256').update(clean.url).digest('hex').slice(0, 16);
  }
  const key = `${clean.originId}:${clean.path}`;
  return 'file-' + createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Infer a pin kind from a path's extension. Caller is free to override (a
 * `.md` file under `.felt/` is a fiber, not generic markdown — that detail
 * isn't reachable from the extension alone).
 */
export function kindFromPath(path: string): PinKind {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'md': case 'markdown': return 'markdown';
    case 'pdf': return 'pdf';
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'svg': case 'webp': case 'avif':
      return 'image';
    case 'html': case 'htm': return 'html';
    default: return 'other';
  }
}

function sanitizeSource(src: PinSource): PinSource | null {
  if (!src || typeof src !== 'object') return null;
  const hasHandle = typeof src.originId === 'string' && typeof src.path === 'string';
  const hasUrl = typeof src.url === 'string';
  // Mutually exclusive: file-handle XOR url. Avoids ambiguous round-trips.
  if (hasHandle === hasUrl) return null;
  if (hasHandle) {
    if (!src.originId || !src.path) return null;
    if (src.path.includes('\0')) return null;
    return { originId: src.originId, path: src.path };
  }
  if (!src.url) return null;
  if (src.url.includes('\0')) return null;
  return { url: src.url };
}

function normalizeStoredPin(raw: Pin): Pin {
  const out: Pin = { slug: raw.slug, x: raw.x, z: raw.z, pinnedAt: raw.pinnedAt };
  if (raw.kind && PIN_KINDS.includes(raw.kind)) out.kind = raw.kind;
  if (raw.source) {
    const clean = sanitizeSource(raw.source);
    if (clean) out.source = clean;
  }
  return out;
}
