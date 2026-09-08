/**
 * Start both example previews after `pnpm build` + example builds.
 * Playwright waits on 4173; the live-HTML fixture is on 4174.
 */
import { spawn } from 'node:child_process';

const kids = [
  spawn(
    'pnpm',
    ['--filter', 'example-vanilla', 'preview', '--host', '127.0.0.1', '--port', '4173'],
    { stdio: 'inherit' },
  ),
  spawn(
    'pnpm',
    ['--filter', 'example-mobile-reader', 'preview', '--host', '127.0.0.1', '--port', '4174'],
    { stdio: 'inherit' },
  ),
];

const shutdown = () => {
  for (const child of kids) child.kill('SIGTERM');
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

for (const child of kids) {
  child.on('exit', (code, signal) => {
    if (signal === 'SIGTERM' || signal === 'SIGINT') return;
    shutdown();
    process.exit(code ?? 1);
  });
}
