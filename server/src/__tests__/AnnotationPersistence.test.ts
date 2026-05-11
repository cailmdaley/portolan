import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AnnotationPersistence, Annotation } from '../AnnotationPersistence.js';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { makePersistence as _makePersistence } from './test-utils.js';

const TEST_DIR = join(homedir(), '.portolan-test-annotations');
const TEST_FILE = join(TEST_DIR, 'annotations.json');

function makePersistence(): AnnotationPersistence {
  return _makePersistence(TEST_DIR, TEST_FILE);
}

/** Helper: minimal file annotation input */
function fileAnnotation(overrides: Partial<Omit<Annotation, 'id' | 'createdAt'>> = {}) {
  return {
    originId: 'local',
    comment: 'test comment',
    filePath: '/test/file.ts',
    from: 0,
    to: 10,
    line: 1,
    originalText: 'hello world',
    ...overrides,
  } as Omit<Annotation, 'id' | 'createdAt'>;
}

/** Helper: minimal claim annotation input */
function claimAnnotation(overrides: Partial<Omit<Annotation, 'id' | 'createdAt'>> = {}) {
  return {
    originId: 'local',
    comment: 'claim feedback',
    isClaimAnnotation: true,
    claimId: 'claim-abc-123',
    claimTitle: 'B-modes consistent with zero',
    ...overrides,
  } as Omit<Annotation, 'id' | 'createdAt'>;
}

