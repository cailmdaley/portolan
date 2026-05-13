import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import type { ServerResponse } from 'http';
import { promisify } from 'util';
import type { City } from './CityManager.js';
import type {
  RemoteFileContentInvocation,
  RemoteFileContentResult,
} from './HttpApiFileContent.js';
import { shellEscape } from './ShellPathUtils.js';

const execFileAsync = promisify(execFile);

interface CityLookup {
  getCityById(cityId: string): City | null;
}

interface HttpApiPlaygroundOptions {
  cityLookup: CityLookup;
  getSshHost: (city: City) => string;
  remoteDirectoryExecutor?: (
    originId: string,
    path: string,
  ) => Promise<Array<{ name: string; type: 'file' | 'dir' }>>;
  remoteFileContentExecutor?: (
    request: RemoteFileContentInvocation,
  ) => Promise<RemoteFileContentResult>;
}

export class HttpApiPlayground {
  private readonly cityLookup: CityLookup;
  private readonly getSshHost: (city: City) => string;
  private readonly remoteDirectoryExecutor: HttpApiPlaygroundOptions['remoteDirectoryExecutor'];
  private readonly remoteFileContentExecutor: HttpApiPlaygroundOptions['remoteFileContentExecutor'];

  constructor(options: HttpApiPlaygroundOptions) {
    this.cityLookup = options.cityLookup;
    this.getSshHost = options.getSshHost;
    this.remoteDirectoryExecutor = options.remoteDirectoryExecutor;
    this.remoteFileContentExecutor = options.remoteFileContentExecutor;
  }

  async handlePlaygroundList(url: URL, res: ServerResponse): Promise<void> {
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

    const playgroundsDir = `${city.path}/.portolan/playgrounds`;

    try {
      const files = city.originId === 'local'
        ? await this.listLocalPlaygrounds(playgroundsDir)
        : await this.listRemotePlaygrounds(city, playgroundsDir);

      files.sort();

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ playgrounds: files }));
    } catch (error: any) {
      console.error('Failed to list playgrounds:', error.message);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ playgrounds: [] }));
    }
  }

  async handlePlayground(url: URL, res: ServerResponse): Promise<void> {
    const cityId = url.searchParams.get('cityId');
    const name = url.searchParams.get('name');

    if (!cityId || !name) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing cityId or name parameter');
      return;
    }

    if (name.includes('/') || name.includes('..')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid playground name');
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('City not found');
      return;
    }

    const playgroundPath = `${city.path}/.portolan/playgrounds/${name}`;

    try {
      const html = city.originId === 'local'
        ? await readFile(playgroundPath, 'utf-8')
        : await this.readRemotePlayground(playgroundPath, city);

      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(html);
    } catch (error: any) {
      console.error('Failed to fetch playground:', error.message);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Playground not found');
    }
  }

  private async listLocalPlaygrounds(playgroundsDir: string): Promise<string[]> {
    const { readdirSync } = await import('fs');
    return readdirSync(playgroundsDir).filter((file) => file.endsWith('.html'));
  }

  private async listRemotePlaygrounds(city: City, playgroundsDir: string): Promise<string[]> {
    if (this.remoteDirectoryExecutor) {
      try {
        const entries = await this.remoteDirectoryExecutor(city.originId, playgroundsDir);
        return entries
          .filter((entry) => entry.type === 'file' && entry.name.endsWith('.html'))
          .map((entry) => entry.name);
      } catch (error) {
        const sshHost = this.getSshHost(city);
        if (!sshHost) {
          throw error;
        }
      }
    }

    return this.listRemotePlaygroundsViaSsh(playgroundsDir, this.getSshHost(city));
  }

  private async readRemotePlayground(
    playgroundPath: string,
    city: City,
  ): Promise<string> {
    if (this.remoteFileContentExecutor) {
      try {
        const result = await this.remoteFileContentExecutor({
          originId: city.originId,
          path: playgroundPath,
          operation: 'read',
        });
        if (typeof result.content !== 'string') {
          throw new Error('Remote agent did not return playground content');
        }
        return result.content;
      } catch (error) {
        const sshHost = this.getSshHost(city);
        if (!sshHost) {
          throw error;
        }
      }
    }

    return this.readRemotePlaygroundViaSsh(playgroundPath, this.getSshHost(city));
  }

  private async listRemotePlaygroundsViaSsh(playgroundsDir: string, sshHost: string): Promise<string[]> {
    const { stdout } = await execFileAsync(
      'ssh',
      [sshHost, `ls ${shellEscape(playgroundsDir)}/*.html 2>/dev/null || true`],
      { timeout: 10000 }
    );

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((file) => file.split('/').pop()!)
      .filter((file) => file.endsWith('.html'));
  }

  private async readRemotePlaygroundViaSsh(playgroundPath: string, sshHost: string): Promise<string> {
    const { stdout } = await execFileAsync(
      'ssh',
      [sshHost, `cat ${shellEscape(playgroundPath)}`],
      { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }
    );
    return stdout;
  }
}
