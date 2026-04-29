import { resolve } from 'node:path';
import { compileExtensionTests, extensionRoot, run } from './common.mjs';

const testsRoot = resolve(extensionRoot, 'tests');

function main() {
  compileExtensionTests();
  run(process.execPath, ['--test', testsRoot]);
}

try {
  main();
} catch (error) {
  console.error('[WorkRoom] Test run failed:', error);
  process.exitCode = 1;
}
