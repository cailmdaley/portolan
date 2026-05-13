import { describe, expect, it } from 'vitest';
import { HttpApi } from '../HttpApi.js';
import {
  httpRequest,
  makeMultiCityLookup,
  stubPersistenceLookup,
} from './test-utils.js';

describe('HttpApi — POST /file-as-fiber', () => {
  it('routes remote creates through Shuttle daemon-local fiber create', async () => {
    const cityPath = '/home/cdaley/projects/ai-futures';
    const created: Array<{
      id: string;
      name: string;
      body?: string;
      frontmatter: Record<string, unknown>;
      originId: string;
    }> = [];
    const api = new HttpApi(
      makeMultiCityLookup([
        {
          id: 'remote-city',
          path: cityPath,
          originId: 'remote-candide',
          name: 'RemoteCandide',
        },
      ]) as any,
      {
        getOrigin: (originId: string) => (
          originId === 'remote-candide'
            ? { id: originId, name: 'candide', sshHost: 'candide', agentSockets: new Set() }
            : null
        ),
      } as any,
      stubPersistenceLookup as any,
      {
        shuttleFiberCreateFn: async (request) => {
          created.push(request);
          return { id: request.id, path: `${cityPath}/.felt/${request.id}/${request.id}.md` };
        },
      },
    );

    const res = await httpRequest(api, 'POST', '/file-as-fiber', {
      filePath: `${cityPath}/notes/source.md`,
      originId: 'remote-candide',
      cityPath,
      title: 'Remote annotation note',
      body: 'Capture this remote annotation.',
      kind: 'finding',
      parentSlug: 'parent',
    });

    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      success: true,
      fiberId: 'parent/remote-annotation-note',
    });
    expect(created).toEqual([
      {
        id: 'parent/remote-annotation-note',
        name: 'Remote annotation note',
        body: 'Capture this remote annotation.',
        frontmatter: {
          name: 'Remote annotation note',
          status: 'open',
          tags: ['finding'],
        },
        originId: 'remote-candide',
      },
    ]);
  });
});
