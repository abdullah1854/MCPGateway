/**
 * Claude Usage Service
 * Reads and aggregates Claude Code usage data from JSONL conversation logs
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);

export interface ModelBreakdown {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
}

export interface DailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  modelsUsed: string[];
  modelBreakdowns: ModelBreakdown[];
}

export interface UsageSummary {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  cacheHitRatio: number;
  daysActive: number;
  avgCostPerDay: number;
  topDays: DailyUsage[];
  modelDistribution: { model: string; cost: number; percentage: number }[];
  daily: DailyUsage[];
}

export interface SessionUsage {
  sessionId: string;
  slug?: string;
  startTime: string;
  endTime?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCost: number;
  model: string;
}

// Cache for usage data (refresh every 5 minutes)
let cachedUsageData: UsageSummary | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get usage data using ccusage CLI tool (most reliable method)
 */
export async function getUsageViaCcusage(): Promise<UsageSummary | null> {
  try {
    const { stdout } = await execAsync('npx ccusage@latest --json 2>/dev/null', {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    const data = JSON.parse(stdout);
    return processUsageData(data.daily || []);
  } catch (error) {
    console.error('Failed to get usage via ccusage:', error);
    return null;
  }
}

/**
 * Get usage data for a specific date range
 */
export async function getUsageByDateRange(
  since?: string,
  until?: string
): Promise<UsageSummary | null> {
  try {
    let command = 'npx ccusage@latest --json';
    if (since) command += ` --since ${since}`;
    if (until) command += ` --until ${until}`;
    command += ' 2>/dev/null';

    const { stdout } = await execAsync(command, {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const data = JSON.parse(stdout);
    return processUsageData(data.daily || []);
  } catch (error) {
    console.error('Failed to get usage by date range:', error);
    return null;
  }
}

/**
 * Get current session usage (live monitoring)
 */
export async function getCurrentSessionUsage(): Promise<SessionUsage | null> {
  try {
    // Find the most recent JSONL file in projects directory
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');

    // Get all project directories
    const projects = await fs.readdir(claudeDir).catch(() => []);

    let latestFile: { path: string; mtime: Date } | null = null;

    for (const project of projects) {
      const projectPath = path.join(claudeDir, project);
      const stat = await fs.stat(projectPath).catch(() => null);

      if (stat?.isDirectory()) {
        const files = await fs.readdir(projectPath).catch(() => []);

        for (const file of files) {
          if (file.endsWith('.jsonl') && !file.startsWith('agent-')) {
            const filePath = path.join(projectPath, file);
            const fileStat = await fs.stat(filePath).catch(() => null);

            if (fileStat && (!latestFile || fileStat.mtime > latestFile.mtime)) {
              latestFile = { path: filePath, mtime: fileStat.mtime };
            }
          }
        }
      }
    }

    if (!latestFile) return null;

    // Read and parse the latest session
    const content = await fs.readFile(latestFile.path, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    let sessionUsage: SessionUsage = {
      sessionId: path.basename(latestFile.path, '.jsonl'),
      startTime: '',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCost: 0,
      model: '',
    };

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        if (entry.timestamp && !sessionUsage.startTime) {
          sessionUsage.startTime = entry.timestamp;
        }

        if (entry.slug) {
          sessionUsage.slug = entry.slug;
        }

        if (entry.timestamp) {
          sessionUsage.endTime = entry.timestamp;
        }

        // Extract usage from assistant messages
        if (entry.type === 'assistant' && entry.message?.usage) {
          const usage = entry.message.usage;
          sessionUsage.inputTokens += usage.input_tokens || 0;
          sessionUsage.outputTokens += usage.output_tokens || 0;
          sessionUsage.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
          sessionUsage.cacheReadTokens += usage.cache_read_input_tokens || 0;

          if (entry.message.model) {
            sessionUsage.model = entry.message.model;
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Calculate approximate cost
    sessionUsage.totalCost = calculateCost(
      sessionUsage.inputTokens,
      sessionUsage.outputTokens,
      sessionUsage.cacheCreationTokens,
      sessionUsage.cacheReadTokens,
      sessionUsage.model
    );

    return sessionUsage;
  } catch (error) {
    console.error('Failed to get current session usage:', error);
    return null;
  }
}

/**
 * Process raw daily usage data into a summary
 */
function processUsageData(daily: DailyUsage[]): UsageSummary {
  if (!daily.length) {
    return {
      totalCost: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      cacheHitRatio: 0,
      daysActive: 0,
      avgCostPerDay: 0,
      topDays: [],
      modelDistribution: [],
      daily: [],
    };
  }

  const totals = daily.reduce(
    (acc, day) => ({
      cost: acc.cost + day.totalCost,
      input: acc.input + day.inputTokens,
      output: acc.output + day.outputTokens,
      cacheCreation: acc.cacheCreation + day.cacheCreationTokens,
      cacheRead: acc.cacheRead + day.cacheReadTokens,
    }),
    { cost: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }
  );

  // Calculate model distribution
  const modelCosts = new Map<string, number>();
  for (const day of daily) {
    for (const breakdown of day.modelBreakdowns || []) {
      const current = modelCosts.get(breakdown.modelName) || 0;
      modelCosts.set(breakdown.modelName, current + breakdown.cost);
    }
  }

  const modelDistribution = Array.from(modelCosts.entries())
    .map(([model, cost]) => ({
      model: formatModelName(model),
      cost,
      percentage: totals.cost > 0 ? (cost / totals.cost) * 100 : 0,
    }))
    .sort((a, b) => b.cost - a.cost);

  // Get top 5 usage days
  const topDays = [...daily]
    .sort((a, b) => b.totalCost - a.totalCost)
    .slice(0, 5);

  // Calculate cache hit ratio
  const totalCacheOperations = totals.cacheCreation + totals.cacheRead;
  const cacheHitRatio = totalCacheOperations > 0
    ? (totals.cacheRead / totalCacheOperations) * 100
    : 0;

  return {
    totalCost: totals.cost,
    totalInputTokens: totals.input,
    totalOutputTokens: totals.output,
    totalCacheCreationTokens: totals.cacheCreation,
    totalCacheReadTokens: totals.cacheRead,
    cacheHitRatio,
    daysActive: daily.length,
    avgCostPerDay: daily.length > 0 ? totals.cost / daily.length : 0,
    topDays,
    modelDistribution,
    daily: daily.sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * Format model name for display
 */
function formatModelName(model: string): string {
  if (model.includes('opus')) return 'Claude Opus';
  if (model.includes('sonnet')) return 'Claude Sonnet';
  if (model.includes('haiku')) return 'Claude Haiku';
  return model;
}

/**
 * Calculate approximate cost based on model pricing
 */
function calculateCost(
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  model: string
): number {
  // Approximate pricing per 1M tokens (as of late 2024)
  const pricing: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
    opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
    sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    haiku: { input: 0.25, output: 1.25, cacheWrite: 0.3, cacheRead: 0.03 },
  };

  let tier = 'sonnet';
  if (model.includes('opus')) tier = 'opus';
  else if (model.includes('haiku')) tier = 'haiku';

  const p = pricing[tier];
  const cost =
    (inputTokens / 1_000_000) * p.input +
    (outputTokens / 1_000_000) * p.output +
    (cacheCreationTokens / 1_000_000) * p.cacheWrite +
    (cacheReadTokens / 1_000_000) * p.cacheRead;

  return cost;
}

/**
 * Get cached usage data or fetch fresh
 */
export async function getCachedUsageData(forceRefresh = false): Promise<UsageSummary | null> {
  const now = Date.now();

  if (!forceRefresh && cachedUsageData && (now - cacheTimestamp) < CACHE_TTL) {
    return cachedUsageData;
  }

  cachedUsageData = await getUsageViaCcusage();
  cacheTimestamp = now;

  return cachedUsageData;
}

/**
 * Clear usage cache
 */
export function clearUsageCache(): void {
  cachedUsageData = null;
  cacheTimestamp = 0;
}
