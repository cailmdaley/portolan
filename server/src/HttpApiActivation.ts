import { execFile } from 'child_process';
import type { ServerResponse } from 'http';
import { promisify } from 'util';
import type { City } from './CityManager.js';

const execFileAsync = promisify(execFile);

interface CityLookup {
  getCityById(cityId: string): City | null;
}

interface HttpApiActivationOptions {
  cityLookup: CityLookup;
  getSshHost: (city: City) => string;
}

export class HttpApiActivation {
  private readonly cityLookup: CityLookup;
  private readonly getSshHost: (city: City) => string;

  constructor(options: HttpApiActivationOptions) {
    this.cityLookup = options.cityLookup;
    this.getSshHost = options.getSshHost;
  }

  async handleActivateCity(url: URL, res: ServerResponse): Promise<void> {
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

    if (city.originId === 'local') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cannot activate local city - start a session manually' }));
      return;
    }

    const sshHost = this.getSshHost(city);

    try {
      const { stdout: checkOutput } = await execFileAsync(
        'ssh',
        ['-T', sshHost, 'tmux has-session -t portolan-agent 2>/dev/null && echo running || echo stopped'],
        { timeout: 10000 }
      );

      if (checkOutput.trim() === 'running') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ status: 'already_running', message: `Agent already running on ${sshHost}` }));
        return;
      }

      console.log(`[Activate] Starting portolan-agent on ${sshHost}...`);
      await execFileAsync(
        'ssh',
        ['-T', sshHost, `tmux new-session -d -s portolan-agent "bash -l -c \\"node ~/bin/portolan-agent.js connect --ssh-host=${sshHost}\\""`],
        { timeout: 30000 }
      );

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ status: 'started', message: `Agent started on ${sshHost}` }));
    } catch (error: any) {
      console.error(`[Activate] Failed to start agent on ${sshHost}:`, error.message);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: `Failed to start agent: ${error.message}` }));
    }
  }
}
