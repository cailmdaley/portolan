/**
 * AnnotationPersistence - Persist file annotations across sessions
 *
 * Annotations are stored in ~/.hexarchy/annotations.json
 * Each annotation captures a text selection with context for re-anchoring.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';

// ============================================================================
// Types
// ============================================================================

export interface Annotation {
  id: string;
  filePath: string;        // Full file path
  originId: string;        // 'local' or 'remote-{hostname}'

  // Selection anchor
  from: number;            // char offset at creation
  to: number;
  line?: number;           // line number at 'from' (1-indexed)
  originalText: string;    // the selected text
  contextBefore: string;   // ~20 chars for re-anchoring
  contextAfter: string;    // ~20 chars for re-anchoring

  // The feedback
  comment: string;
  createdAt: number;
}

interface PersistenceFile {
  version: 1;
  annotations: Annotation[];
}

// ============================================================================
// AnnotationPersistence
// ============================================================================

export class AnnotationPersistence {
  private readonly dataDir: string;
  private readonly filePath: string;
  private annotations: Map<string, Annotation> = new Map(); // key = annotation.id

  constructor() {
    this.dataDir = join(homedir(), '.hexarchy');
    this.filePath = join(this.dataDir, 'annotations.json');
  }

  /**
   * Make file key from originId and path
   */
  private makeFileKey(originId: string, filePath: string): string {
    return `${originId}:${resolve(filePath)}`;
  }

  /**
   * Load annotations from disk
   */
  load(): Annotation[] {
    this.annotations.clear();

    if (!existsSync(this.filePath)) {
      return [];
    }

    try {
      const content = readFileSync(this.filePath, 'utf-8');
      const data: PersistenceFile = JSON.parse(content);

      if (data.version !== 1) {
        console.warn(`Unknown annotations.json version: ${data.version}`);
        return [];
      }

      for (const annotation of data.annotations) {
        this.annotations.set(annotation.id, annotation);
      }

      console.log(`Loaded ${this.annotations.size} annotations`);
      return this.getAll();
    } catch (error) {
      console.error('Failed to load annotations:', error);
      return [];
    }
  }

  /**
   * Save annotations to disk (atomic write)
   */
  private save(): void {
    // Ensure directory exists
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    const data: PersistenceFile = {
      version: 1,
      annotations: this.getAll(),
    };

    const tmpPath = this.filePath + '.tmp';

    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      renameSync(tmpPath, this.filePath);
    } catch (error) {
      console.error('Failed to save annotations:', error);
      throw error;
    }
  }

  /**
   * Get all annotations
   */
  getAll(): Annotation[] {
    return [...this.annotations.values()];
  }

  /**
   * Get annotations for a specific file
   */
  getByFile(filePath: string, originId: string = 'local'): Annotation[] {
    const fileKey = this.makeFileKey(originId, filePath);
    return this.getAll().filter(
      (a) => this.makeFileKey(a.originId, a.filePath) === fileKey
    );
  }

  /**
   * Add a new annotation
   */
  add(
    annotation: Omit<Annotation, 'id' | 'createdAt'>
  ): Annotation {
    const newAnnotation: Annotation = {
      ...annotation,
      id: randomUUID(),
      filePath: resolve(annotation.filePath),
      createdAt: Date.now(),
    };

    this.annotations.set(newAnnotation.id, newAnnotation);
    this.save();
    console.log(
      `Added annotation to ${newAnnotation.filePath} at ${newAnnotation.from}-${newAnnotation.to}`
    );
    return newAnnotation;
  }

  /**
   * Update an existing annotation
   */
  update(id: string, updates: Partial<Annotation>): Annotation | null {
    const annotation = this.annotations.get(id);
    if (!annotation) {
      return null;
    }

    // Apply updates
    Object.assign(annotation, updates);
    this.save();
    console.log(`Updated annotation ${id}`);
    return annotation;
  }

  /**
   * Delete an annotation
   */
  delete(id: string): Annotation | null {
    const annotation = this.annotations.get(id);
    if (!annotation) {
      return null;
    }

    this.annotations.delete(id);
    this.save();
    console.log(`Deleted annotation ${id}`);
    return annotation;
  }

  /**
   * Get recently annotated files, grouped by file with most recent annotation time
   * Optionally filter by originId to show only files for a specific city
   */
  getRecentFiles(originId?: string, limit: number = 10): Array<{
    filePath: string;
    originId: string;
    annotationCount: number;
    mostRecentAt: number;
  }> {
    // Group annotations by file
    const fileMap = new Map<string, {
      filePath: string;
      originId: string;
      count: number;
      mostRecentAt: number;
    }>();

    for (const annotation of this.annotations.values()) {
      // Filter by originId if provided
      if (originId && annotation.originId !== originId) {
        continue;
      }

      const key = this.makeFileKey(annotation.originId, annotation.filePath);
      const existing = fileMap.get(key);

      if (existing) {
        existing.count++;
        existing.mostRecentAt = Math.max(existing.mostRecentAt, annotation.createdAt);
      } else {
        fileMap.set(key, {
          filePath: annotation.filePath,
          originId: annotation.originId,
          count: 1,
          mostRecentAt: annotation.createdAt,
        });
      }
    }

    // Sort by most recent and take limit
    return [...fileMap.values()]
      .sort((a, b) => b.mostRecentAt - a.mostRecentAt)
      .slice(0, limit)
      .map(f => ({
        filePath: f.filePath,
        originId: f.originId,
        annotationCount: f.count,
        mostRecentAt: f.mostRecentAt,
      }));
  }
}