describe('AnnotationPersistence', () => {
  let persistence: AnnotationPersistence;

  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
    persistence = makePersistence();
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  // ────────────────────────────────────────────────────────────
  // load
  // ────────────────────────────────────────────────────────────

  describe('load', () => {
    it('returns empty array when file does not exist', () => {
      const result = persistence.load();
      expect(result).toEqual([]);
    });

    it('loads annotations from valid file', () => {
      const testData = {
        version: 1,
        annotations: [
          {
            id: 'ann-1',
            originId: 'local',
            comment: 'first',
            createdAt: 1000,
            filePath: '/test/file.ts',
            from: 0,
            to: 5,
          },
        ],
      };
      writeFileSync(TEST_FILE, JSON.stringify(testData));

      const result = persistence.load();
      expect(result).toHaveLength(1);
      expect(result[0].comment).toBe('first');
    });

    it('returns empty for unknown version', () => {
      writeFileSync(TEST_FILE, JSON.stringify({ version: 99, annotations: [] }));
      const result = persistence.load();
      expect(result).toEqual([]);
    });

    it('returns empty for invalid JSON', () => {
      writeFileSync(TEST_FILE, 'not json');
      const result = persistence.load();
      expect(result).toEqual([]);
    });

    it('loads annotation history', () => {
      const testData = {
        version: 1,
        annotations: [],
        annotationHistory: [
          { filePath: '/old/file.ts', originId: 'local', lastAnnotatedAt: 500 },
        ],
      };
      writeFileSync(TEST_FILE, JSON.stringify(testData));
      persistence.load();

      // History appears in getRecentFiles even with 0 current annotations
      const recent = persistence.getRecentFiles('local');
      expect(recent).toHaveLength(1);
      expect(recent[0].annotationCount).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────
  // add — file annotations
  // ────────────────────────────────────────────────────────────

  describe('add (file annotations)', () => {
    it('creates annotation with id and timestamp', () => {
      persistence.load();
      const ann = persistence.add(fileAnnotation());

      expect(ann.id).toBeDefined();
      expect(ann.createdAt).toBeGreaterThan(0);
      expect(ann.comment).toBe('test comment');
      expect(ann.filePath).toBeDefined();
    });

    it('resolves file path', () => {
      persistence.load();
      const ann = persistence.add(fileAnnotation({ filePath: './relative/file.ts' }));
      // Should be resolved to absolute
      expect(ann.filePath).not.toContain('./');
    });

    it('preserves fiber slug as-is (no path resolution)', () => {
      // A fiber slug like "loom" or "card-redesign/chrome-aesthetic-reframe"
      // is not a file path. Resolving it would turn "loom" into "/cwd/loom",
      // breaking strict-equality lookups against the slug downstream — most
      // visibly NarrativeAnnotationActionsBar's `a.filePath === currentSlug`
      // filter, which is the gate that decides whether the bulk-action
      // (Send/Clear sent/Fiber) bar appears on a fiber page.
      persistence.load();
      const slugAnn = persistence.add(fileAnnotation({ filePath: 'loom' }));
      expect(slugAnn.filePath).toBe('loom');

      const nestedAnn = persistence.add(
        fileAnnotation({ filePath: 'card-redesign/chrome-aesthetic-reframe' }),
      );
      expect(nestedAnn.filePath).toBe('card-redesign/chrome-aesthetic-reframe');
    });

    it('persists to disk', () => {
      persistence.load();
      persistence.add(fileAnnotation());

      expect(existsSync(TEST_FILE)).toBe(true);
      const data = JSON.parse(readFileSync(TEST_FILE, 'utf-8'));
      expect(data.version).toBe(1);
      expect(data.annotations).toHaveLength(1);
    });

    it('persists deletion intent for strikethrough annotations', () => {
      persistence.load();
      persistence.add(fileAnnotation({ intent: 'delete', comment: 'delete' }));

      const data = JSON.parse(readFileSync(TEST_FILE, 'utf-8'));
      expect(data.annotations[0].intent).toBe('delete');
    });

    it('updates annotation history for file annotations', () => {
      persistence.load();
      persistence.add(fileAnnotation({ filePath: '/project/main.ts' }));

      const data = JSON.parse(readFileSync(TEST_FILE, 'utf-8'));
      expect(data.annotationHistory).toHaveLength(1);
      expect(data.annotationHistory[0].filePath).toBe('/project/main.ts');
    });
  });

  // ────────────────────────────────────────────────────────────
  // add — claim annotations
  // ────────────────────────────────────────────────────────────

  describe('add (claim annotations)', () => {
    it('creates claim annotation with correct fields', () => {
      persistence.load();
      const ann = persistence.add(claimAnnotation());

      expect(ann.id).toBeDefined();
      expect(ann.isClaimAnnotation).toBe(true);
      expect(ann.claimId).toBe('claim-abc-123');
      expect(ann.claimTitle).toBe('B-modes consistent with zero');
      expect(ann.comment).toBe('claim feedback');
    });

    it('does not resolve file path for claims', () => {
      persistence.load();
      const ann = persistence.add(claimAnnotation());
      expect(ann.filePath).toBeUndefined();
    });

    it('does not update annotation history for claims', () => {
      persistence.load();
      persistence.add(claimAnnotation());

      const data = JSON.parse(readFileSync(TEST_FILE, 'utf-8'));
      expect(data.annotationHistory).toHaveLength(0);
    });

    it('stores image annotation fields for claims', () => {
      persistence.load();
      const ann = persistence.add(claimAnnotation({
        artifact: 'b_modes.png',
        x: 45.2,
        y: 31.8,
        isImageAnnotation: true,
      }));

      expect(ann.artifact).toBe('b_modes.png');
      expect(ann.x).toBe(45.2);
      expect(ann.y).toBe(31.8);
    });

    it('stores selectedText for text annotations', () => {
      persistence.load();
      const ann = persistence.add(claimAnnotation({
        selectedText: 'PTE 0.29',
      }));

      expect(ann.selectedText).toBe('PTE 0.29');
    });
  });

  // ────────────────────────────────────────────────────────────
  // getByClaimId
  // ────────────────────────────────────────────────────────────

  describe('getByClaimId', () => {
    it('returns annotations for matching claim', () => {
      persistence.load();
      persistence.add(claimAnnotation({ claimId: 'claim-1', comment: 'first' }));
      persistence.add(claimAnnotation({ claimId: 'claim-1', comment: 'second' }));
      persistence.add(claimAnnotation({ claimId: 'claim-2', comment: 'other' }));

      const result = persistence.getByClaimId('claim-1');
      expect(result).toHaveLength(2);
      expect(result.map(a => a.comment)).toContain('first');
      expect(result.map(a => a.comment)).toContain('second');
    });

    it('returns empty array for unknown claim', () => {
      persistence.load();
      persistence.add(claimAnnotation({ claimId: 'claim-1' }));

      const result = persistence.getByClaimId('unknown');
      expect(result).toEqual([]);
    });

    it('only returns claim annotations, not file annotations', () => {
      persistence.load();
      persistence.add(fileAnnotation());
      persistence.add(claimAnnotation({ claimId: 'claim-1' }));

      const result = persistence.getByClaimId('claim-1');
      expect(result).toHaveLength(1);
      expect(result[0].isClaimAnnotation).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────
  // getAllClaims
  // ────────────────────────────────────────────────────────────

  describe('getAllClaims', () => {
    it('returns all claims annotations', () => {
      persistence.load();
      persistence.add(claimAnnotation({ claimId: 'c1', comment: 'first' }));
      persistence.add(claimAnnotation({ claimId: 'c2', comment: 'second' }));
      persistence.add(fileAnnotation({ comment: 'file only' }));

      const result = persistence.getAllClaims();
      expect(result).toHaveLength(2);
      expect(result.every(a => a.isClaimAnnotation)).toBe(true);
    });

    it('returns empty array when no claims exist', () => {
      persistence.load();
      persistence.add(fileAnnotation());

      expect(persistence.getAllClaims()).toHaveLength(0);
    });
  });

  // ────────────────────────────────────────────────────────────
  // getByFile
  // ────────────────────────────────────────────────────────────

  describe('getByFile', () => {
    it('returns annotations for matching file', () => {
      persistence.load();
      persistence.add(fileAnnotation({ filePath: '/a/file.ts', comment: 'a' }));
      persistence.add(fileAnnotation({ filePath: '/b/file.ts', comment: 'b' }));

      const result = persistence.getByFile('/a/file.ts', 'local');
      expect(result).toHaveLength(1);
      expect(result[0].comment).toBe('a');
    });

    it('distinguishes by originId', () => {
      persistence.load();
      persistence.add(fileAnnotation({ filePath: '/file.ts', originId: 'local', comment: 'local' }));
      persistence.add(fileAnnotation({ filePath: '/file.ts', originId: 'remote-host', comment: 'remote' }));

      expect(persistence.getByFile('/file.ts', 'local')).toHaveLength(1);
      expect(persistence.getByFile('/file.ts', 'remote-host')).toHaveLength(1);
    });

    it('does not return claim annotations', () => {
      persistence.load();
      persistence.add(claimAnnotation());
      persistence.add(fileAnnotation({ filePath: '/file.ts' }));

      const result = persistence.getByFile('/file.ts', 'local');
      expect(result).toHaveLength(1);
      expect(result[0].isClaimAnnotation).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────────────
  // update
  // ────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates annotation fields', () => {
      persistence.load();
      const ann = persistence.add(claimAnnotation({ comment: 'original' }));

      const updated = persistence.update(ann.id, { comment: 'revised' });
      expect(updated?.comment).toBe('revised');
      expect(updated?.claimId).toBe('claim-abc-123'); // unchanged
    });

    it('returns null for unknown id', () => {
      persistence.load();
      const result = persistence.update('unknown-id', { comment: 'x' });
      expect(result).toBeNull();
    });

    it('persists update to disk', () => {
      persistence.load();
      const ann = persistence.add(claimAnnotation({ comment: 'original' }));
      persistence.update(ann.id, { comment: 'revised' });

      const data = JSON.parse(readFileSync(TEST_FILE, 'utf-8'));
      expect(data.annotations[0].comment).toBe('revised');
    });
  });

  // ────────────────────────────────────────────────────────────
  // delete
  // ────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('removes annotation', () => {
      persistence.load();
      const ann = persistence.add(claimAnnotation());

      const deleted = persistence.delete(ann.id);
      expect(deleted?.id).toBe(ann.id);
      expect(persistence.getAll()).toHaveLength(0);
    });

    it('returns null for unknown id', () => {
      persistence.load();
      const result = persistence.delete('unknown-id');
      expect(result).toBeNull();
    });

    it('persists deletion to disk', () => {
      persistence.load();
      const ann = persistence.add(claimAnnotation());
      persistence.delete(ann.id);

      const data = JSON.parse(readFileSync(TEST_FILE, 'utf-8'));
      expect(data.annotations).toHaveLength(0);
    });

    it('preserves annotation history after deletion (file annotations)', () => {
      persistence.load();
      const ann = persistence.add(fileAnnotation({ filePath: '/project/main.ts' }));
      persistence.delete(ann.id);

      const data = JSON.parse(readFileSync(TEST_FILE, 'utf-8'));
      expect(data.annotations).toHaveLength(0);
      expect(data.annotationHistory).toHaveLength(1);
      expect(data.annotationHistory[0].filePath).toBe('/project/main.ts');
    });
  });

  // ────────────────────────────────────────────────────────────
  // getRecentFiles
  // ────────────────────────────────────────────────────────────

  describe('getRecentFiles', () => {
    it('returns files sorted by most recent', () => {
      // Pre-seed with controlled timestamps to avoid sub-ms race
      const testData = {
        version: 1,
        annotations: [
          { id: 'old', originId: 'local', comment: 'old', createdAt: 1000, filePath: '/old.ts', from: 0, to: 5 },
          { id: 'new', originId: 'local', comment: 'new', createdAt: 2000, filePath: '/new.ts', from: 0, to: 5 },
        ],
      };
      writeFileSync(TEST_FILE, JSON.stringify(testData));
      persistence.load();

      const recent = persistence.getRecentFiles();
      expect(recent).toHaveLength(2);
      // Most recent first
      expect(recent[0].filePath).toBe('/new.ts');
    });

    it('groups annotations by file', () => {
      persistence.load();
      persistence.add(fileAnnotation({ filePath: '/file.ts', comment: 'a' }));
      persistence.add(fileAnnotation({ filePath: '/file.ts', comment: 'b' }));

      const recent = persistence.getRecentFiles();
      expect(recent).toHaveLength(1);
      expect(recent[0].annotationCount).toBe(2);
    });

    it('filters by originId', () => {
      persistence.load();
      persistence.add(fileAnnotation({ filePath: '/local.ts', originId: 'local' }));
      persistence.add(fileAnnotation({ filePath: '/remote.ts', originId: 'remote-host' }));

      const local = persistence.getRecentFiles('local');
      expect(local).toHaveLength(1);
      expect(local[0].filePath).toBe('/local.ts');
    });

    it('respects limit', () => {
      persistence.load();
      for (let i = 0; i < 5; i++) {
        persistence.add(fileAnnotation({ filePath: `/file${i}.ts` }));
      }

      const recent = persistence.getRecentFiles(undefined, 3);
      expect(recent).toHaveLength(3);
    });

    it('excludes claim annotations', () => {
      persistence.load();
      persistence.add(claimAnnotation());
      persistence.add(fileAnnotation({ filePath: '/file.ts' }));

      const recent = persistence.getRecentFiles();
      expect(recent).toHaveLength(1);
      expect(recent[0].filePath).toBe('/file.ts');
    });

    it('fills remaining slots with history', () => {
      persistence.load();
      // Add and delete — leaves history entry
      const ann = persistence.add(fileAnnotation({ filePath: '/deleted.ts' }));
      persistence.delete(ann.id);
      // Add a current one
      persistence.add(fileAnnotation({ filePath: '/current.ts' }));

      const recent = persistence.getRecentFiles(undefined, 10);
      expect(recent).toHaveLength(2);
      expect(recent[0].filePath).toBe('/current.ts');
      expect(recent[0].annotationCount).toBe(1);
      expect(recent[1].filePath).toBe('/deleted.ts');
      expect(recent[1].annotationCount).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────
  // getAll
  // ────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns both file and claim annotations', () => {
      persistence.load();
      persistence.add(fileAnnotation());
      persistence.add(claimAnnotation());

      const all = persistence.getAll();
      expect(all).toHaveLength(2);
    });
  });

  // ────────────────────────────────────────────────────────────
  // round-trip: save + load
  // ────────────────────────────────────────────────────────────

  describe('round-trip persistence', () => {
    it('claim annotations survive save/load cycle', () => {
      persistence.load();
      persistence.add(claimAnnotation({
        claimId: 'claim-rt',
        claimTitle: 'Round Trip Claim',
        selectedText: 'PTE 0.29',
        comment: 'recheck',
      }));

      // Fresh persistence instance
      const p2 = makePersistence();
      const loaded = p2.load();

      expect(loaded).toHaveLength(1);
      expect(loaded[0].isClaimAnnotation).toBe(true);
      expect(loaded[0].claimId).toBe('claim-rt');
      expect(loaded[0].claimTitle).toBe('Round Trip Claim');
      expect(loaded[0].selectedText).toBe('PTE 0.29');
    });

    it('image claim annotations survive save/load cycle', () => {
      persistence.load();
      persistence.add(claimAnnotation({
        claimId: 'claim-img',
        artifact: 'spectrum.png',
        x: 72.5,
        y: 14.3,
        isImageAnnotation: true,
        comment: 'check edge effects',
      }));

      const p2 = makePersistence();
      const loaded = p2.load();

      expect(loaded).toHaveLength(1);
      expect(loaded[0].artifact).toBe('spectrum.png');
      expect(loaded[0].x).toBe(72.5);
      expect(loaded[0].y).toBe(14.3);
    });

    it('mixed file and claim annotations survive round-trip', () => {
      persistence.load();
      persistence.add(fileAnnotation({ filePath: '/file.ts', comment: 'file note' }));
      persistence.add(claimAnnotation({ claimId: 'c1', comment: 'claim note' }));

      const p2 = makePersistence();
      const loaded = p2.load();

      expect(loaded).toHaveLength(2);
      const fileAnns = loaded.filter(a => !a.isClaimAnnotation);
      const claimAnns = loaded.filter(a => a.isClaimAnnotation);
      expect(fileAnns).toHaveLength(1);
      expect(claimAnns).toHaveLength(1);
    });
  });
});
