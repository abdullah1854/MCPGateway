import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export interface ChronicleMemorySummary {
  id: string;
  title: string;
  kind: '10min' | '6h';
  timestamp: string;
  date: string;
  summary: string;
  source: string;
}

export interface ChronicleMemoryDetail extends ChronicleMemorySummary {
  content: string;
}

const CHRONICLE_RESOURCE_DIR =
  process.env.CHRONICLE_MEMORY_DIR ||
  path.join(os.homedir(), '.codex', 'memories', 'extensions', 'chronicle', 'resources');

const CHRONICLE_FILE_RE =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}-\d{2}-\d{2})-[A-Za-z]{4}-(10min|6h)-(.+)\.md$/;

function isValidDateFilter(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function titleFromContent(content: string, fallback: string): string {
  const heading = content
    .split('\n')
    .map(line => line.trim())
    .find(line => line.startsWith('# '));

  return heading ? heading.replace(/^#\s+/, '').trim() : fallback;
}

function excerptFromContent(content: string): string {
  const lines = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  return lines.slice(0, 5).join(' ').slice(0, 700);
}

function parseChronicleFileName(fileName: string): {
  date: string;
  timestamp: string;
  kind: '10min' | '6h';
  slug: string;
} | null {
  const match = CHRONICLE_FILE_RE.exec(fileName);
  if (!match) return null;

  const [, date, time, kind, slug] = match;
  return {
    date,
    timestamp: `${date}T${time.replaceAll('-', ':')}Z`,
    kind: kind as '10min' | '6h',
    slug: slug.replace(/-/g, ' '),
  };
}

async function readChronicleFile(fileName: string): Promise<string> {
  if (!CHRONICLE_FILE_RE.test(fileName)) {
    throw new Error('Invalid Chronicle memory id');
  }

  const fullPath = path.resolve(CHRONICLE_RESOURCE_DIR, fileName);
  const resourceRoot = path.resolve(CHRONICLE_RESOURCE_DIR);
  if (!fullPath.startsWith(`${resourceRoot}${path.sep}`)) {
    throw new Error('Invalid Chronicle memory path');
  }

  return fs.readFile(fullPath, 'utf8');
}

export async function listChronicleMemories(date = todayUtc()): Promise<{
  date: string;
  memories: ChronicleMemorySummary[];
}> {
  const targetDate = isValidDateFilter(date) ? date : todayUtc();
  const files = await fs.readdir(CHRONICLE_RESOURCE_DIR).catch(() => []);
  const matchingFiles = files
    .map(fileName => ({ fileName, parsed: parseChronicleFileName(fileName) }))
    .filter(
      (entry): entry is {
        fileName: string;
        parsed: NonNullable<ReturnType<typeof parseChronicleFileName>>;
      } => entry.parsed !== null,
    )
    .filter(entry => entry.parsed.date === targetDate)
    .sort((a, b) => b.parsed.timestamp.localeCompare(a.parsed.timestamp));

  const memories = await Promise.all(
    matchingFiles.map(async ({ fileName, parsed }) => {
      const content = await readChronicleFile(fileName);
      return {
        id: fileName,
        title: titleFromContent(content, parsed.slug),
        kind: parsed.kind,
        timestamp: parsed.timestamp,
        date: parsed.date,
        summary: excerptFromContent(content),
        source: fileName,
      };
    }),
  );

  return {
    date: targetDate,
    memories,
  };
}

export async function getChronicleMemory(fileName: string): Promise<ChronicleMemoryDetail> {
  const parsed = parseChronicleFileName(fileName);
  if (!parsed) {
    throw new Error('Invalid Chronicle memory id');
  }

  const content = await readChronicleFile(fileName);
  return {
    id: fileName,
    title: titleFromContent(content, parsed.slug),
    kind: parsed.kind,
    timestamp: parsed.timestamp,
    date: parsed.date,
    summary: excerptFromContent(content),
    source: fileName,
    content,
  };
}
