/**
 * CityPersistence - Persist cities across sessions
 *
 * Cities are stored in ~/.portolan/cities.json
 * Persisted cities survive session restarts and can be added/removed from frontend.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';

// ============================================================================
// Types
// ============================================================================

export interface HexCoord {
  q: number;
  r: number;
}

export interface PersistedCity {
  id: string;
  path: string;         // Absolute filesystem path
  name: string;         // Display name
  position: HexCoord;   // Persisted position is authoritative
  originId: string;     // 'local' or 'remote-{hostname}'
  sshHost?: string;     // SSH config name for remote cities (e.g., 'candide')
  pinnedAt: number;     // Timestamp when persisted
}

interface PersistenceFile {
  version: 1;
  cities: PersistedCity[];
}

// ============================================================================
// CityPersistence
// ============================================================================

export class CityPersistence {
  private readonly dataDir: string;
  private readonly filePath: string;
  private cities: Map<string, PersistedCity> = new Map(); // key = `${originId}:${path}`

  constructor() {
    this.dataDir = join(homedir(), '.portolan');
    this.filePath = join(this.dataDir, 'cities.json');
  }

  /**
   * Make city key from originId and path
   */
  private makeKey(originId: string, path: string): string {
    return `${originId}:${resolve(path)}`;
  }

  /**
   * Load persisted cities from disk
   */
  load(): PersistedCity[] {
    this.cities.clear();

    if (!existsSync(this.filePath)) {
      return [];
    }

    try {
      const content = readFileSync(this.filePath, 'utf-8');
      const data: PersistenceFile = JSON.parse(content);

      if (data.version !== 1) {
        console.warn(`Unknown cities.json version: ${data.version}`);
        return [];
      }

      for (const city of data.cities) {
        const key = this.makeKey(city.originId, city.path);
        this.cities.set(key, city);
      }

      console.log(`Loaded ${this.cities.size} persisted cities`);
      return this.getCities();
    } catch (error) {
      console.error('Failed to load persisted cities:', error);
      return [];
    }
  }

  /**
   * Save persisted cities to disk (atomic write)
   */
  private save(): void {
    // Ensure directory exists
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    const data: PersistenceFile = {
      version: 1,
      cities: this.getCities(),
    };

    const tmpPath = this.filePath + '.tmp';

    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      renameSync(tmpPath, this.filePath);
    } catch (error) {
      console.error('Failed to save persisted cities:', error);
      throw error;
    }
  }

  /**
   * Get all persisted cities
   */
  getCities(): PersistedCity[] {
    return [...this.cities.values()];
  }

  /**
   * Get persisted city by path and origin
   */
  getCity(path: string, originId: string = 'local'): PersistedCity | null {
    const key = this.makeKey(originId, path);
    return this.cities.get(key) || null;
  }

  /**
   * Get persisted city by ID
   */
  getCityById(id: string): PersistedCity | null {
    for (const city of this.cities.values()) {
      if (city.id === id) {
        return city;
      }
    }
    return null;
  }

  /**
   * Pin a city to persistence
   * If city already exists at path, updates position
   */
  pin(
    path: string,
    position: HexCoord,
    originId: string = 'local',
    name?: string,
    sshHost?: string
  ): PersistedCity {
    const resolvedPath = resolve(path);
    const key = this.makeKey(originId, resolvedPath);
    const existing = this.cities.get(key);

    if (existing) {
      // Update position and name if changed
      existing.position = position;
      if (name) existing.name = name;
      if (sshHost) existing.sshHost = sshHost;
      this.save();
      return existing;
    }

    // Create new persisted city
    const city: PersistedCity = {
      id: randomUUID(),
      path: resolvedPath,
      name: name || resolvedPath.split('/').pop() || resolvedPath,
      position,
      originId,
      sshHost,
      pinnedAt: Date.now(),
    };

    this.cities.set(key, city);
    this.save();
    console.log(`Pinned city: ${city.name} at (${position.q}, ${position.r})${sshHost ? ` (ssh: ${sshHost})` : ''}`);
    return city;
  }

  /**
   * Unpin a city from persistence by ID
   * Returns the unpinned city or null if not found
   */
  unpin(cityId: string): PersistedCity | null {
    for (const [key, city] of this.cities) {
      if (city.id === cityId) {
        this.cities.delete(key);
        this.save();
        console.log(`Unpinned city: ${city.name}`);
        return city;
      }
    }
    return null;
  }

  /**
   * Update position for a persisted city by ID
   * Returns the updated city or null if not found
   */
  updatePosition(cityId: string, newPosition: HexCoord): PersistedCity | null {
    for (const city of this.cities.values()) {
      if (city.id === cityId) {
        city.position = newPosition;
        this.save();
        console.log(`Moved city: ${city.name} to (${newPosition.q}, ${newPosition.r})`);
        return city;
      }
    }
    return null;
  }

  /**
   * Check if a city is persisted by path and origin
   */
  isPinned(path: string, originId: string = 'local'): boolean {
    const key = this.makeKey(originId, resolve(path));
    return this.cities.has(key);
  }

  /**
   * Check if a city is persisted by ID
   */
  isPinnedById(id: string): boolean {
    return this.getCityById(id) !== null;
  }
}
