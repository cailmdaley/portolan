import { execFile } from 'child_process';
import type { ServerResponse } from 'http';
import { readFile } from 'fs/promises';
import { promisify } from 'util';
import type { City } from './CityManager.js';
import { readEvidence, readEvidenceBatch, getSpecName, computeStaleness, type Evidence } from './EvidenceReader.js';
import { getAllFibers, type Fiber } from './FiberReader.js';
import { HttpApiFileContent, HTTP_API_MIME_TYPES } from './HttpApiFileContent.js';
import { shellEscape } from './ShellPathUtils.js';

const execFileAsync = promisify(execFile);

interface CityLookup {
  getCityById(cityId: string): City | null;
}

interface HttpApiTapestryOptions {
  cityLookup: CityLookup;
  fileContentApi: HttpApiFileContent;
  getSshHost: (city: City) => string;
  sendJsonError: (res: ServerResponse, status: number, error: string) => void;
  sendJsonSuccess: (res: ServerResponse, data: Record<string, unknown>) => void;
}

export class HttpApiTapestry {
  private readonly cityLookup: CityLookup;
  private readonly fileContentApi: HttpApiFileContent;
  private readonly getSshHost: (city: City) => string;
  private readonly sendJsonError: (res: ServerResponse, status: number, error: string) => void;
  private readonly sendJsonSuccess: (res: ServerResponse, data: Record<string, unknown>) => void;

  constructor(options: HttpApiTapestryOptions) {
    this.cityLookup = options.cityLookup;
    this.fileContentApi = options.fileContentApi;
    this.getSshHost = options.getSshHost;
    this.sendJsonError = options.sendJsonError;
    this.sendJsonSuccess = options.sendJsonSuccess;
  }

  async handleTapestry(url: URL, res: ServerResponse): Promise<void> {
    const cityId = url.searchParams.get('cityId');
    if (!cityId) {
      this.sendJsonError(res, 400, 'Missing cityId parameter');
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      this.sendJsonError(res, 404, 'City not found');
      return;
    }

    const sshHost = city.originId !== 'local' ? this.getSshHost(city) : undefined;

    try {
      const allFibers = await this.getAllCityFibers(city.path, sshHost);
      const ruleFibers = allFibers.filter((fiber) =>
        fiber.tags?.some((tag) => tag.startsWith('tapestry:') || tag.startsWith('rule:'))
      );
      const fiberIds = new Set(ruleFibers.map((fiber) => fiber.id));

      const fiberSpecMap = new Map<string, string>();
      for (const fiber of ruleFibers) {
        const specName = getSpecName(fiber.tags || []);
        if (specName) {
          fiberSpecMap.set(fiber.id, specName);
        }
      }

      const uniqueSpecNames = Array.from(new Set(fiberSpecMap.values()));
      let evidenceMap: Map<string, Evidence | null>;
      if (sshHost && uniqueSpecNames.length > 0) {
        evidenceMap = await readEvidenceBatch(city.path, uniqueSpecNames, sshHost);
      } else {
        evidenceMap = new Map<string, Evidence | null>();
        await Promise.all(
          uniqueSpecNames.map(async (specName) => {
            const evidence = await readEvidence(city.path, specName);
            evidenceMap.set(specName, evidence);
          })
        );
      }

      const depsMap = new Map<string, string[]>();
      for (const fiber of ruleFibers) {
        depsMap.set(fiber.id, (fiber.dependsOn || []).filter((dep) => fiberIds.has(dep)));
      }

      const nodes = ruleFibers.map((fiber) => {
        const specName = fiberSpecMap.get(fiber.id);
        const evidence = specName ? evidenceMap.get(specName) : null;
        const deps = depsMap.get(fiber.id) || [];
        const staleness = computeStaleness(fiber.id, depsMap, evidenceMap, fiberSpecMap);

        return {
          id: fiber.id,
          title: fiber.title,
          kind: fiber.kind,
          status: fiber.status,
          body: fiber.body,
          outcome: fiber.outcome || null,
          tags: fiber.tags || [],
          createdAt: fiber.createdAt || null,
          closedAt: fiber.closedAt || null,
          dependsOn: deps,
          specName: specName || null,
          staleness,
          evidence: evidence ? {
            metrics: evidence.metrics,
            artifacts: evidence.artifacts,
            mtime: evidence.mtime,
            generated: evidence.generated ?? null,
          } : null,
        };
      });

      const links: Array<{ source: string; target: string }> = [];
      for (const fiber of ruleFibers) {
        for (const dependency of fiber.dependsOn || []) {
          if (fiberIds.has(dependency)) {
            links.push({ source: dependency, target: fiber.id });
          }
        }
      }

      const downstreamMap: Record<string, Array<{ id: string; title: string; status: string; kind: string }>> = {};
      for (const fiber of ruleFibers) {
        for (const dependency of fiber.dependsOn || []) {
          if (fiberIds.has(dependency)) {
            if (!downstreamMap[dependency]) {
              downstreamMap[dependency] = [];
            }
            downstreamMap[dependency].push({
              id: fiber.id,
              title: fiber.title,
              status: fiber.status,
              kind: fiber.kind,
            });
          }
        }
      }

      const config = await this.readCityConfig(city.path, sshHost);
      const fibers = allFibers.map((fiber) => ({
        id: fiber.id,
        title: fiber.title,
        status: fiber.status,
        kind: fiber.kind,
        tags: fiber.tags,
        body: fiber.body,
        outcome: fiber.outcome || null,
        createdAt: fiber.createdAt || null,
        closedAt: fiber.closedAt || null,
        dependsOn: fiber.dependsOn || [],
      }));

      const decisions = await this.readASTRADecisions(city.path, nodes, sshHost);

      this.sendJsonSuccess(res, {
        nodes,
        links,
        downstream: downstreamMap,
        config,
        fibers,
        decisions,
      });
    } catch (error: any) {
      console.error('Failed to build tapestry:', error);
      this.sendJsonError(res, 500, 'Failed to build tapestry: ' + error.message);
    }
  }

