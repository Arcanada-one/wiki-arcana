import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [target, commandName, ...forwardedArguments] = process.argv.slice(2);
const allowedCommands = new Map([
  ['storage:seed', 'scripts/storage-seed.ts'],
  ['storage:benchmark', 'scripts/storage-benchmark.ts'],
  ['storage:verdict', 'scripts/storage-verdict.ts'],
]);

if (!commandName || !target || allowedCommands.get(commandName) !== target) {
  console.error('invalid deferred storage command');
  process.exit(2);
}

if (!existsSync(resolve(root, target))) {
  console.error(`${commandName} is unavailable until its implementation phase`);
  process.exit(2);
}

const result = spawnSync('pnpm', ['exec', 'tsx', target, ...forwardedArguments], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});

if (result.error) {
  console.error(`${commandName} could not start`);
  process.exit(1);
}

process.exit(result.status ?? 1);
