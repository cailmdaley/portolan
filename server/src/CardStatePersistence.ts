/**
 * CardStatePersistence - Persist conversation card positions/sizes across sessions
 *
 * Card states are stored in ~/.portolan/card-states.json
 * Keyed by workerId for quick lookup when opening cards.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface CardState {
  workerId: string;
  offset: { x: number; y: number };
  size?: { width: number; height: number };
  updatedAt: number;  // Timestamp for LRU cleanup
}

interface PersistenceFile {
  version: 1;
  cards: CardState[];
}

// ============================================================================
// CardStatePersistence
// ============================================================================

export class CardStatePersistence {
  private readonly dataDir: string;
  private readonly filePath: string;
  private cards: Map<string, CardState> = new Map();  // workerId -> state
  private readonly maxCards = 50;  // Limit total persisted cards

  constructor() {
    this.dataDir = join(homedir(), '.portolan');
    this.filePath = join(this.dataDir, 'card-states.json');
  }

  /**
   * Load card states from disk
   */
  load(): CardState[] {
    this.cards.clear();

    if (!existsSync(this.filePath)) {
      return [];
    }

    try {
      const content = readFileSync(this.filePath, 'utf-8');
      const data: PersistenceFile = JSON.parse(content);

      if (data.version !== 1) {
        console.warn(`[CardState] Unknown version: ${data.version}`);
        return [];
      }

      for (const card of data.cards) {
        this.cards.set(card.workerId, card);
      }

      console.log(`[CardState] Loaded ${this.cards.size} card states`);
      return this.getAll();
    } catch (error) {
      console.error('[CardState] Failed to load:', error);
      return [];
    }
  }

  /**
   * Save card states to disk (atomic write)
   */
  private save(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    // Trim to maxCards (keep most recently updated)
    this.trimOldest();

    const data: PersistenceFile = {
      version: 1,
      cards: this.getAll(),
    };

    const tmpPath = this.filePath + '.tmp';

    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      renameSync(tmpPath, this.filePath);
    } catch (error) {
      console.error('[CardState] Failed to save:', error);
    }
  }

  /**
   * Trim to maxCards by removing oldest entries
   */
  private trimOldest(): void {
    if (this.cards.size <= this.maxCards) return;

    const sorted = [...this.cards.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt);

    this.cards.clear();
    for (const card of sorted.slice(0, this.maxCards)) {
      this.cards.set(card.workerId, card);
    }
  }

  /**
   * Get all card states
   */
  getAll(): CardState[] {
    return [...this.cards.values()];
  }

  /**
   * Get card state by workerId
   */
  get(workerId: string): CardState | null {
    return this.cards.get(workerId) || null;
  }

  /**
   * Save or update card state
   */
  set(workerId: string, offset: { x: number; y: number }, size?: { width: number; height: number }): CardState {
    const state: CardState = {
      workerId,
      offset,
      size,
      updatedAt: Date.now(),
    };
    this.cards.set(workerId, state);
    this.save();
    return state;
  }

  /**
   * Delete card state
   */
  delete(workerId: string): boolean {
    const existed = this.cards.delete(workerId);
    if (existed) {
      this.save();
    }
    return existed;
  }

  /**
   * Check if card state exists
   */
  has(workerId: string): boolean {
    return this.cards.has(workerId);
  }
}
