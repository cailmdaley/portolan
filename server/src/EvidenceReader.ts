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
  generated?: string;                // ISO timestamp from evidence.json
}

export interface EvidenceSummary {
  fiberId: string;
  specName: string;
  evidence: Evidence | null;
  stale: boolean;     // true if upstream evidence is newer
  hasEvidence: boolean;
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
    if (!sshHost) {
      return await readLocalEvidence(evidenceDir, specName);
    } else {
      return await readRemoteEvidence(sshHost, evidenceDir, specName);
    }
  } catch {
    return null;
  }
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
  const data = JSON.parse(content);

  // Collect artifacts from evidence.json + PNG/JPG files in directory
  const artifacts: Record<string, string> = {
    ...(data.artifact_paths || data.artifacts || {}),
  };

  try {
    const files = await readdir(evidenceDir);
    for (const f of files) {
      if (/\.(png|jpe?g)$/i.test(f)) {
        const stem = f.replace(/\.[^.]+$/, '');
        if (!artifacts[stem]) {
          artifacts[stem] = f;
        }
      }
    }
  } catch {
    // directory listing failed — use what we have
  }

  return {
    specName,
    metrics: data.evidence || {},
    artifacts,
    mtime,
    generated: data.generated,
  };
}

async function readRemoteEvidence(
  sshHost: string,
  evidenceDir: string,
  specName: string,
): Promise<Evidence | null> {
  // Read evidence.json and its mtime in one SSH call
  const cmd = [
    `stat -c '%Y' ${shellEscape(evidenceDir + '/evidence.json')} 2>/dev/null || stat -f '%m' ${shellEscape(evidenceDir + '/evidence.json')} 2>/dev/null`,
    `cat ${shellEscape(evidenceDir + '/evidence.json')}`,
    `ls ${shellEscape(evidenceDir)}/*.png ${shellEscape(evidenceDir)}/*.jpg 2>/dev/null || true`,
  ].join(' && echo "---SEPARATOR---" && ');

  const { stdout } = await execFileAsync(
    'ssh', [sshHost, cmd],
    { maxBuffer: 5 * 1024 * 1024, timeout: 15000 },
  );

  const parts = stdout.split('---SEPARATOR---');
  if (parts.length < 2) return null;

  const mtimeStr = parts[0].trim();
  const mtime = parseInt(mtimeStr, 10) * 1000; // convert seconds to ms
  if (isNaN(mtime)) return null;

  const jsonStr = parts[1].trim();
  const data = JSON.parse(jsonStr);

  const artifacts: Record<string, string> = {
    ...(data.artifact_paths || data.artifacts || {}),
  };

  // Parse ls output for additional images
  if (parts[2]) {
    const files = parts[2].trim().split('\n').filter(Boolean);
    for (const f of files) {
      const filename = f.split('/').pop()!;
      if (/\.(png|jpe?g)$/i.test(filename)) {
        const stem = filename.replace(/\.[^.]+$/, '');
        if (!artifacts[stem]) {
          artifacts[stem] = filename;
        }
      }
    }
  }

  return {
    specName,
    metrics: data.evidence || {},
    artifacts,
    mtime,
    generated: data.generated,
  };
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
