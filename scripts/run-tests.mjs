#!/usr/bin/env node
/**
 * Discover and run all gateway test entrypoints under src/tests and sandbox tests.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));

function collectTests(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectTests(full));
      continue;
    }
    if (entry.endsWith('.test.ts') && !entry.endsWith('.e2e.test.ts')) {
      files.push(full);
    }
  }
  return files.sort();
}

const OPTIONAL_DOC_TESTS = new Set(['metadata.test.ts']);

const tests = [
  join(root, 'src/code-execution/executor.sandbox.test.ts'),
  ...collectTests(join(root, 'src/tests')).filter(
    file => !OPTIONAL_DOC_TESTS.has(file.split('/').pop() ?? ''),
  ),
];

let failed = 0;

for (const testFile of tests) {
  console.log(`\n==> ${testFile.replace(`${root}/`, '')}`);
  const result = spawnSync('tsx', [testFile], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`\n${failed} test suite(s) failed`);
  process.exit(1);
}

console.log(`\nAll ${tests.length} test suite(s) passed`);