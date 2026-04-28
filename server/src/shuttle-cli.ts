/**
 * Shuttle CLI — long-lived poller you can run in a terminal.
 *
 * Usage (from `server/`):
 *   npx tsx src/shuttle-cli.ts                   # default: ~/loom, smoke-test queue
 *   npx tsx src/shuttle-cli.ts --once            # one tick, then exit
 *   npx tsx src/shuttle-cli.ts --queue ai-futures/portolan/shuttle/tests
 *   npx tsx src/shuttle-cli.ts --queue '*'       # no scoping (all constitution-tagged)
 *   npx tsx src/shuttle-cli.ts --interval 10000  # 10s poll interval
 *   npx tsx src/shuttle-cli.ts --dry-run         # log dispatch decisions, do NOT spawn
 *
 * Watch live:    `tmux ls | grep ^ralph-`
 * Inspect work:  `git -C ~/loom log --oneline -- .felt/<queue>/`
 *
 * This is the v0 entrypoint. When portolan grows a kanban view, this
 * CLI's snapshot stream is what feeds it.
 */

import { homedir } from 'os';
import { join } from 'path';
import { Shuttle, defaultShuttleConfig, ralphSessionName, type ShuttleSnapshot } from './Shuttle.js';

interface CliArgs {
  feltHost: string;
  queuePrefixes: string[] | undefined;
  intervalMs: number;
  once: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    feltHost: join(homedir(), 'loom'),
    queuePrefixes: ['ai-futures/portolan/shuttle/tests'],
    intervalMs: 30_000,
    once: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') args.once = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--host') args.feltHost = argv[++i];
    else if (a === '--queue') {
      const v = argv[++i];
      args.queuePrefixes = v === '*' ? undefined : v.split(',').map(s => s.trim()).filter(Boolean);
    } else if (a === '--interval') args.intervalMs = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(
        [
          'Shuttle CLI — fiber-as-ticket orchestrator',
          '',
          'Usage:',
          '  npx tsx src/shuttle-cli.ts [flags]',
          '',
          'Flags:',
          '  --once               One tick then exit (smoke-test friendly)',
          '  --dry-run            Print dispatch plan; do not spawn workers',
          '  --host <path>        Felt host root (default: ~/loom)',
          "  --queue <a,b,...>    Comma-list of ID prefixes to scope to (default: 'ai-futures/portolan/shuttle/tests'). Use '*' for unscoped.",
          '  --interval <ms>      Poll interval (default: 30000)',
          '',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function formatSnapshot(snap: ShuttleSnapshot): string {
  const ts = new Date(snap.pollAt).toISOString().slice(11, 19);
  const lines = [`[${ts}] tick — eligible=${snap.eligible.length} blocked=${snap.blocked.length} orphans=${snap.orphans.length}`];
  for (const e of snap.eligible) {
    const sess = e.tmuxSession ?? '(no session)';
    const reason = e.reason ? `  ${e.reason}` : '';
    lines.push(`  ▶ ${e.fiberId.padEnd(60)} ${e.state.padEnd(8)} ${sess}${reason}`);
  }
  for (const b of snap.blocked) {
    lines.push(`  ⏸ ${b.fiberId.padEnd(60)} ${b.reason}`);
  }
  for (const o of snap.orphans) {
    lines.push(`  ◌ orphan tmux session: ${o}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('Shuttle CLI starting');
  console.log(`  feltHost:       ${args.feltHost}`);
  console.log(`  queuePrefixes:  ${args.queuePrefixes ? args.queuePrefixes.join(', ') : '(unscoped — all constitution fibers)'}`);
  console.log(`  pollIntervalMs: ${args.intervalMs}`);
  console.log(`  mode:           ${args.once ? 'one-shot' : 'polling'}${args.dryRun ? ' (dry-run)' : ''}`);
  console.log('');

  const cfg = defaultShuttleConfig({
    feltHost: args.feltHost,
    queuePrefixes: args.queuePrefixes,
    pollIntervalMs: args.intervalMs,
    onSnapshot: (snap) => console.log(formatSnapshot(snap)),
  });

  if (args.dryRun) {
    cfg.spawnRalph = (id) => {
      console.log(`  [dry-run] would spawn ralph for ${id}`);
      return ralphSessionName(id);
    };
  }

  const shuttle = new Shuttle(cfg);

  if (args.once) {
    await shuttle.tick();
    return;
  }

  shuttle.start();

  // Graceful shutdown — does NOT kill workers; they own their lifecycle.
  const stop = () => {
    console.log('\nShuttle CLI stopping (workers continue running).');
    shuttle.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('Shuttle CLI fatal:', err);
  process.exit(1);
});
