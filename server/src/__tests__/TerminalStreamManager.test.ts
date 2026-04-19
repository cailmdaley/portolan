import { describe, it, expect, vi } from 'vitest';
import { TerminalStreamManager } from '../TerminalStreamManager.js';
import type { TmuxControlClient, TmuxControlClientCallbacks, TmuxControlClientOptions } from '../TmuxControlClient.js';

// Minimal fake client that captures the callbacks the manager passes in,
// so tests can simulate the tmux side emitting bytes/exit/error.
function makeFakeClientFactory() {
  const instances: Array<{
    opts: TmuxControlClientOptions;
    cb: TmuxControlClientCallbacks;
    started: boolean;
    stopped: boolean;
  }> = [];

  const createClient = (opts: TmuxControlClientOptions, cb: TmuxControlClientCallbacks): TmuxControlClient => {
    const state = { opts, cb, started: false, stopped: false };
    instances.push(state);
    const fake: Partial<TmuxControlClient> = {
      start: () => { state.started = true; },
      stop: () => { state.stopped = true; },
    };
    return fake as TmuxControlClient;
  };

  return { instances, createClient };
}

describe('TerminalStreamManager', () => {
  function setup() {
    const { instances, createClient } = makeFakeClientFactory();
    const captureScrollback = vi.fn().mockResolvedValue(Buffer.from('history-bytes'));
    const mgr = new TerminalStreamManager({ createClient, captureScrollback, scrollbackLines: 100 });
    return { mgr, instances, captureScrollback };
  }

  it('spawns one client per session on first attach', () => {
    const { mgr, instances } = setup();
    mgr.attach('alpha', { key: {}, onBytes: () => {} });
    expect(instances).toHaveLength(1);
    expect(instances[0].started).toBe(true);
    expect(instances[0].opts.tmuxSession).toBe('alpha');
  });

  it('multiple subscribers share one backing client', () => {
    const { mgr, instances } = setup();
    mgr.attach('alpha', { key: {}, onBytes: () => {} });
    mgr.attach('alpha', { key: {}, onBytes: () => {} });
    mgr.attach('alpha', { key: {}, onBytes: () => {} });
    expect(instances).toHaveLength(1);
    expect(mgr.stats()).toEqual([{ tmuxSession: 'alpha', subscribers: 3 }]);
  });

  it('fans bytes from one tmux client to every subscriber', () => {
    const { mgr, instances } = setup();
    const a = vi.fn(), b = vi.fn();
    mgr.attach('alpha', { key: {}, onBytes: a });
    mgr.attach('alpha', { key: {}, onBytes: b });
    instances[0].cb.onBytes!(Buffer.from('bytes'));
    expect(a).toHaveBeenCalledWith(Buffer.from('bytes'));
    expect(b).toHaveBeenCalledWith(Buffer.from('bytes'));
  });

  it('double-attach with same key is refcounted as one', () => {
    const { mgr } = setup();
    const key = {};
    mgr.attach('alpha', { key, onBytes: () => {} });
    mgr.attach('alpha', { key, onBytes: () => {} });
    expect(mgr.stats()[0].subscribers).toBe(1);
  });

  it('detach decrements refcount; last subscriber tears down client', () => {
    const { mgr, instances } = setup();
    const k1 = {}, k2 = {};
    mgr.attach('alpha', { key: k1, onBytes: () => {} });
    mgr.attach('alpha', { key: k2, onBytes: () => {} });
    mgr.detach('alpha', k1);
    expect(instances[0].stopped).toBe(false);
    expect(mgr.stats()[0].subscribers).toBe(1);
    mgr.detach('alpha', k2);
    expect(instances[0].stopped).toBe(true);
    expect(mgr.stats()).toEqual([]);
  });

  it('detachAll removes a key from every session it was subscribed to', () => {
    const { mgr, instances } = setup();
    const k = {};
    mgr.attach('alpha', { key: k, onBytes: () => {} });
    mgr.attach('beta', { key: k, onBytes: () => {} });
    mgr.attach('beta', { key: {}, onBytes: () => {} });
    mgr.detachAll(k);
    expect(instances[0].stopped).toBe(true);  // alpha had only k
    expect(instances[1].stopped).toBe(false); // beta still has another
    expect(mgr.stats()).toEqual([{ tmuxSession: 'beta', subscribers: 1 }]);
  });

  it('tmux exit drops the session and notifies all subscribers', () => {
    const { mgr, instances } = setup();
    const onExitA = vi.fn(), onExitB = vi.fn();
    mgr.attach('alpha', { key: {}, onBytes: () => {}, onExit: onExitA });
    mgr.attach('alpha', { key: {}, onBytes: () => {}, onExit: onExitB });
    instances[0].cb.onExit!('code 0');
    expect(onExitA).toHaveBeenCalledWith('code 0');
    expect(onExitB).toHaveBeenCalledWith('code 0');
    expect(mgr.stats()).toEqual([]);
  });

  it('re-attaching after tmux exit spawns a fresh client', () => {
    const { mgr, instances } = setup();
    mgr.attach('alpha', { key: {}, onBytes: () => {} });
    instances[0].cb.onExit!('code 0');
    mgr.attach('alpha', { key: {}, onBytes: () => {} });
    expect(instances).toHaveLength(2);
    expect(instances[1].started).toBe(true);
  });

  it('getScrollback delegates to the injected capture function', async () => {
    const { mgr, captureScrollback } = setup();
    const buf = await mgr.getScrollback('alpha');
    expect(captureScrollback).toHaveBeenCalledWith('alpha', 100);
    expect(buf).toEqual(Buffer.from('history-bytes'));
  });

  it('errors from the backing client fan out to subscribers', () => {
    const { mgr, instances } = setup();
    const onErr = vi.fn();
    mgr.attach('alpha', { key: {}, onBytes: () => {}, onError: onErr });
    instances[0].cb.onError!('tmux not running');
    expect(onErr).toHaveBeenCalledWith('tmux not running');
  });

  it('stop() tears down every live session', () => {
    const { mgr, instances } = setup();
    mgr.attach('alpha', { key: {}, onBytes: () => {} });
    mgr.attach('beta', { key: {}, onBytes: () => {} });
    mgr.stop();
    expect(instances[0].stopped).toBe(true);
    expect(instances[1].stopped).toBe(true);
    expect(mgr.stats()).toEqual([]);
  });
});
