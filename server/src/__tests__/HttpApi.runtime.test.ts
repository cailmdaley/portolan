import { beforeEach, describe, expect, it } from 'vitest';
import { HttpApi } from '../HttpApi.js';
import { httpRequest, stubOriginLookup, stubPersistenceLookup } from './test-utils.js';

const stubCityLookup = {
  getCityById: () => null,
};

describe('HttpApi — /debug-runtime endpoint', () => {
  let api: HttpApi;

  beforeEach(() => {
    api = new HttpApi(
      stubCityLookup as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
    );
  });

  it('returns process diagnostics when no runtime provider is set', async () => {
    const res = await httpRequest(api, 'GET', '/debug-runtime');

    expect(res.status).toBe(200);
    expect(typeof res.data.timestamp).toBe('number');
    expect(typeof res.data.pid).toBe('number');
    expect(typeof res.data.uptimeSeconds).toBe('number');
    expect(typeof res.data.memory?.rss).toBe('number');
    expect(res.data.runtime).toEqual({});
  });

  it('includes diagnostics from configured runtime provider', async () => {
    api.setRuntimeDiagnosticsProvider(() => ({
      sessions: { local: 1, remote: 2, total: 3 },
      maps: { remoteActivities: 4 },
    }));

    const res = await httpRequest(api, 'GET', '/debug-runtime');

    expect(res.status).toBe(200);
    expect(res.data.runtime).toEqual({
      sessions: { local: 1, remote: 2, total: 3 },
      maps: { remoteActivities: 4 },
    });
  });

  it('returns 500 when diagnostics provider throws', async () => {
    api.setRuntimeDiagnosticsProvider(() => {
      throw new Error('boom');
    });

    const res = await httpRequest(api, 'GET', '/debug-runtime');

    expect(res.status).toBe(500);
    expect(res.data.error).toBe('Failed to collect runtime diagnostics');
  });
});
