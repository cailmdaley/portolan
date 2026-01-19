/**
 * HttpApi - HTTP request handlers
 *
 * Handles non-WebSocket HTTP endpoints:
 * - Claims dashboard proxy (local and remote)
 * - Claims assets proxy (fonts, images)
 * - City activation (start remote agent)
 */

import { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { City } from './CityManager.js';
import type { Origin } from './OriginManager.js';

const execAsync = promisify(exec);

// ============================================================================
// Types
// ============================================================================

export interface CityLookup {
  getCityById(cityId: string): City | null;
}

export interface OriginLookup {
  getOrigin(originId: string): Origin | null | undefined;
}

export interface PersistenceLookup {
  getCityById(cityId: string): { sshHost?: string } | null;
}

// ============================================================================
// HttpApi
// ============================================================================

export class HttpApi {
  private cityLookup: CityLookup;
  private originLookup: OriginLookup;
  private persistenceLookup: PersistenceLookup;

  constructor(
    cityLookup: CityLookup,
    originLookup: OriginLookup,
    persistenceLookup: PersistenceLookup
  ) {
    this.cityLookup = cityLookup;
    this.originLookup = originLookup;
    this.persistenceLookup = persistenceLookup;
  }

  /**
   * Handle HTTP request - returns true if handled, false to fall through
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (url.pathname === '/claims-dashboard') {
      await this.handleClaimsDashboard(url, res);
      return true;
    }

    if (url.pathname.startsWith('/claims-assets/')) {
      await this.handleClaimsAssets(url, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/activate-city') {
      await this.handleActivateCity(url, res);
      return true;
    }

    return false;
  }

  /**
   * Get SSH host for a city (from origin or persistence)
   */
  private getSshHost(city: City): string {
    const origin = this.originLookup.getOrigin(city.originId);
    const persistedCity = this.persistenceLookup.getCityById(city.id);
    return origin?.sshHost || persistedCity?.sshHost || city.originId.replace('remote-', '');
  }

  /**
   * Claims dashboard proxy endpoint
   */
  private async handleClaimsDashboard(url: URL, res: ServerResponse): Promise<void> {
    const cityId = url.searchParams.get('cityId');
    if (!cityId) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing cityId parameter');
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('City not found');
      return;
    }

    const dashboardPath = `${city.path}/results/claims/index.html`;

    try {
      let html: string;
      if (city.originId === 'local') {
        // Local city: read file directly
        const { readFileSync } = await import('fs');
        html = readFileSync(dashboardPath, 'utf-8');
      } else {
        // Remote city: fetch via SSH
        const sshHost = this.getSshHost(city);
        const { stdout } = await execAsync(`ssh ${sshHost} 'cat "${dashboardPath}"'`, { maxBuffer: 10 * 1024 * 1024 });
        html = stdout;
      }

      // Rewrite relative URLs (fonts, images) to use the proxy
      const assetsBase = `/claims-assets`;
      const rewrittenHtml = html
        .replace(/url\(['"]?([^'")\s]+\.(otf|ttf|woff2?|png|jpe?g|svg))['"]?\)/gi,
          (_, path) => `url('${assetsBase}/${path}?cityId=${cityId}')`)
        .replace(/src=['"]([^'"]+\.(png|jpe?g|svg|gif))['"]/gi,
          (_, path) => `src="${assetsBase}/${path}?cityId=${cityId}"`)
        // Inject base URL for dynamic image loading (used by JS code)
        .replace(/<head>/i, `<head><script>window.CLAIMS_ASSETS_BASE = "${assetsBase}"; window.CLAIMS_CITY_ID = "${cityId}";</script>`)
        // Rewrite dynamic imgPath construction to use proxy
        .replace(/const imgPath = ([^;]+);/g,
          `const imgPath = window.CLAIMS_ASSETS_BASE + '/' + ($1) + '?cityId=' + window.CLAIMS_CITY_ID;`)
        // Rewrite lightbox src construction
        .replace(/src: (claim\.id \+ '\/'\s*\+\s*[^}]+)/g,
          `src: window.CLAIMS_ASSETS_BASE + '/' + ($1) + '?cityId=' + window.CLAIMS_CITY_ID`);

      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(rewrittenHtml);
    } catch (error) {
      console.error('Failed to fetch claims dashboard:', error);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Failed to load claims dashboard: ${error}`);
    }
  }

  /**
   * Claims assets proxy (fonts, images, etc.)
   */
  private async handleClaimsAssets(url: URL, res: ServerResponse): Promise<void> {
    const cityId = url.searchParams.get('cityId');
    const assetPath = url.pathname.replace('/claims-assets/', '');

    if (!cityId || !assetPath) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing cityId or asset path');
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('City not found');
      return;
    }

    const fullPath = `${city.path}/results/claims/${assetPath}`;

    // Determine content type
    const ext = assetPath.split('.').pop()?.toLowerCase();
    const contentTypes: Record<string, string> = {
      'otf': 'font/otf',
      'ttf': 'font/ttf',
      'woff': 'font/woff',
      'woff2': 'font/woff2',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'svg': 'image/svg+xml',
      'css': 'text/css',
      'js': 'application/javascript',
    };
    const contentType = contentTypes[ext || ''] || 'application/octet-stream';

    try {
      let data: Buffer;
      if (city.originId === 'local') {
        const { readFileSync } = await import('fs');
        data = readFileSync(fullPath);
      } else {
        const sshHost = this.getSshHost(city);
        const { stdout } = await execAsync(`ssh ${sshHost} 'cat "${fullPath}"'`, {
          maxBuffer: 10 * 1024 * 1024,
          encoding: 'buffer'
        });
        data = stdout as unknown as Buffer;
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(data);
    } catch (error) {
      console.error('Failed to fetch claims asset:', error);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Asset not found: ${assetPath}`);
    }
  }

  /**
   * Activate dormant remote city endpoint
   * POST /activate-city?cityId=xxx
   */
  private async handleActivateCity(url: URL, res: ServerResponse): Promise<void> {
    console.log(`[Activate] Received request for cityId=${url.searchParams.get('cityId')}`);
    const cityId = url.searchParams.get('cityId');
    if (!cityId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing cityId parameter' }));
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'City not found' }));
      return;
    }

    // Only activate remote cities
    if (city.originId === 'local') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cannot activate local city - start a session manually' }));
      return;
    }

    const sshHost = this.getSshHost(city);

    try {
      // Check if agent is already running on this host
      const { stdout: checkOutput } = await execAsync(
        `ssh ${sshHost} 'tmux has-session -t hexarchy-agent 2>/dev/null && echo running || echo stopped'`,
        { timeout: 10000 }
      );

      if (checkOutput.trim() === 'running') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ status: 'already_running', message: 'Agent already running on ' + sshHost }));
        return;
      }

      // Start the agent via SSH
      // Use bash -l to get login shell with nvm/node in PATH
      console.log(`[Activate] Starting hexarchy-agent on ${sshHost}...`);
      await execAsync(
        `ssh ${sshHost} 'tmux new-session -d -s hexarchy-agent "bash -l -c \\"node ~/bin/hexarchy-agent.js connect --ssh-host=${sshHost}\\""'`,
        { timeout: 30000 }
      );

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ status: 'started', message: 'Agent started on ' + sshHost }));
    } catch (error: any) {
      console.error(`[Activate] Failed to start agent on ${sshHost}:`, error.message);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Failed to start agent: ' + error.message }));
    }
  }
}
