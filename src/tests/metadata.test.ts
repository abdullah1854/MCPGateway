/**
 * Lightweight validation for marketplace-facing metadata and documentation.
 *
 * Run with:
 *
 *   npx tsx src/tests/metadata.test.ts
 */

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../..');

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    process.stdout.write(`• ${name}... `);
    await fn();
    console.log(`✔ (${Date.now() - start}ms)`);
  } catch (error) {
    console.log('✘ FAILED');
    console.error(error);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const readmePath = path.join(repoRoot, 'README.md');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    homepage?: string;
    repository?: { url?: string } | string;
    bugs?: { url?: string };
    author?: string;
    keywords?: string[];
  };
  const readme = await readFile(readmePath, 'utf8');

  console.log('Running metadata validation tests...\n');

  await runTest('package.json includes repository trust metadata', async () => {
    if (!packageJson.homepage?.includes('github.com/abdullah1854/MCPGateway')) {
      throw new Error(`Missing or invalid homepage: ${packageJson.homepage}`);
    }

    const repositoryUrl = typeof packageJson.repository === 'string'
      ? packageJson.repository
      : packageJson.repository?.url;
    if (!repositoryUrl?.includes('github.com/abdullah1854/MCPGateway')) {
      throw new Error(`Missing or invalid repository URL: ${repositoryUrl}`);
    }

    if (!packageJson.bugs?.url?.includes('github.com/abdullah1854/MCPGateway/issues')) {
      throw new Error(`Missing or invalid bugs URL: ${packageJson.bugs?.url}`);
    }

    if (!packageJson.author?.trim()) {
      throw new Error('author must be non-empty');
    }
  });

  await runTest('package.json keywords cover MCP listing discovery terms', async () => {
    const keywords = new Set(packageJson.keywords ?? []);
    const expectedKeywords = [
      'mcp',
      'model-context-protocol',
      'gateway',
      'dashboard',
      'token-optimization',
      'typescript',
    ];

    for (const keyword of expectedKeywords) {
      if (!keywords.has(keyword)) {
        throw new Error(`Missing keyword: ${keyword}`);
      }
    }
  });

  await runTest('README exposes quick-install and trust signals near the top', async () => {
    const firstSection = readme.split('## How MCP Gateway Complements Anthropic')[0] ?? readme.slice(0, 2000);
    const requiredSnippets = [
      'img.shields.io',
      '## Quick Links',
      '## Quick Start in 3 Commands',
      '## Supported MCP Clients',
    ];

    for (const snippet of requiredSnippets) {
      if (!firstSection.includes(snippet)) {
        throw new Error(`README top section is missing: ${snippet}`);
      }
    }
  });

  await runTest('README screenshot references point to existing files', async () => {
    const screenshotMatches = [...readme.matchAll(/!\[[^\]]*]\((screenshots\/[^)]+)\)/g)];
    if (screenshotMatches.length === 0) {
      throw new Error('Expected README to reference at least one screenshot');
    }

    for (const match of screenshotMatches) {
      const screenshotPath = path.join(repoRoot, match[1]);
      await access(screenshotPath);
    }
  });

  console.log('\nMetadata validation completed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
