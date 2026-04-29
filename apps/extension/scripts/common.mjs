import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

export const repoRoot = resolve(__dirname, '..', '..', '..');
export const extensionRoot = resolve(repoRoot, 'apps/extension');
export const testBuildRoot = resolve(extensionRoot, '.test-build');

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

export function getTypeScriptBin() {
  return require.resolve('typescript/lib/tsc.js');
}

export function compileExtensionTests() {
  run(process.execPath, [getTypeScriptBin(), '-p', resolve(extensionRoot, 'tsconfig.tests.json')]);
}
