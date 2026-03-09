import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..', '..');
const extensionRoot = resolve(repoRoot, 'apps/extension');
const testsRoot = resolve(extensionRoot, 'tests');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function main() {
  const tscBin = require.resolve('typescript/lib/tsc.js');
  run(process.execPath, [tscBin, '-p', 'apps/extension/tsconfig.tests.json']);
  run(process.execPath, ['--test', testsRoot]);
}

try {
  main();
} catch (error) {
  console.error('[WorkRoom] Test run failed:', error);
  process.exitCode = 1;
}
