import { describe, it, expect, beforeEach } from 'vitest';
import { CityManager, SessionInfo } from '../CityManager.js';

/** Helper to create session infos from paths (all local) */
function sessions(...paths: string[]): SessionInfo[] {
  return paths.map(cwd => ({ cwd, originId: 'local' }));
}

describe('CityManager', () => {
  let cityManager: CityManager;

  beforeEach(() => {
    cityManager = new CityManager();
  });

  describe('updateFromSessions', () => {
    it('should create cities from session cwds', () => {
      const cities = cityManager.updateFromSessions(sessions('/tmp/project1', '/tmp/project2'));

      expect(cities.length).toBe(2);
      expect(cities.map(c => c.path).sort()).toEqual(['/tmp/project1', '/tmp/project2']);
    });

    it('should use basename as city name', () => {
      cityManager.updateFromSessions(sessions('/tmp/my-awesome-project'));
      const cities = cityManager.getCities();

      expect(cities[0].name).toBe('my-awesome-project');
    });

    it('should dedupe identical cwds', () => {
      const cities = cityManager.updateFromSessions(sessions(
        '/tmp/project',
        '/tmp/project',
        '/tmp/project',
      ));

      expect(cities.length).toBe(1);
    });

    it('should remove cities when sessions disappear', () => {
      // First, create two cities
      cityManager.updateFromSessions(sessions('/tmp/project1', '/tmp/project2'));
      expect(cityManager.getCities().length).toBe(2);

      // Now update with only one session
      const cities = cityManager.updateFromSessions(sessions('/tmp/project1'));

      expect(cities.length).toBe(1);
      expect(cities[0].path).toBe('/tmp/project1');
    });

    it('should preserve city identity across updates', () => {
      cityManager.updateFromSessions(sessions('/tmp/project'));
      const firstCity = cityManager.getCities()[0];
      const firstId = firstCity.id;

      // Update with same cwd
      cityManager.updateFromSessions(sessions('/tmp/project'));
      const secondCity = cityManager.getCities()[0];

      expect(secondCity.id).toBe(firstId);
    });

    it('should maintain stable positions for existing cities', () => {
      cityManager.updateFromSessions(sessions('/tmp/project'));
      const firstPosition = cityManager.getCities()[0].position;

      // Add another session, existing city should keep position
      cityManager.updateFromSessions(sessions('/tmp/project', '/tmp/other'));
      const city = cityManager.getCities().find(c => c.path === '/tmp/project');

      expect(city?.position).toEqual(firstPosition);
    });

    it('should auto-assign positions with minimum spacing', () => {
      cityManager.updateFromSessions(sessions('/tmp/a', '/tmp/b', '/tmp/c'));
      const cities = cityManager.getCities();

      // Check all pairs are at least 3 tiles apart
      for (let i = 0; i < cities.length; i++) {
        for (let j = i + 1; j < cities.length; j++) {
          const dist = hexDistance(cities[i].position, cities[j].position);
          expect(dist).toBeGreaterThanOrEqual(3);
        }
      }
    });

    it('should set originId on created cities', () => {
      cityManager.updateFromSessions(sessions('/tmp/project'));
      const city = cityManager.getCities()[0];

      expect(city.originId).toBe('local');
    });
  });

  describe('findCityForPath', () => {
    it('should find city for exact path match', () => {
      cityManager.updateFromSessions(sessions('/tmp/exact-match'));
      const found = cityManager.findCityForPath('/tmp/exact-match');

      expect(found).not.toBeNull();
      expect(found?.path).toBe('/tmp/exact-match');
    });

    it('should return null for non-matching path', () => {
      cityManager.updateFromSessions(sessions('/tmp/project'));
      const found = cityManager.findCityForPath('/var/log');

      expect(found).toBeNull();
    });

    it('should return null for partial directory name match', () => {
      cityManager.updateFromSessions(sessions('/tmp/project'));
      // '/tmp/project-other' should NOT match '/tmp/project'
      const found = cityManager.findCityForPath('/tmp/project-other');

      expect(found).toBeNull();
    });

    it('should distinguish same path on different origins', () => {
      // Set up remote origin position
      cityManager.setOriginPosition('remote-server1', { q: 20, r: 0 });

      // Create local city
      cityManager.updateFromSessions([{ cwd: '/home/user/project', originId: 'local' }]);

      // Create remote city at same path
      cityManager.updateFromSessions([
        { cwd: '/home/user/project', originId: 'local' },
        { cwd: '/home/user/project', originId: 'remote-server1' },
      ]);

      const cities = cityManager.getCities();
      expect(cities.length).toBe(2);

      const localCity = cityManager.findCityForPath('/home/user/project', 'local');
      const remoteCity = cityManager.findCityForPath('/home/user/project', 'remote-server1');

      expect(localCity).not.toBeNull();
      expect(remoteCity).not.toBeNull();
      expect(localCity?.id).not.toBe(remoteCity?.id);
    });
  });

  describe('assignWorkerHex', () => {
    it('should assign worker hexes in spiral order', () => {
      cityManager.updateFromSessions(sessions('/tmp/project'));
      const city = cityManager.getCities()[0];

      // First 6 workers should be in ring 1 (distance 1 from origin)
      const ring1 = [];
      for (let i = 0; i < 6; i++) {
        ring1.push(cityManager.assignWorkerHex(city.id));
      }

      ring1.forEach(hex => {
        const dist = hexDistance({ q: 0, r: 0 }, hex);
        expect(dist).toBe(1);
      });

      // All should be unique
      const uniqueKeys = new Set(ring1.map(h => `${h.q},${h.r}`));
      expect(uniqueKeys.size).toBe(6);

      // 7th worker should be in ring 2
      const ring2Worker = cityManager.assignWorkerHex(city.id);
      const dist = hexDistance({ q: 0, r: 0 }, ring2Worker);
      expect(dist).toBe(2);
    });

    it('should not assign overlapping hexes', () => {
      cityManager.updateFromSessions(sessions('/tmp/project'));
      const city = cityManager.getCities()[0];

      const assigned = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const hex = cityManager.assignWorkerHex(city.id);
        const key = `${hex.q},${hex.r}`;
        expect(assigned.has(key)).toBe(false);
        assigned.add(key);
      }
    });
  });

  describe('releaseWorkerHex', () => {
    it('should release worker hex for reuse', () => {
      cityManager.updateFromSessions(sessions('/tmp/project'));
      const city = cityManager.getCities()[0];

      const hex1 = cityManager.assignWorkerHex(city.id);
      cityManager.releaseWorkerHex(city.id, hex1);
      const hex2 = cityManager.assignWorkerHex(city.id);

      expect(hex2).toEqual(hex1);
    });

    it('should handle releasing non-existent hex gracefully', () => {
      cityManager.updateFromSessions(sessions('/tmp/project'));
      const city = cityManager.getCities()[0];

      expect(() => {
        cityManager.releaseWorkerHex(city.id, { q: 99, r: 99 });
      }).not.toThrow();
    });

    it('should handle releasing for non-existent city gracefully', () => {
      expect(() => {
        cityManager.releaseWorkerHex('non-existent', { q: 1, r: 0 });
      }).not.toThrow();
    });

    it('should clear worker hexes when city is removed', () => {
      cityManager.updateFromSessions(sessions('/tmp/project'));
      const city = cityManager.getCities()[0];

      // Assign some workers
      cityManager.assignWorkerHex(city.id);
      cityManager.assignWorkerHex(city.id);

      // Remove the city by updating with empty sessions
      cityManager.updateFromSessions([]);

      // Re-add with same path — should get new city with fresh worker assignments
      cityManager.updateFromSessions(sessions('/tmp/project'));
      const newCity = cityManager.getCities()[0];

      // First worker should be at ring 1 again
      const firstWorker = cityManager.assignWorkerHex(newCity.id);
      const dist = hexDistance({ q: 0, r: 0 }, firstWorker);
      expect(dist).toBe(1);
    });
  });

  describe('getCities', () => {
    it('should return cities sorted by name', () => {
      cityManager.updateFromSessions(sessions('/tmp/charlie', '/tmp/alice', '/tmp/bob'));
      const cities = cityManager.getCities();

      expect(cities.map(c => c.name)).toEqual(['alice', 'bob', 'charlie']);
    });

    it('should return empty array when no sessions', () => {
      expect(cityManager.getCities()).toEqual([]);
    });
  });

  describe('origin positions', () => {
    it('should place cities at origin position for remote origins', () => {
      // Set remote origin position
      const remotePosition = { q: 20, r: 0 };
      cityManager.setOriginPosition('remote-server1', remotePosition);

      // Create cities for both origins
      cityManager.updateFromSessions([
        { cwd: '/tmp/local-project', originId: 'local' },
        { cwd: '/tmp/remote-project', originId: 'remote-server1' },
      ]);

      const cities = cityManager.getCities();
      const localCity = cities.find(c => c.originId === 'local');
      const remoteCity = cities.find(c => c.originId === 'remote-server1');

      // Local should be near (0,0)
      expect(localCity?.position.q).toBe(0);
      expect(localCity?.position.r).toBe(0);

      // Remote should be near (20, 0)
      expect(remoteCity?.position.q).toBe(remotePosition.q);
      expect(remoteCity?.position.r).toBe(remotePosition.r);
    });

    it('should space multiple cities from same origin', () => {
      const remotePosition = { q: 20, r: 0 };
      cityManager.setOriginPosition('remote-server1', remotePosition);

      cityManager.updateFromSessions([
        { cwd: '/tmp/a', originId: 'remote-server1' },
        { cwd: '/tmp/b', originId: 'remote-server1' },
        { cwd: '/tmp/c', originId: 'remote-server1' },
      ]);

      const cities = cityManager.getCities();

      // All cities should be at least 3 tiles apart
      for (let i = 0; i < cities.length; i++) {
        for (let j = i + 1; j < cities.length; j++) {
          const dist = hexDistance(cities[i].position, cities[j].position);
          expect(dist).toBeGreaterThanOrEqual(3);
        }
      }
    });
  });
});

// Helper function to calculate hex distance
function hexDistance(a: { q: number; r: number }, b: { q: number; r: number }): number {
  return (
    Math.abs(a.q - b.q) +
    Math.abs(a.q + a.r - b.q - b.r) +
    Math.abs(a.r - b.r)
  ) / 2;
}
