import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, relative } from 'path';
import { HttpApiFilesSearch } from '../HttpApiFilesSearch.js';
import type { CityIndexWalker, FileWalkEntry, FileWalkResult } from '../HttpApiFilesSearch.js';

const TEST_ROOT = join(homedir(), '.portolan-test-files-search');

function writeFile(path: string, content = ''): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

const testWalkCityIndex: CityIndexWalker = async (cityPath, maxEntries) => {
  const entries: FileWalkEntry[] = [];
  let truncated = false;

  const push = (entry: FileWalkEntry): boolean => {
    if (entries.length >= maxEntries) {
      truncated = true;
      return false;
    }
    entries.push(entry);
    return true;
  };

  const walk = (dir: string): boolean => {
    const children = readdirSync(dir)
      .filter((name) => !['.git', '.felt', 'node_modules', '__pycache__'].includes(name))
      .map((name) => join(dir, name))
      .sort((a, b) => relative(cityPath, a).localeCompare(relative(cityPath, b)));
    const dirs = children.filter((path) => statSync(path).isDirectory());
    const files = children.filter((path) => statSync(path).isFile());

    for (const path of dirs) {
      if (!push({ relativePath: relative(cityPath, path), type: 'dir' })) return false;
      if (!walk(path)) return false;
    }
    for (const path of files) {
      if (!push({ relativePath: relative(cityPath, path), type: 'file' })) return false;
    }
    return true;
  };

  walk(cityPath);
  return { entries, truncated, timedOut: false, stderr: '' };
};

function testApiOptions() {
  return { walkCityIndex: testWalkCityIndex, indexerKind: 'test' };
}

