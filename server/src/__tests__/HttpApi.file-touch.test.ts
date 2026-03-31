import { describe, it, expect } from 'vitest';
import { HttpApi } from '../HttpApi.js';
import { RecentFileTracker } from '../RecentFileTracker.js';
import { httpRequest, stubOriginLookup, stubPersistenceLookup } from './test-utils.js';

describe('HttpApi — file-touch hooks', () => {
  const cityLookup = {
    getCityById: () => null,
  };

  const session = {
    id: 'worker-1',
    name: 'worker-1',
    tmuxSession: 'worker-1',
    cwd: '/project',
    status: 'working' as const,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    originId: 'local',
  };

  const similarPrefixSession = {
    id: 'worker-2',
    name: 'worker-2',
    tmuxSession: 'worker-2',
    cwd: '/project-alpha',
    status: 'working' as const,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    originId: 'local',
  };

  const remotePureEbSlides = {
    id: 'remote-pureeb-slides',
    name: 'slides',
    tmuxSession: 'slides',
    cwd: '/remote/pureeb',
    status: 'working' as const,
    createdAt: Date.now(),
    lastActivity: Date.now() - 5_000,
    originId: 'remote-candide',
  };

  const remotePureEbFinalReview = {
    id: 'remote-pureeb-final-review',
    name: 'final-review',
    tmuxSession: 'final-review',
    cwd: '/remote/pureeb',
    status: 'working' as const,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    originId: 'remote-candide',
  };

  function makeApi(sessions: typeof session[] = [session]): HttpApi {
    const api = new HttpApi(cityLookup, stubOriginLookup, stubPersistenceLookup);
    api.setSessionLookup({
      findSession: (sessionId: string) => sessions.find((item) => item.id === sessionId),
      getAllSessions: () => sessions,
    });
    api.setRecentFileTracker(new RecentFileTracker());
    return api;
  }

  it('stores a file touch and serves it from /recent-files', async () => {
    const api = makeApi();

    const post = await httpRequest(api, 'POST', '/hook/file-touch', {
      session_id: session.id,
      tool_name: 'Read',
      tool_input: { file_path: '/project/src/main.ts' },
      cwd: '/project',
    });
    expect(post.status).toBe(200);
    expect(post.data.stored).toBe(true);

    const get = await httpRequest(api, 'GET', `/recent-files?sessionId=${encodeURIComponent(session.id)}`);
    expect(get.status).toBe(200);
    expect(get.data.files).toHaveLength(1);
    expect(get.data.files[0].fullPath).toBe('/project/src/main.ts');
    expect(get.data.files[0].basename).toBe('main.ts');
    expect(get.data.files[0].toolName).toBe('Read');
  });

  it('ignores non Read/Write/Edit tools', async () => {
    const api = makeApi();

    const post = await httpRequest(api, 'POST', '/hook/file-touch', {
      session_id: session.id,
      tool_name: 'Bash',
      tool_input: { file_path: '/project/src/main.ts' },
      cwd: '/project',
    });
    expect(post.status).toBe(200);
    expect(post.data.ignored).toBe(true);

    const get = await httpRequest(api, 'GET', `/recent-files?sessionId=${encodeURIComponent(session.id)}`);
    expect(get.status).toBe(200);
    expect(get.data.files).toEqual([]);
  });

  it('resolves worker by cwd when hook session_id is unknown', async () => {
    const api = makeApi();

    const post = await httpRequest(api, 'POST', '/hook/file-touch', {
      session_id: 'unknown-claude-session',
      tool_name: 'Edit',
      tool_input: { file_path: '/project/src/app.ts' },
      cwd: '/project',
    });
    expect(post.status).toBe(200);
    expect(post.data.stored).toBe(true);
    expect(post.data.workerSessionId).toBe(session.id);

    const get = await httpRequest(api, 'GET', `/recent-files?sessionId=${encodeURIComponent(session.id)}`);
    expect(get.status).toBe(200);
    expect(get.data.files[0].fullPath).toBe('/project/src/app.ts');
  });

  it('normalizes relative file paths using cwd', async () => {
    const api = makeApi();

    const post = await httpRequest(api, 'POST', '/hook/file-touch', {
      session_id: session.id,
      tool_name: 'Write',
      tool_input: { file_path: 'src/relative.ts' },
      cwd: '/project',
    });
    expect(post.status).toBe(200);
    expect(post.data.stored).toBe(true);

    const get = await httpRequest(api, 'GET', `/recent-files?sessionId=${encodeURIComponent(session.id)}`);
    expect(get.status).toBe(200);
    expect(get.data.files[0].fullPath).toBe('/project/src/relative.ts');
    expect(get.data.files[0].basename).toBe('relative.ts');
  });

  it('matches cwd with path boundaries, not raw prefixes', async () => {
    const api = makeApi([session, similarPrefixSession]);

    const post = await httpRequest(api, 'POST', '/hook/file-touch', {
      session_id: 'unknown-claude-session',
      tool_name: 'Read',
      tool_input: { file_path: '/project-alpha/src/app.ts' },
      cwd: '/project-alpha',
    });
    expect(post.status).toBe(200);
    expect(post.data.stored).toBe(true);
    expect(post.data.workerSessionId).toBe(similarPrefixSession.id);

    const get = await httpRequest(api, 'GET', `/recent-files?sessionId=${encodeURIComponent(similarPrefixSession.id)}`);
    expect(get.status).toBe(200);
    expect(get.data.files[0].fullPath).toBe('/project-alpha/src/app.ts');
  });

  it('matches file paths with path boundaries, not raw prefixes', async () => {
    const api = makeApi([session, similarPrefixSession]);

    const post = await httpRequest(api, 'POST', '/hook/file-touch', {
      session_id: 'unknown-claude-session',
      tool_name: 'Edit',
      tool_input: { file_path: '/project-alpha/src/edit.ts' },
      cwd: '',
    });
    expect(post.status).toBe(200);
    expect(post.data.stored).toBe(true);
    expect(post.data.workerSessionId).toBe(similarPrefixSession.id);

    const get = await httpRequest(api, 'GET', `/recent-files?sessionId=${encodeURIComponent(similarPrefixSession.id)}`);
    expect(get.status).toBe(200);
    expect(get.data.files[0].fullPath).toBe('/project-alpha/src/edit.ts');
  });

  it('uses tmux_session and origin_name to disambiguate remote workers sharing a cwd', async () => {
    const api = makeApi([remotePureEbSlides, remotePureEbFinalReview]);

    const post = await httpRequest(api, 'POST', '/hook/file-touch', {
      session_id: 'unknown-claude-session',
      tmux_session: 'slides',
      origin_name: 'candide',
      tool_name: 'Read',
      tool_input: { file_path: '/remote/pureeb/slides/deck.md' },
      cwd: '/remote/pureeb',
    });
    expect(post.status).toBe(200);
    expect(post.data.stored).toBe(true);
    expect(post.data.workerSessionId).toBe(remotePureEbSlides.id);

    const slidesGet = await httpRequest(api, 'GET', `/recent-files?sessionId=${encodeURIComponent(remotePureEbSlides.id)}`);
    expect(slidesGet.status).toBe(200);
    expect(slidesGet.data.files).toHaveLength(1);
    expect(slidesGet.data.files[0].fullPath).toBe('/remote/pureeb/slides/deck.md');

    const reviewGet = await httpRequest(api, 'GET', `/recent-files?sessionId=${encodeURIComponent(remotePureEbFinalReview.id)}`);
    expect(reviewGet.status).toBe(200);
    expect(reviewGet.data.files).toEqual([]);
  });
});
