import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { TmuxControlClient, decodeTmuxEscape } from '../TmuxControlClient.js';

// Fake child process that mimics what tmux -CC stdout looks like. We drive
// parsing via `feedForTest` instead of a real subprocess so tests are fast
// and deterministic.
function makeFakeChild() {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stderr.setEncoding = () => {};
  const stdin = { write: vi.fn(), end: vi.fn() };
  const child: any = Object.assign(new EventEmitter(), {
    stdout, stderr, stdin,
    kill: vi.fn(),
  });
  return child;
}

describe('decodeTmuxEscape', () => {
  it('passes printable ASCII through unchanged', () => {
    const out = decodeTmuxEscape('hello world');
    expect(out.toString('utf8')).toBe('hello world');
  });

  it('decodes three-digit octal escapes', () => {
    // \012 = newline, \015 = CR, \011 = tab
    const out = decodeTmuxEscape('line1\\012line2\\015\\011end');
    expect(out.toString('binary')).toBe('line1\nline2\r\tend');
  });

  it('decodes backslash (emitted by tmux as \\134)', () => {
    const out = decodeTmuxEscape('path\\134home');
    expect(out.toString('binary')).toBe('path\\home');
  });

  it('decodes ANSI escape (ESC is \\033)', () => {
    const out = decodeTmuxEscape('\\033[31mred\\033[0m');
    expect(out.toString('binary')).toBe('\x1b[31mred\x1b[0m');
  });

  it('passes high-bit and DEL bytes through from their octal form', () => {
    // \177 = DEL (0x7f), \200 = 0x80
    const out = decodeTmuxEscape('\\177\\200');
    expect(out.length).toBe(2);
    expect(out[0]).toBe(0x7f);
    expect(out[1]).toBe(0x80);
  });

  it('handles empty input', () => {
    expect(decodeTmuxEscape('').length).toBe(0);
  });

  it('leaves a malformed trailing backslash alone (no crash)', () => {
    // A lone trailing backslash shouldn't exist in real tmux output, but
    // we should not drop bytes if it appears.
    const out = decodeTmuxEscape('abc\\');
    expect(out.toString('binary')).toBe('abc\\');
  });
});

describe('TmuxControlClient', () => {
  function setup() {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(fake) as any;
    const onBytes = vi.fn();
    const onExit = vi.fn();
    const onError = vi.fn();
    const client = new TmuxControlClient(
      { tmuxSession: 'worker-abc', spawnFn, declaredSize: { width: 80, height: 24 } },
      { onBytes, onExit, onError },
    );
    return { client, fake, spawnFn, onBytes, onExit, onError };
  }

  it('spawns tmux -C attach -r -t =<session>: with the right args', () => {
    const { client, spawnFn } = setup();
    client.start();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnFn.mock.calls[0];
    expect(cmd).toBe('tmux');
    expect(args).toEqual(['-C', 'attach', '-r', '-t', '=worker-abc:']);
  });

  it('writes an initial refresh-client to declare a large size', () => {
    const { client, fake } = setup();
    client.start();
    expect(fake.stdin.write).toHaveBeenCalledWith('refresh-client -C 80x24\n');
  });

  it('emits decoded bytes for %output lines', () => {
    const { client, onBytes } = setup();
    client.start();
    // Two pane-output events in one chunk with a trailing partial line.
    client.feedForTest('%output %0 hello\\012world\n%output %0 second\n%begin 1 1 0\n');
    expect(onBytes).toHaveBeenCalledTimes(2);
    expect(onBytes.mock.calls[0][0].toString('utf8')).toBe('hello\nworld');
    expect(onBytes.mock.calls[1][0].toString('utf8')).toBe('second');
  });

  it('buffers incomplete lines across stdout chunks', () => {
    const { client, onBytes } = setup();
    client.start();
    client.feedForTest('%output %0 hel');
    expect(onBytes).not.toHaveBeenCalled();
    client.feedForTest('lo\\012there\n');
    expect(onBytes).toHaveBeenCalledTimes(1);
    expect(onBytes.mock.calls[0][0].toString('utf8')).toBe('hello\nthere');
  });

  it('fires onExit on %exit event', () => {
    const { client, onExit } = setup();
    client.start();
    client.feedForTest('%exit\n');
    expect(onExit).toHaveBeenCalledWith(undefined);
  });

  it('fires onExit with reason when %exit carries one', () => {
    const { client, onExit } = setup();
    client.start();
    client.feedForTest('%exit detached\n');
    expect(onExit).toHaveBeenCalledWith('detached');
  });

  it('fires onError on %error event and stderr chunk', () => {
    const { client, fake, onError } = setup();
    client.start();
    client.feedForTest('%error something broke\n');
    expect(onError).toHaveBeenCalledWith('something broke');
    fake.stderr.emit('data', 'unknown target\n');
    expect(onError).toHaveBeenCalledWith('unknown target');
  });

  it('ignores structural events (%begin, %end, %window-close, etc.)', () => {
    const { client, onBytes, onExit, onError } = setup();
    client.start();
    client.feedForTest('%begin 1 1 0\n%end 1 1 0\n%window-close @2\n%session-changed $0 foo\n');
    expect(onBytes).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('stop() kills the child and suppresses the exit callback', () => {
    const { client, fake, onExit } = setup();
    client.start();
    client.stop();
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
    expect(fake.stdin.end).toHaveBeenCalled();
    // Child exits as a side-effect of the kill — the client should swallow
    // it because stop() was intentional.
    fake.emit('exit', null, 'SIGTERM');
    expect(onExit).not.toHaveBeenCalled();
  });

  it('fires onExit when the child exits unexpectedly (without stop())', () => {
    const { client, fake, onExit } = setup();
    client.start();
    fake.emit('exit', 1, null);
    expect(onExit).toHaveBeenCalledWith('code 1');
  });

  it('start() is idempotent — second call does not spawn a second child', () => {
    const { client, spawnFn } = setup();
    client.start();
    client.start();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});
