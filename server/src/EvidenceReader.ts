/**
 * EvidenceReader — reads evidence.json and artifact metadata for claim fibers.
 *
 * Works both locally and via SSH for remote cities.
 * Evidence lives at: {cityPath}/results/claims/{specName}/evidence.json
 * Artifacts are PNGs/JPGs in the same directory.
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { shellEscape } from './KittyIntegration.js';

const execFileAsync = promisify(execFile);

export interface Evidence {
  specName: string;
  metrics: Record<string, unknown>;
  artifacts: Record<string, string>; // name → filename
  mtime: number;                     // ms since epoch — evidence.json mtime
  generated: string | null;           // ISO timestamp from evidence.json
}

/**
 * Read evidence for a single spec directory.
 */
export async function readEvidence(
  cityPath: string,
  specName: string,
  sshHost?: string,
): Promise<Evidence | null> {
  const evidenceDir = `${cityPath}/results/claims/${specName}`;

  try {
    if (sshHost) {
      return await readRemoteEvidence(sshHost, evidenceDir, specName);
    }
    return await readLocalEvidence(evidenceDir, specName);
  } catch {
    return null;
  }
}

const IMAGE_RE = /\.(png|jpe?g)$/i;

function mergeImageArtifacts(
  artifacts: Record<string, string>,
  filenames: string[],
): void {
  for (const f of filenames) {
    if (IMAGE_RE.test(f)) {
      const stem = f.replace(/\.[^.]+$/, '');
      if (!artifacts[stem]) {
        artifacts[stem] = f;
      }
    }
  }
}

function buildEvidence(
  specName: string,
  data: Record<string, unknown>,
  mtime: number,
  artifacts: Record<string, string>,
): Evidence {
  return {
    specName,
    metrics: (data.evidence as Record<string, unknown>) || {},
    artifacts,
    mtime,
    generated: (data.generated as string) ?? null,
  };
}

function parseArtifactsFromData(data: Record<string, unknown>): Record<string, string> {
  return {
    ...((data.artifact_paths || data.artifacts || {}) as Record<string, string>),
  };
}

async function readLocalEvidence(evidenceDir: string, specName: string): Promise<Evidence | null> {
  const evidencePath = join(evidenceDir, 'evidence.json');

  let mtime: number;
  try {
    const s = await stat(evidencePath);
    mtime = s.mtimeMs;
  } catch {
    return null;
  }

  const content = await readFile(evidencePath, 'utf-8');
  const data = JSON.parse(content) as Record<string, unknown>;
  const artifacts = parseArtifactsFromData(data);

  try {
    mergeImageArtifacts(artifacts, await readdir(evidenceDir));
  } catch {
    // directory listing failed — use what we have
  }

  return buildEvidence(specName, data, mtime, artifacts);
}

async function readRemoteEvidence(
  sshHost: string,
  evidenceDir: string,
  specName: string,
): Promise<Evidence | null> {
  const escapedPath = shellEscape(evidenceDir + '/evidence.json');
  const escapedDir = shellEscape(evidenceDir);
  const cmd = [
    `stat -c '%Y' ${escapedPath} 2>/dev/null || stat -f '%m' ${escapedPath} 2>/dev/null`,
    `cat ${escapedPath}`,
    `ls ${escapedDir}/*.png ${escapedDir}/*.jpg 2>/dev/null || true`,
  ].join(' && echo "---SEPARATOR---" && ');

  const { stdout } = await execFileAsync(
    'ssh', [sshHost, cmd],
    { maxBuffer: 5 * 1024 * 1024, timeout: 15000 },
  );

  const parts = stdout.split('---SEPARATOR---');
  if (parts.length < 2) return null;

  const mtime = parseInt(parts[0].trim(), 10) * 1000; // seconds to ms
  if (isNaN(mtime)) return null;

  const data = JSON.parse(parts[1].trim()) as Record<string, unknown>;
  const artifacts = parseArtifactsFromData(data);

  if (parts[2]) {
    const filenames = parts[2].trim().split('\n')
      .filter(Boolean)
      .map(f => f.split('/').pop()!);
    mergeImageArtifacts(artifacts, filenames);
  }

  return buildEvidence(specName, data, mtime, artifacts);
}

/**
 * Extract the spec name from a fiber's rule: tag.
 * e.g., "rule:cosebis_data_vector" → "cosebis_data_vector"
 */
export function getSpecName(tags: string[]): string | undefined {
  for (const tag of tags) {
    if (tag.startsWith('rule:')) {
      return tag.slice(5);
    }
  }
  return undefined;
}

/**
 * Compute staleness: a fiber is stale if any upstream dependency has
 * evidence with a newer mtime than this fiber's evidence.
 */
export function computeStaleness(
  fiberId: string,
  dependsOn: string[],
  evidenceMap: Map<string, Evidence | null>,
  fiberSpecMap: Map<string, string>, // fiberId → specName
): 'fresh' | 'stale' | 'no-evidence' {
  const specName = fiberSpecMap.get(fiberId);
  if (!specName) return 'no-evidence';

  const myEvidence = evidenceMap.get(specName);
  if (!myEvidence) return 'no-evidence';

  for (const depId of dependsOn) {
    const depSpec = fiberSpecMap.get(depId);
    if (!depSpec) continue;

    const depEvidence = evidenceMap.get(depSpec);
    if (!depEvidence) continue;

    if (depEvidence.mtime > myEvidence.mtime) {
      return 'stale';
    }
  }

  return 'fresh';
}