describe('HttpApiFilesSearch', () => {
  beforeEach(() => {
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('returns empty hits for an empty query without building an index', async () => {
    const cityPath = join(TEST_ROOT, 'city-a');
    mkdirSync(cityPath, { recursive: true });
    writeFile(join(cityPath, 'src', 'WidgetPanel.ts'));

    const api = new HttpApiFilesSearch({
      cities: [{ id: 'city-a', path: cityPath, name: 'City A' }],
      ...testApiOptions(),
    });

    await expect(api.search('', 10)).resolves.toEqual({ hits: [], warnings: [] });
    expect(api.getDiagnostics().cachedCities).toBe(0);
  });

  it('reuses one city index across different queries inside the TTL', async () => {
    const cityPath = join(TEST_ROOT, 'city-a');
    mkdirSync(join(cityPath, 'docs'), { recursive: true });
    writeFile(join(cityPath, 'src', 'WidgetPanel.ts'));
    writeFile(join(cityPath, 'docs', 'GuideBook.md'));

    const api = new HttpApiFilesSearch({
      cities: [{ id: 'city-a', path: cityPath, name: 'City A' }],
      indexTtlMs: 60_000,
      ...testApiOptions(),
    });

    const widget = await api.search('WidgetPanel', 10);
    const guide = await api.search('GuideBook', 10);

    expect(widget.hits.map((hit) => hit.relativePath)).toContain('src/WidgetPanel.ts');
    expect(guide.hits.map((hit) => hit.relativePath)).toContain('docs/GuideBook.md');

    const diagnostics = api.getDiagnostics();
    expect(diagnostics.cachedCities).toBe(1);
    expect(diagnostics.totalEntries).toBeGreaterThanOrEqual(3);
    expect(diagnostics.cities[0]).toMatchObject({
      cityId: 'city-a',
      cityName: 'City A',
      refreshCount: 1,
      truncated: false,
      timedOut: false,
      warnings: [],
      indexerKind: 'test',
    });
  });

  it('honors cityId without indexing unrelated local cities', async () => {
    const cityA = join(TEST_ROOT, 'city-a');
    const cityB = join(TEST_ROOT, 'city-b');
    writeFile(join(cityA, 'AlphaNeedle.ts'));
    writeFile(join(cityB, 'BetaNeedle.ts'));

    const api = new HttpApiFilesSearch({
      cities: [
        { id: 'city-a', path: cityA, name: 'City A' },
        { id: 'city-b', path: cityB, name: 'City B' },
      ],
      ...testApiOptions(),
    });

    const result = await api.search('Needle', 10, 'city-a');

    expect(result.hits.map((hit) => hit.relativePath)).toEqual(['AlphaNeedle.ts']);
    expect(api.getDiagnostics().cities.map((city) => city.cityId)).toEqual(['city-a']);
  });

  it('refreshes the city index after the TTL expires', async () => {
    const cityPath = join(TEST_ROOT, 'city-a');
    writeFile(join(cityPath, 'AlphaOnly.ts'));

    const api = new HttpApiFilesSearch({
      cities: [{ id: 'city-a', path: cityPath }],
      indexTtlMs: 1,
      ...testApiOptions(),
    });

    await expect(api.search('AlphaOnly', 10)).resolves.toMatchObject({
      hits: [expect.objectContaining({ relativePath: 'AlphaOnly.ts' })],
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    writeFile(join(cityPath, 'BetaOnly.ts'));

    const beta = await api.search('BetaOnly', 10);

    expect(beta.hits.map((hit) => hit.relativePath)).toContain('BetaOnly.ts');
    expect(api.getDiagnostics().cities[0].refreshCount).toBe(2);
  });

  it('does not index ignored heavyweight directories', async () => {
    const cityPath = join(TEST_ROOT, 'city-a');
    writeFile(join(cityPath, 'node_modules', 'IgnoredWidget.ts'));
    writeFile(join(cityPath, 'src', 'RealWidget.ts'));

    const api = new HttpApiFilesSearch({
      cities: [{ id: 'city-a', path: cityPath }],
      ...testApiOptions(),
    });

    const ignored = await api.search('IgnoredWidget', 10);
    const real = await api.search('RealWidget', 10);

    expect(ignored.hits).toEqual([]);
    expect(real.hits.map((hit) => hit.relativePath)).toContain('src/RealWidget.ts');
  });

  it('surfaces truncation in warnings and diagnostics', async () => {
    const cityPath = join(TEST_ROOT, 'city-a');
    writeFile(join(cityPath, 'file-match-0.ts'));
    writeFile(join(cityPath, 'file-match-1.ts'));
    writeFile(join(cityPath, 'file-match-2.ts'));

    const api = new HttpApiFilesSearch({
      cities: [{ id: 'city-a', path: cityPath }],
      maxIndexedEntriesPerCity: 1,
      ...testApiOptions(),
    });

    const result = await api.search('file-match', 10);

    expect(result.warnings).toEqual([
      { cityId: 'city-a', message: 'index truncated at 1 entries' },
    ]);
    expect(api.getDiagnostics().cities[0]).toMatchObject({
      entries: 1,
      truncated: true,
      warnings: ['index truncated at 1 entries'],
    });
  });

  it('surfaces timeout warnings without claiming partial entries', async () => {
    const cityPath = join(TEST_ROOT, 'city-a');
    writeFile(join(cityPath, 'SlowWidget.ts'));
    const timedOutWalker: CityIndexWalker = async (): Promise<FileWalkResult> => ({
      entries: [],
      truncated: false,
      timedOut: true,
      stderr: '',
    });

    const api = new HttpApiFilesSearch({
      cities: [{ id: 'city-a', path: cityPath }],
      walkCityIndex: timedOutWalker,
      indexerKind: 'timeout-test',
    });

    const result = await api.search('SlowWidget', 10);

    expect(result.hits).toEqual([]);
    expect(result.warnings).toEqual([
      { cityId: 'city-a', message: 'index refresh timed out before returning entries' },
    ]);
    expect(api.getDiagnostics().cities[0]).toMatchObject({
      timedOut: true,
      warnings: ['index refresh timed out before returning entries'],
    });
  });

  it('keeps stale entries when a refresh fails after a cached index expires', async () => {
    const cityPath = join(TEST_ROOT, 'city-a');
    writeFile(join(cityPath, 'CachedWidget.ts'));
    let shouldFail = false;
    const flakyWalker: CityIndexWalker = async (path, maxEntries, timeoutMs) => {
      if (shouldFail) throw new Error('indexer missing');
      return testWalkCityIndex(path, maxEntries, timeoutMs);
    };

    const api = new HttpApiFilesSearch({
      cities: [{ id: 'city-a', path: cityPath }],
      indexTtlMs: 1,
      walkCityIndex: flakyWalker,
      indexerKind: 'flaky-test',
    });

    await expect(api.search('CachedWidget', 10)).resolves.toMatchObject({
      hits: [expect.objectContaining({ relativePath: 'CachedWidget.ts' })],
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    shouldFail = true;

    const result = await api.search('CachedWidget', 10);

    expect(result.hits.map((hit) => hit.relativePath)).toEqual(['CachedWidget.ts']);
    expect(result.warnings).toEqual([
      {
        cityId: 'city-a',
        message: 'index refresh failed; showing stale entries: indexer missing',
      },
    ]);
  });
});
