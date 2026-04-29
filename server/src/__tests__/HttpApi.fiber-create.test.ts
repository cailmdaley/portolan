/**
 * HttpApi POST /fiber/create — vellum's stash-button endpoint.
 *
 * Wraps the felt CLI to file a new fiber from a GUI form (constitution-
 * stash-button). Differs from /file-as-fiber in that the body, tags, and
 * parent path are explicit rather than synthesized from annotations.
 *
 * The integration here exercises the full HttpApi path (route → handler →
 * felt invocation) against a real felt binary on a tmpdir city. Skipped
 * when felt isn't on PATH so CI without the felt CLI installed doesn't
 * spuriously fail.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { HttpApi } from '../HttpApi.js';
import { httpRequest, makeCityLookup, stubOriginLookup, stubPersistenceLookup } from './test-utils.js';

const TEST_DIR = join(homedir(), '.portolan-test-fiber-create');
const CITY_DIR = join(TEST_DIR, 'test-city');
const FELT_DIR = join(CITY_DIR, '.felt');

/** Probe whether the felt CLI is installed; skip the test file if not. */
function feltAvailable(): boolean {
  try {
    execFileSync('felt', ['--help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skipIfNoFelt = feltAvailable() ? describe : describe.skip;

skipIfNoFelt('HttpApi — POST /fiber/create', () => {
  let api: HttpApi;

  beforeEach(() => {
    mkdirSync(FELT_DIR, { recursive: true });
    api = new HttpApi(
      makeCityLookup('test', CITY_DIR) as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('rejects requests without a title', async () => {
    const res = await httpRequest(api, 'POST', '/fiber/create', {
      originId: 'local',
      cityPath: CITY_DIR,
      title: '',
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/title/i);
  });

  it('rejects requests without a cityPath', async () => {
    const res = await httpRequest(api, 'POST', '/fiber/create', {
      originId: 'local',
      title: 'Some idea',
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/cityPath/i);
  });

  it('rejects malformed tags', async () => {
    const res = await httpRequest(api, 'POST', '/fiber/create', {
      originId: 'local',
      cityPath: CITY_DIR,
      title: 'Idea',
      tags: 'not-an-array' as any,
    });
    expect(res.status).toBe(400);
  });

  it('creates a fiber via felt add — title-only quick stash', async () => {
    const res = await httpRequest(api, 'POST', '/fiber/create', {
      originId: 'local',
      cityPath: CITY_DIR,
      title: 'Look into garden lens',
    });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    // Slug derives from the title via kebab-case.
    const expectedSlug = 'look-into-garden-lens';
    expect(res.data.slug).toBe(expectedSlug);
    const filePath = join(FELT_DIR, expectedSlug, `${expectedSlug}.md`);
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toMatch(/name: Look into garden lens/);
  });

  it('writes body, tags, and status when supplied', async () => {
    const res = await httpRequest(api, 'POST', '/fiber/create', {
      originId: 'local',
      cityPath: CITY_DIR,
      title: 'Body stash test',
      body: 'First paragraph.\n\nSecond paragraph with `code`.',
      tags: ['idea', 'vellum'],
      status: 'active',
    });
    expect(res.status).toBe(200);
    const filePath = join(FELT_DIR, 'body-stash-test', 'body-stash-test.md');
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    // Tags survived as a list.
    expect(content).toMatch(/tags:/);
    expect(content).toMatch(/idea/);
    expect(content).toMatch(/vellum/);
    // Body survived multi-paragraph + backtick.
    expect(content).toMatch(/First paragraph\./);
    expect(content).toMatch(/Second paragraph with `code`\./);
    // Status set to active rather than felt's default open.
    expect(content).toMatch(/status: active/);
  });

  it('nests under parentSlug when provided', async () => {
    // Set up a parent fiber so felt accepts the nested slug.
    execFileSync('felt', ['add', 'parent', 'Parent fiber'], { cwd: CITY_DIR, stdio: 'ignore' });

    const res = await httpRequest(api, 'POST', '/fiber/create', {
      originId: 'local',
      cityPath: CITY_DIR,
      title: 'Nested stash',
      parentSlug: 'parent',
    });
    expect(res.status).toBe(200);
    expect(res.data.slug).toBe('parent/nested-stash');
    const filePath = join(FELT_DIR, 'parent', 'nested-stash', 'nested-stash.md');
    expect(existsSync(filePath)).toBe(true);
  });

  it('falls back to a timestamp slug when title sluggifies to empty', async () => {
    const res = await httpRequest(api, 'POST', '/fiber/create', {
      originId: 'local',
      cityPath: CITY_DIR,
      title: '!!! ??? !!!',
    });
    expect(res.status).toBe(200);
    expect(res.data.slug).toMatch(/^stash-\d+$/);
  });
});
