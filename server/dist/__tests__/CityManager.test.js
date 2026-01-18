import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CityManager } from '../CityManager.js';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
describe('CityManager', () => {
    let cityManager;
    let testConfigDir;
    beforeEach(() => {
        // Create temporary config directory for testing
        testConfigDir = join(tmpdir(), `hexarchy-test-${Date.now()}`);
        mkdirSync(testConfigDir, { recursive: true });
        // Override config directory for testing
        // Note: This requires modifying CityManager to accept configDir in constructor
        // For now, we'll test with the actual home directory and clean up after
        cityManager = new CityManager();
    });
    afterEach(() => {
        // Clean up test config directory
        if (existsSync(testConfigDir)) {
            rmSync(testConfigDir, { recursive: true, force: true });
        }
    });
    describe('addCity', () => {
        it('should add a city with explicit position', () => {
            const city = cityManager.addCity('/tmp/test-project', 'Test Project', { q: 0, r: 0 });
            expect(city.path).toBe('/tmp/test-project');
            expect(city.name).toBe('Test Project');
            expect(city.position).toEqual({ q: 0, r: 0 });
            expect(city.id).toBeDefined();
            expect(city.createdAt).toBeDefined();
            // Clean up
            cityManager.removeCity(city.id);
        });
        it('should auto-assign position when not provided', () => {
            const city1 = cityManager.addCity('/tmp/test1');
            expect(city1.position).toEqual({ q: 0, r: 0 });
            const city2 = cityManager.addCity('/tmp/test2');
            // Should be at least 3 tiles away from city1
            const distance = hexDistance(city1.position, city2.position);
            expect(distance).toBeGreaterThanOrEqual(3);
            // Clean up
            cityManager.removeCity(city1.id);
            cityManager.removeCity(city2.id);
        });
        it('should use basename as default name', () => {
            const city = cityManager.addCity('/tmp/my-awesome-project');
            expect(city.name).toBe('my-awesome-project');
            cityManager.removeCity(city.id);
        });
        it('should reject duplicate paths', () => {
            const city = cityManager.addCity('/tmp/duplicate-test');
            expect(() => {
                cityManager.addCity('/tmp/duplicate-test');
            }).toThrow('City already exists at path');
            cityManager.removeCity(city.id);
        });
        it('should reject positions too close to existing cities', () => {
            const city1 = cityManager.addCity('/tmp/city1', 'City 1', { q: 0, r: 0 });
            // Try to add city only 2 tiles away (minimum is 3)
            expect(() => {
                cityManager.addCity('/tmp/city2', 'City 2', { q: 2, r: 0 });
            }).toThrow('Position must be at least 3 tiles away');
            // This should work (3 tiles away)
            const city2 = cityManager.addCity('/tmp/city2', 'City 2', { q: 3, r: 0 });
            expect(city2.position).toEqual({ q: 3, r: 0 });
            cityManager.removeCity(city1.id);
            cityManager.removeCity(city2.id);
        });
    });
    describe('removeCity', () => {
        it('should remove a city by ID', () => {
            const city = cityManager.addCity('/tmp/to-remove');
            const cityId = city.id;
            cityManager.removeCity(cityId);
            const cities = cityManager.getCities();
            expect(cities.find(c => c.id === cityId)).toBeUndefined();
        });
        it('should throw when removing non-existent city', () => {
            expect(() => {
                cityManager.removeCity('non-existent-id');
            }).toThrow('City not found');
        });
        it('should clear worker hexes when city is removed', () => {
            const city = cityManager.addCity('/tmp/worker-test');
            // Assign some worker hexes
            cityManager.assignWorkerHex(city.id);
            cityManager.assignWorkerHex(city.id);
            // Remove city
            cityManager.removeCity(city.id);
            // Worker hexes should be cleared (internal state)
            // We can verify by re-adding the city and checking worker assignment starts fresh
            const newCity = cityManager.addCity('/tmp/worker-test-2', 'New City', { q: 5, r: 5 });
            const firstWorker = cityManager.assignWorkerHex(newCity.id);
            // Should start at ring 1 position 0
            expect(firstWorker).toEqual({ q: 1, r: 0 });
            cityManager.removeCity(newCity.id);
        });
    });
    describe('findCityForPath', () => {
        it('should find city for exact path match', () => {
            const city = cityManager.addCity('/tmp/exact-match');
            const found = cityManager.findCityForPath('/tmp/exact-match');
            expect(found?.id).toBe(city.id);
            cityManager.removeCity(city.id);
        });
        it('should find city for nested path', () => {
            const city = cityManager.addCity('/tmp/parent');
            const found = cityManager.findCityForPath('/tmp/parent/child/grandchild');
            expect(found?.id).toBe(city.id);
            cityManager.removeCity(city.id);
        });
        it('should use longest prefix matching for nested cities', () => {
            const parentCity = cityManager.addCity('/tmp/nested-test');
            const childCity = cityManager.addCity('/tmp/nested-test/subproject', 'Subproject', { q: 5, r: 0 });
            // Should match child city (longer prefix)
            const foundChild = cityManager.findCityForPath('/tmp/nested-test/subproject/src');
            expect(foundChild?.id).toBe(childCity.id);
            // Should match parent city
            const foundParent = cityManager.findCityForPath('/tmp/nested-test/other-dir');
            expect(foundParent?.id).toBe(parentCity.id);
            cityManager.removeCity(childCity.id);
            cityManager.removeCity(parentCity.id);
        });
        it('should return null for non-matching path', () => {
            cityManager.addCity('/tmp/city1');
            const found = cityManager.findCityForPath('/var/log');
            expect(found).toBeNull();
        });
        it('should not match partial directory names', () => {
            const city = cityManager.addCity('/tmp/project');
            // Should not match '/tmp/project-other' (partial name match)
            const found = cityManager.findCityForPath('/tmp/project-other');
            expect(found).toBeNull();
            cityManager.removeCity(city.id);
        });
    });
    describe('assignWorkerHex', () => {
        it('should assign worker hexes in spiral order', () => {
            const city = cityManager.addCity('/tmp/spiral-test');
            // First 6 workers should be in ring 1
            const ring1 = [];
            for (let i = 0; i < 6; i++) {
                ring1.push(cityManager.assignWorkerHex(city.id));
            }
            // All should be distance 1 from center (0, 0)
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
            cityManager.removeCity(city.id);
        });
        it('should not assign overlapping hexes', () => {
            const city = cityManager.addCity('/tmp/overlap-test');
            const assigned = new Set();
            // Assign 20 workers
            for (let i = 0; i < 20; i++) {
                const hex = cityManager.assignWorkerHex(city.id);
                const key = `${hex.q},${hex.r}`;
                // Should not be assigned already
                expect(assigned.has(key)).toBe(false);
                assigned.add(key);
            }
            cityManager.removeCity(city.id);
        });
    });
    describe('releaseWorkerHex', () => {
        it('should release worker hex for reuse', () => {
            const city = cityManager.addCity('/tmp/release-test');
            // Assign first worker
            const hex1 = cityManager.assignWorkerHex(city.id);
            // Release it
            cityManager.releaseWorkerHex(city.id, hex1);
            // Assign again - should get same hex
            const hex2 = cityManager.assignWorkerHex(city.id);
            expect(hex2).toEqual(hex1);
            cityManager.removeCity(city.id);
        });
        it('should handle releasing non-existent hex gracefully', () => {
            const city = cityManager.addCity('/tmp/release-nonexistent');
            // Should not throw
            expect(() => {
                cityManager.releaseWorkerHex(city.id, { q: 99, r: 99 });
            }).not.toThrow();
            cityManager.removeCity(city.id);
        });
        it('should handle releasing for non-existent city gracefully', () => {
            expect(() => {
                cityManager.releaseWorkerHex('non-existent', { q: 1, r: 0 });
            }).not.toThrow();
        });
    });
    describe('getCities', () => {
        it('should return cities sorted by name', () => {
            const cityC = cityManager.addCity('/tmp/c', 'Charlie');
            const cityA = cityManager.addCity('/tmp/a', 'Alice', { q: 5, r: 0 });
            const cityB = cityManager.addCity('/tmp/b', 'Bob', { q: -5, r: 0 });
            const cities = cityManager.getCities();
            expect(cities.map(c => c.name)).toEqual(['Alice', 'Bob', 'Charlie']);
            cityManager.removeCity(cityC.id);
            cityManager.removeCity(cityA.id);
            cityManager.removeCity(cityB.id);
        });
    });
});
// Helper function to calculate hex distance (same as CityManager private method)
function hexDistance(a, b) {
    return (Math.abs(a.q - b.q) +
        Math.abs(a.q + a.r - b.q - b.r) +
        Math.abs(a.r - b.r)) / 2;
}
//# sourceMappingURL=CityManager.test.js.map