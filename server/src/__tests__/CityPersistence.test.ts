import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CityPersistence } from '../CityPersistence.js';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Use a test-specific directory
const TEST_DIR = join(homedir(), '.portolan-test');
const TEST_FILE = join(TEST_DIR, 'cities.json');

describe('CityPersistence', () => {
  let persistence: CityPersistence;

  beforeEach(() => {
    // Create test directory
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }

    // Create persistence instance with mocked paths
    persistence = new CityPersistence();
    // Override the internal paths for testing
    (persistence as unknown as { dataDir: string }).dataDir = TEST_DIR;
    (persistence as unknown as { filePath: string }).filePath = TEST_FILE;
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('load', () => {
    it('should return empty array when file does not exist', () => {
      const cities = persistence.load();
      expect(cities).toEqual([]);
    });

    it('should load cities from valid file', () => {
      // Write test data
      const testData = {
        version: 1,
        cities: [
          {
            id: 'test-id-1',
            path: '/test/path',
            name: 'Test City',
            position: { q: 0, r: 0 },
            originId: 'local',
            pinnedAt: 12345,
          },
        ],
      };
      mkdirSync(TEST_DIR, { recursive: true });
      require('fs').writeFileSync(TEST_FILE, JSON.stringify(testData));

      const cities = persistence.load();
      expect(cities).toHaveLength(1);
      expect(cities[0].name).toBe('Test City');
      expect(cities[0].id).toBe('test-id-1');
    });

    it('should return empty array for invalid JSON', () => {
      mkdirSync(TEST_DIR, { recursive: true });
      require('fs').writeFileSync(TEST_FILE, 'not valid json');

      const cities = persistence.load();
      expect(cities).toEqual([]);
    });
  });

  describe('pin', () => {
    it('should create new pinned city', () => {
      const city = persistence.pin('/new/path', { q: 1, r: 2 }, 'local', 'New City');

      expect(city.path).toBe('/new/path');
      expect(city.name).toBe('New City');
      expect(city.position).toEqual({ q: 1, r: 2 });
      expect(city.originId).toBe('local');
      expect(city.id).toBeDefined();
      expect(city.pinnedAt).toBeGreaterThan(0);
    });

    it('should persist city to disk', () => {
      persistence.pin('/test/path', { q: 0, r: 0 }, 'local', 'Test');

      expect(existsSync(TEST_FILE)).toBe(true);
      const data = JSON.parse(readFileSync(TEST_FILE, 'utf-8'));
      expect(data.version).toBe(1);
      expect(data.cities).toHaveLength(1);
      expect(data.cities[0].name).toBe('Test');
    });

    it('should update existing city at same path', () => {
      persistence.pin('/test/path', { q: 0, r: 0 }, 'local', 'First');
      const city = persistence.pin('/test/path', { q: 5, r: 5 }, 'local', 'Updated');

      const cities = persistence.getCities();
      expect(cities).toHaveLength(1);
      expect(cities[0].name).toBe('Updated');
      expect(cities[0].position).toEqual({ q: 5, r: 5 });
    });

    it('should default name to basename of path', () => {
      const city = persistence.pin('/some/long/project-name', { q: 0, r: 0 });
      expect(city.name).toBe('project-name');
    });
  });

  describe('unpin', () => {
    it('should remove city by ID', () => {
      const city = persistence.pin('/test/path', { q: 0, r: 0 });
      expect(persistence.getCities()).toHaveLength(1);

      const removed = persistence.unpin(city.id);
      expect(removed).not.toBeNull();
      expect(removed?.id).toBe(city.id);
      expect(persistence.getCities()).toHaveLength(0);
    });

    it('should return null for unknown ID', () => {
      const result = persistence.unpin('unknown-id');
      expect(result).toBeNull();
    });

    it('should persist removal to disk', () => {
      const city = persistence.pin('/test/path', { q: 0, r: 0 });
      persistence.unpin(city.id);

      const data = JSON.parse(readFileSync(TEST_FILE, 'utf-8'));
      expect(data.cities).toHaveLength(0);
    });
  });

  describe('getCity', () => {
    it('should find city by path and origin', () => {
      persistence.pin('/test/path', { q: 0, r: 0 }, 'local', 'Test');

      const city = persistence.getCity('/test/path', 'local');
      expect(city).not.toBeNull();
      expect(city?.name).toBe('Test');
    });

    it('should return null for unknown path', () => {
      const city = persistence.getCity('/unknown/path');
      expect(city).toBeNull();
    });

    it('should distinguish by origin', () => {
      persistence.pin('/test/path', { q: 0, r: 0 }, 'local', 'Local');
      persistence.pin('/test/path', { q: 1, r: 1 }, 'remote-host', 'Remote');

      const local = persistence.getCity('/test/path', 'local');
      const remote = persistence.getCity('/test/path', 'remote-host');

      expect(local?.name).toBe('Local');
      expect(remote?.name).toBe('Remote');
    });
  });

  describe('getCityById', () => {
    it('should find city by ID', () => {
      const city = persistence.pin('/test/path', { q: 0, r: 0 }, 'local', 'Test');
      const found = persistence.getCityById(city.id);
      expect(found).toEqual(city);
    });

    it('should return null for unknown ID', () => {
      const found = persistence.getCityById('unknown');
      expect(found).toBeNull();
    });
  });

  describe('isPinned', () => {
    it('should return true for pinned city', () => {
      persistence.pin('/test/path', { q: 0, r: 0 });
      expect(persistence.isPinned('/test/path', 'local')).toBe(true);
    });

    it('should return false for unpinned city', () => {
      expect(persistence.isPinned('/unknown/path')).toBe(false);
    });
  });

  describe('isPinnedById', () => {
    it('should return true for pinned city', () => {
      const city = persistence.pin('/test/path', { q: 0, r: 0 });
      expect(persistence.isPinnedById(city.id)).toBe(true);
    });

    it('should return false after unpinning', () => {
      const city = persistence.pin('/test/path', { q: 0, r: 0 });
      persistence.unpin(city.id);
      expect(persistence.isPinnedById(city.id)).toBe(false);
    });
  });
});
