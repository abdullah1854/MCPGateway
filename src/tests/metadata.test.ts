/**
 * Lightweight validation for marketplace-facing metadata and documentation.
 *
 * Run with:
 *
 *   npx tsx src/tests/metadata.test.ts
 */

import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// Covers the README opening area where badges, quick links, and install guidance should remain visible.
const README_TOP_SECTION_LENGTH = 2500;

async function findRepoRoot(startDir: string): Promise<string> {
  let candidate = startDir;

  while (true) {
    try {
      await access(path.join(candidate, 'package.json'));
      return candidate;
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw new Error('Could not locate repository root from metadata test');
      }
      candidate = parent;
    }
  }
}

function extractRepositorySlug(url: string | undefined): string {
  const normalized = normalizeRepositoryUrl(url);
  const match = normalized.match(/github\.com\/[^/]+\/[^/]+/);

  if (!match) {
    throw new Error(`Could not derive GitHub repository slug from: ${url}`);
  }

  return match[0];
}

function normalizeRepositoryUrl(url: string | undefined): string {
  if (!url) {
    return '';
  }

  let normalized = url;

  if (normalized.startsWith('git+')) {
    normalized = normalized.slice(4);
  }
  if (normalized.endsWith('.git')) {
    normalized = normalized.slice(0, -4);
  }
  if (normalized.endsWith('#readme')) {
    normalized = normalized.slice(0, -7);
  }

  return normalized;
}

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
  const repoRoot = await findRepoRoot(currentDir);
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const readmePath = path.join(repoRoot, 'README.md');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    homepage?: string;
    repository?: { url?: string } | string;
    bugs?: { url?: string };
    author?: string | { name?: string; url?: string };
    keywords?: string[];
  };
  const readme = await readFile(readmePath, 'utf8');
  const repositoryUrl = typeof packageJson.repository === 'string'
    ? packageJson.repository
    : packageJson.repository?.url;
  const repositorySlug = extractRepositorySlug(repositoryUrl ?? packageJson.homepage);

  console.log('Running metadata validation tests...\n');

  await runTest('package.json includes repository trust metadata', async () => {
    if (!packageJson.homepage?.includes(repositorySlug)) {
      throw new Error(`Missing or invalid homepage: ${packageJson.homepage}`);
    }

    if (!repositoryUrl?.includes(repositorySlug)) {
      throw new Error(`Missing or invalid repository URL: ${repositoryUrl}`);
    }

    if (!packageJson.bugs?.url?.includes(`${repositorySlug}/issues`)) {
      throw new Error(`Missing or invalid bugs URL: ${packageJson.bugs?.url}`);
    }

    const authorName = typeof packageJson.author === 'string'
      ? packageJson.author.trim()
      : packageJson.author?.name?.trim();
    if (!authorName) {
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
    const firstSection = readme.slice(0, README_TOP_SECTION_LENGTH);
    const orderedSnippets = [
      'img.shields.io',
      'https://lobehub.com/badge/mcp/abdullah1854-mcpgateway',
      'https://lobehub.com/mcp/abdullah1854-mcpgateway',
      '## Quick Links',
      '## Quick Start in 3 Commands',
      '## Supported MCP Clients',
    ];

    let previousIndex = -1;
    for (const snippet of orderedSnippets) {
      const snippetIndex = firstSection.indexOf(snippet);
      if (snippetIndex === -1) {
        throw new Error(`README top section is missing: ${snippet}`);
      }
      if (snippetIndex < previousIndex) {
        throw new Error(`README top section has unexpected snippet order around: ${snippet}`);
      }
      previousIndex = snippetIndex;
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

async function runIfEntryPoint(): Promise<void> {
  const currentFilePath = await realpath(fileURLToPath(import.meta.url));
  let entryPath = currentFilePath;

  if (process.argv[1]) {
    try {
      entryPath = await realpath(path.resolve(process.argv[1]));
    } catch {
      entryPath = path.resolve(process.argv[1]);
    }
  }

  if (entryPath === currentFilePath) {
    await main();
  }
}

void runIfEntryPoint();
