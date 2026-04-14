import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { kindFromPath, LayoutStore, slugForSource } from '../LayoutStore.js';

const TEST_DIR = join(homedir(), '.portolan-layouts-test');

function makeStore(): LayoutStore {
  const store = new LayoutStore();
  (store as unknown as { dataDir: string }).dataDir = TEST_DIR;
  (store as unknown as { layoutsDir: string }).layoutsDir = join(TEST_DIR, 'layouts');
  return store;
}

describe('LayoutStore', () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns empty pins for unknown city', () => {
    const store = makeStore();
    expect(store.getPins('city-a')).toEqual([]);
  });

  it('persists a pin and reads it back', () => {
    const store = makeStore();
    const pin = store.setPin('city-a', 'fiber-1', { x: 10, z: -5 });
    expect(pin).toMatchObject({ slug: 'fiber-1', x: 10, z: -5 });

    const fresh = makeStore();
    const pins = fresh.getPins('city-a');
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ slug: 'fiber-1', x: 10, z: -5 });
  });

  it('updates position but preserves pinnedAt on repeat setPin', async () => {
    const store = makeStore();
    const first = store.setPin('city-a', 'fiber-1', { x: 1, z: 2 })!;
    await new Promise((r) => setTimeout(r, 5));
    const second = store.setPin('city-a', 'fiber-1', { x: 3, z: 4 })!;
    expect(second.pinnedAt).toBe(first.pinnedAt);
    expect(second.x).toBe(3);
    expect(second.z).toBe(4);
  });

  it('removes a pin and deletes the file when empty', () => {
    const store = makeStore();
    store.setPin('city-a', 'fiber-1', { x: 0, z: 0 });
    const layoutFile = join(TEST_DIR, 'layouts', 'city-a.json');
    expect(existsSync(layoutFile)).toBe(true);

    expect(store.removePin('city-a', 'fiber-1')).toBe(true);
    expect(existsSync(layoutFile)).toBe(false);
    expect(store.removePin('city-a', 'fiber-1')).toBe(false);
  });

  it('rejects non-finite coordinates', () => {
    const store = makeStore();
    expect(store.setPin('city-a', 'fiber-1', { x: NaN, z: 0 })).toBeNull();
    expect(store.setPin('city-a', 'fiber-1', { x: 0, z: Infinity })).toBeNull();
    expect(store.getPins('city-a')).toEqual([]);
  });

  it('rejects unsafe ids containing path traversal', () => {
    const store = makeStore();
    expect(store.setPin('..', 'fiber-1', { x: 0, z: 0 })).toBeNull();
    expect(store.setPin('city-a', '../evil', { x: 0, z: 0 })).toBeNull();
    expect(store.getPin('..', 'fiber-1')).toBeNull();
  });

  it('writes pins sorted by slug for stable diffs', () => {
    const store = makeStore();
    store.setPin('city-a', 'z-last', { x: 0, z: 0 });
    store.setPin('city-a', 'a-first', { x: 1, z: 1 });
    const file = join(TEST_DIR, 'layouts', 'city-a.json');
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    expect(data.pins.map((p: { slug: string }) => p.slug)).toEqual(['a-first', 'z-last']);
  });

  it('isolates pins per city', () => {
    const store = makeStore();
    store.setPin('city-a', 'fiber-1', { x: 1, z: 1 });
    store.setPin('city-b', 'fiber-1', { x: 2, z: 2 });
    expect(store.getPin('city-a', 'fiber-1')?.x).toBe(1);
    expect(store.getPin('city-b', 'fiber-1')?.x).toBe(2);
  });

  it('records cityKey when provided and preserves it across writes', () => {
    const store = makeStore();
    store.setPin('city-a', 'fiber-1', { x: 1, z: 1 }, { cityKey: 'local:/abs/path' });
    const file = join(TEST_DIR, 'layouts', 'city-a.json');
    let data = JSON.parse(readFileSync(file, 'utf-8'));
    expect(data.cityKey).toBe('local:/abs/path');

    store.setPin('city-a', 'fiber-2', { x: 2, z: 2 });
    data = JSON.parse(readFileSync(file, 'utf-8'));
    expect(data.cityKey).toBe('local:/abs/path');
    expect(data.pins).toHaveLength(2);
  });

  it('omits cityKey when never provided', () => {
    const store = makeStore();
    store.setPin('city-a', 'fiber-1', { x: 1, z: 1 });
    const file = join(TEST_DIR, 'layouts', 'city-a.json');
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    expect(data.cityKey).toBeUndefined();
  });

  it('reloads cityKey from existing layout file', () => {
    const a = makeStore();
    a.setPin('city-a', 'fiber-1', { x: 1, z: 1 }, { cityKey: 'local:/orig/path' });

    const b = makeStore();
    // Trigger load, then write a new pin without supplying meta — cityKey must persist.
    b.setPin('city-a', 'fiber-2', { x: 2, z: 2 });
    const file = join(TEST_DIR, 'layouts', 'city-a.json');
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    expect(data.cityKey).toBe('local:/orig/path');
  });

  it('persists pin kind and file-handle source through round-trip', () => {
    const a = makeStore();
    const source = { originId: 'local', path: '/abs/paper.pdf' };
    a.setPin('city-a', 'file-deadbeef', { x: 0, z: 0 }, undefined, { kind: 'pdf', source });

    const b = makeStore();
    const pin = b.getPin('city-a', 'file-deadbeef')!;
    expect(pin.kind).toBe('pdf');
    expect(pin.source).toEqual(source);
  });

  it('preserves prior kind/source when setPin omits extras', () => {
    const store = makeStore();
    const source = { originId: 'local', path: '/a.pdf' };
    store.setPin('city-a', 'file-x', { x: 0, z: 0 }, undefined, { kind: 'pdf', source });
    // Reposition only — extras must persist.
    store.setPin('city-a', 'file-x', { x: 5, z: 5 });
    const pin = store.getPin('city-a', 'file-x')!;
    expect(pin.x).toBe(5);
    expect(pin.kind).toBe('pdf');
    expect(pin.source).toEqual(source);
  });

  it('rejects invalid kind and ambiguous source', () => {
    const store = makeStore();
    expect(store.setPin('city-a', 's', { x: 0, z: 0 }, undefined, { kind: 'bogus' as any })).toBeNull();
    // Source that mixes file handle and url is invalid.
    expect(store.setPin('city-a', 's', { x: 0, z: 0 }, undefined, {
      source: { originId: 'local', path: '/a', url: 'https://x' } as any,
    })).toBeNull();
    expect(store.getPins('city-a')).toEqual([]);
  });

  it('omits kind/source on disk when not set', () => {
    const store = makeStore();
    store.setPin('city-a', 'fiber-1', { x: 1, z: 1 });
    const file = join(TEST_DIR, 'layouts', 'city-a.json');
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    expect(data.pins[0].kind).toBeUndefined();
    expect(data.pins[0].source).toBeUndefined();
  });

  it('slugForSource is stable, idempotent, and prefixed by handle kind', () => {
    const a = slugForSource({ originId: 'local', path: '/x.pdf' });
    const b = slugForSource({ originId: 'local', path: '/x.pdf' });
    const c = slugForSource({ originId: 'local', path: '/y.pdf' });
    const u = slugForSource({ url: 'https://example.com' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a!.startsWith('file-')).toBe(true);
    expect(u!.startsWith('url-')).toBe(true);
    expect(slugForSource({ originId: 'local', path: '/x', url: 'https://x' } as any)).toBeNull();
    expect(slugForSource({} as any)).toBeNull();
  });

  it('kindFromPath classifies by extension', () => {
    expect(kindFromPath('foo.pdf')).toBe('pdf');
    expect(kindFromPath('foo.PDF')).toBe('pdf');
    expect(kindFromPath('foo.png')).toBe('image');
    expect(kindFromPath('foo.svg')).toBe('image');
    expect(kindFromPath('foo.html')).toBe('html');
    expect(kindFromPath('foo.md')).toBe('markdown');
    expect(kindFromPath('Makefile')).toBe('other');
  });

  it('scanLayouts surfaces every layout file with its cityKey', () => {
    const store = makeStore();
    store.setPin('city-a', 'fiber-1', { x: 0, z: 0 }, { cityKey: 'local:/a' });
    store.setPin('city-b', 'fiber-1', { x: 0, z: 0 });
    const entries = store.scanLayouts().sort((p, q) => p.cityId.localeCompare(q.cityId));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ cityId: 'city-a', cityKey: 'local:/a' });
    expect(entries[1]).toMatchObject({ cityId: 'city-b', cityKey: null });
  });
});