  async handleTapestryAsset(url: URL, res: ServerResponse): Promise<void> {
    const cityId = url.searchParams.get('cityId');
    const rawPath = url.pathname.replace('/tapestry-asset/', '');
    const parts = rawPath.split('/');

    if (!cityId || parts.length < 2) {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('Missing cityId or invalid asset path');
      return;
    }

    let assetPath: string;
    try {
      assetPath = decodeURIComponent(parts.join('/'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('Invalid asset path');
      return;
    }

    await this.serveTapestryAsset(cityId, assetPath, res);
  }

  private async getAllCityFibers(cityPath: string, sshHost?: string): Promise<Fiber[]> {
    if (!sshHost) {
      return getAllFibers(cityPath);
    }

    const command = `cd ${shellEscape(cityPath)} && felt ls -s all --json --body 2>/dev/null || echo '[]'`;
    const { stdout } = await execFileAsync(
      'ssh',
      [sshHost, command],
      { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }
    );

    const raw = JSON.parse(stdout.trim() || '[]');
    return raw.map((fiber: any): Fiber => ({
      id: fiber.id,
      title: fiber.title || fiber.id,
      status: fiber.status || 'open',
      kind: fiber.kind || 'task',
      priority: fiber.priority || 2,
      createdAt: fiber.created_at || '',
      closedAt: fiber.closed_at,
      outcome: fiber.outcome || fiber.close_reason,
      body: fiber.body,
      tags: fiber.tags?.flatMap((tag: string) =>
        tag.includes(',') ? tag.split(',').map((value: string) => value.trim()).filter(Boolean) : [tag]
      ),
      dependsOn: fiber.depends_on?.map((dependency: any) =>
        typeof dependency === 'string' ? dependency : dependency.id
      ),
    }));
  }

  private async readCityConfig(
    cityPath: string,
    sshHost?: string,
  ): Promise<Record<string, string> | null> {
    const candidates = [
      `${cityPath}/config/config.yaml`,
      `${cityPath}/workflow/config/config.yaml`,
    ];

    try {
      let content = '';
      if (sshHost) {
        const tryPaths = candidates.map((candidate) => `cat ${shellEscape(candidate)} 2>/dev/null`).join(' || ');
        const { stdout } = await execFileAsync(
          'ssh',
          [sshHost, `${tryPaths} || echo ''`],
          { maxBuffer: 1024 * 1024, timeout: 10000 }
        );
        content = stdout.trim();
      } else {
        for (const candidate of candidates) {
          try {
            content = await readFile(candidate, 'utf-8');
            break;
          } catch {
            // Try the next candidate path.
          }
        }
      }

      if (!content) {
        return null;
      }

      const { parse } = await import('yaml');
      const data = parse(content);
      if (!data || typeof data !== 'object') {
        return null;
      }

      const flat: Record<string, string> = {};
      const walk = (value: unknown, prefix: string) => {
        if (value === null || value === undefined) {
          return;
        }
        if (Array.isArray(value)) {
          flat[prefix] = JSON.stringify(value);
          return;
        }
        if (typeof value === 'object') {
          for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
            walk(nestedValue, prefix ? `${prefix}.${key}` : key);
          }
          return;
        }
        flat[prefix] = String(value);
      };

      walk(data, '');
      return flat;
    } catch {
      return null;
    }
  }

  private async readASTRADecisions(
    cityPath: string,
    nodes: Array<{ id: string; specName: string | null; tags: string[] }>,
    sshHost?: string,
  ): Promise<Array<Record<string, unknown>>> {
    try {
      let content = '';
      const astraPath = `${cityPath}/astra.yaml`;
      if (sshHost) {
        const { stdout } = await execFileAsync(
          'ssh',
          [sshHost, `cat ${shellEscape(astraPath)} 2>/dev/null || echo ''`],
          { maxBuffer: 1024 * 1024, timeout: 10000 },
        );
        content = stdout.trim();
      } else {
        try {
          content = await readFile(astraPath, 'utf-8');
        } catch {
          return [];
        }
      }
      if (!content) return [];

      const { parse } = await import('yaml');
      const data = parse(content);
      if (!data?.decisions || typeof data.decisions !== 'object') return [];

      // Build specName→nodeId and tag→nodeId maps for evidence wiring
      const specToIds = new Map<string, string[]>();
      const tagToIds = new Map<string, string[]>();
      for (const node of nodes) {
        if (node.specName) {
          const ids = specToIds.get(node.specName) || [];
          ids.push(node.id);
          specToIds.set(node.specName, ids);
        }
        for (const tag of node.tags) {
          const ids = tagToIds.get(tag) || [];
          ids.push(node.id);
          tagToIds.set(tag, ids);
        }
      }

      const flattenDecisions = (
        rawDecisions: Record<string, any>,
        analysisId: string,
      ): Array<Record<string, unknown>> => {
        return Object.entries(rawDecisions)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, dec]) => {
            const tapestryNodes: string[] = dec.tapestry_nodes || [];
            let evidenceIds: string[] = [];
            for (const specName of tapestryNodes) {
              const matched = specToIds.get(specName) || [];
              for (const nid of matched) {
                if (!evidenceIds.includes(nid)) evidenceIds.push(nid);
              }
            }
            if (evidenceIds.length === 0) {
              for (const nid of tagToIds.get(`evidence:${id}`) || []) {
                if (!evidenceIds.includes(nid)) evidenceIds.push(nid);
              }
            }
            evidenceIds.sort();

            const options = Object.entries(dec.options || {})
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([optId, opt]: [string, any]) => ({
                id: optId,
                label: opt.label || optId,
                description: opt.description || '',
                excluded: opt.excluded || false,
                excludedReason: opt.excluded_reason || '',
              }));

            return {
              id,
              label: dec.label || id,
              rationale: dec.rationale || '',
              tags: dec.tags || [],
              default: dec.default || '',
              analysisId,
              options,
              evidenceIds,
            };
          });
      };

      const decisions = flattenDecisions(data.decisions, '');
      if (data.analyses && typeof data.analyses === 'object') {
        for (const [analysisId, analysis] of Object.entries(data.analyses as Record<string, any>).sort(([a], [b]) => a.localeCompare(b))) {
          if (analysis.decisions && typeof analysis.decisions === 'object') {
            decisions.push(...flattenDecisions(analysis.decisions, analysisId));
          }
        }
      }
      return decisions;
    } catch {
      return [];
    }
  }

  private async serveTapestryAsset(cityId: string, assetPath: string, res: ServerResponse): Promise<void> {
    if (assetPath.includes('..') || /[`$"\\]/.test(assetPath)) {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('Invalid asset path');
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('City not found');
      return;
    }

    const fullPath = `${city.path}/results/tapestry/${assetPath}`;
    const ext = assetPath.split('.').pop()?.toLowerCase();
    const contentType = HTTP_API_MIME_TYPES[ext || ''] || 'application/octet-stream';
    const timeout = ext === 'pdf' ? 60000 : 30000;

    try {
      if (city.originId === 'local') {
        await this.fileContentApi.streamLocalBinaryFile(fullPath, contentType, 'no-cache', res);
      } else {
        const sshHost = this.getSshHost(city);
        await this.fileContentApi.streamRemoteBinaryFile(sshHost, fullPath, contentType, 'no-cache', timeout, res);
      }
    } catch (error) {
      if (res.headersSent || res.writableEnded) {
        return;
      }

      const statusCode = typeof (error as { statusCode?: number })?.statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : ((error as { code?: string })?.code === 'ENOENT' ? 404 : 500);

      res.writeHead(statusCode, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      if (statusCode === 404) {
        res.end(`Asset not found: ${assetPath}`);
        return;
      }
      res.end('Failed to read asset');
    }
  }
}
