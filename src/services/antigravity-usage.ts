/**
 * Antigravity Usage Service
 * Fetches quota and usage data from local Antigravity IDE instances
 *
 * Antigravity stores data in:
 * - ~/.gemini/antigravity/ (primary account)
 * - ~/.gemini/techgravity/ (secondary accounts)
 *
 * When running, the Language Server exposes a gRPC-Web endpoint on localhost
 * Endpoint: /exa.language_server_pb.LanguageServerService/GetUserStatus
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import https from 'https';

const execAsync = promisify(exec);

export interface ModelQuota {
  modelId: string;
  label: string;
  remainingPercentage: number;
  isExhausted: boolean;
  resetTime?: string;
  timeUntilReset?: string;
}

export interface AccountQuota {
  accountId: string;
  accountName?: string;
  accountEmail?: string;
  accountDir: string;
  planName?: string;
  monthlyPromptCredits?: number;
  availablePromptCredits?: number;
  monthlyFlowCredits?: number;
  availableFlowCredits?: number;
  models: ModelQuota[];
  lastUpdated: string;
}

export interface AntigravityStatus {
  isRunning: boolean;
  processId?: number;
  port?: number;
  accounts: AccountQuota[];
  error?: string;
}

export interface ConversationStats {
  totalConversations: number;
  totalSizeBytes: number;
  formattedSize: string;
  recentConversations: number;
}

export interface AntigravitySummary {
  status: AntigravityStatus;
  conversationStats: { [accountId: string]: ConversationStats };
  brainStats: { [accountId: string]: { totalTasks: number; totalSizeBytes: number } };
}

interface LanguageServerInfo {
  pid: number;
  csrfToken: string;
  httpsPort: number;
  appDataDir: string; // 'antigravity' or 'techgravity'
}

// Account directories to scan
const ACCOUNT_DIRS = [
  { id: 'primary', name: 'Antigravity', dir: path.join(os.homedir(), '.gemini', 'antigravity'), appDataDir: 'antigravity' },
  { id: 'techgravity', name: 'Techgravity', dir: path.join(os.homedir(), '.gemini', 'techgravity'), appDataDir: 'techgravity' },
];

// Map email to display name (Antigravity = Abdullah, Techgravity = Sana)
const EMAIL_TO_ACCOUNT: { [email: string]: { id: string; displayName: string } } = {
  'abdullah0094@gmail.com': { id: 'antigravity', displayName: 'Antigravity' },
  'sanaaftab036@gmail.com': { id: 'techgravity', displayName: 'Techgravity' },
};

// Cache for quota data
let cachedStatus: AntigravitySummary | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 10 * 1000; // 10 seconds for more responsive updates

/**
 * Find all running Language Server processes with their CSRF tokens and ports
 */
async function findLanguageServers(): Promise<LanguageServerInfo[]> {
  const servers: LanguageServerInfo[] = [];

  try {
    // Find language_server processes
    const { stdout } = await execAsync(
      'ps aux | grep "language_server_macos" | grep -v grep',
      { timeout: 5000 }
    );

    const lines = stdout.trim().split('\n').filter(Boolean);

    // Get all language server ports via lsof (filter by process name, not -p flag which is buggy on macOS)
    let lsofOutput = '';
    try {
      const { stdout: lsof } = await execAsync(
        'lsof -i -P -n 2>/dev/null | grep "language_" | grep LISTEN',
        { timeout: 5000 }
      );
      lsofOutput = lsof;
    } catch {
      // No ports found
    }

    // Parse lsof output to map PID -> ports
    const pidPorts: Map<number, number[]> = new Map();
    for (const lsofLine of lsofOutput.split('\n').filter(Boolean)) {
      // Format: language_ 75373 abdullah   21u  IPv4  0x585b... TCP 127.0.0.1:64446 (LISTEN)
      const lsofParts = lsofLine.trim().split(/\s+/);
      const lsofPid = parseInt(lsofParts[1], 10);
      const portMatch = lsofLine.match(/:(\d+)\s+\(LISTEN\)/);
      if (!isNaN(lsofPid) && portMatch) {
        const port = parseInt(portMatch[1], 10);
        if (!pidPorts.has(lsofPid)) {
          pidPorts.set(lsofPid, []);
        }
        pidPorts.get(lsofPid)!.push(port);
      }
    }

    for (const line of lines) {
      // Extract PID (second column)
      const parts = line.split(/\s+/);
      const pid = parseInt(parts[1], 10);
      if (isNaN(pid)) continue;

      // Extract CSRF token from command line
      const csrfMatch = line.match(/--csrf_token\s+([a-f0-9-]+)/);
      if (!csrfMatch) continue;
      const csrfToken = csrfMatch[1];

      // Extract app_data_dir to identify which account this is for
      const appDataMatch = line.match(/--app_data_dir\s+(\w+)/);
      const appDataDir = appDataMatch ? appDataMatch[1] : 'antigravity';

      // Get ports for this PID from our parsed lsof output
      const ports = pidPorts.get(pid) || [];
      if (ports.length > 0) {
        // Use the first port (typically the HTTPS port for gRPC-Web)
        servers.push({
          pid,
          csrfToken,
          httpsPort: ports[0],
          appDataDir,
        });
      }
    }
  } catch {
    // No language servers running
  }

  return servers;
}

/**
 * Fetch real-time quota from Language Server's gRPC-Web endpoint
 */
async function fetchQuotaFromLanguageServer(server: LanguageServerInfo): Promise<{
  name?: string;
  email?: string;
  planName?: string;
  monthlyPromptCredits?: number;
  availablePromptCredits?: number;
  monthlyFlowCredits?: number;
  availableFlowCredits?: number;
  models: ModelQuota[];
} | null> {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      metadata: {
        ideName: 'antigravity',
        extensionName: 'antigravity',
        locale: 'en'
      }
    });

    const options = {
      hostname: '127.0.0.1',
      port: server.httpsPort,
      path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': server.csrfToken,
        'Content-Length': Buffer.byteLength(postData),
      },
      rejectUnauthorized: false, // Allow self-signed certs
      timeout: 5000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const userStatus = json.userStatus;
          if (!userStatus) {
            resolve(null);
            return;
          }

          const planInfo = userStatus.planStatus?.planInfo;
          const modelConfigs = userStatus.cascadeModelConfigData?.clientModelConfigs || [];

          const models: ModelQuota[] = modelConfigs.map((config: {
            label?: string;
            modelOrAlias?: { model?: string };
            quotaInfo?: { remainingFraction?: number; resetTime?: string };
          }) => {
            const remainingFraction = config.quotaInfo?.remainingFraction ?? 1;
            const resetTime = config.quotaInfo?.resetTime;

            return {
              modelId: config.modelOrAlias?.model || config.label || 'unknown',
              label: config.label || 'Unknown Model',
              remainingPercentage: Math.round(remainingFraction * 100),
              isExhausted: remainingFraction <= 0,
              resetTime,
              timeUntilReset: resetTime ? formatTimeUntil(resetTime) : undefined,
            };
          });

          resolve({
            name: userStatus.name,
            email: userStatus.email,
            planName: planInfo?.planName,
            monthlyPromptCredits: planInfo?.monthlyPromptCredits,
            availablePromptCredits: userStatus.planStatus?.availablePromptCredits,
            monthlyFlowCredits: planInfo?.monthlyFlowCredits,
            availableFlowCredits: userStatus.planStatus?.availableFlowCredits,
            models,
          });
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

/**
 * Format time until reset
 */
function formatTimeUntil(isoTime: string): string {
  try {
    const resetDate = new Date(isoTime);
    const now = new Date();
    const diffMs = resetDate.getTime() - now.getTime();

    if (diffMs <= 0) return 'Now';

    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  } catch {
    return '';
  }
}

/**
 * Check if Antigravity IDE process is running
 */
async function findAntigravityProcess(): Promise<{ pid: number; port: number } | null> {
  try {
    // Try to find Antigravity-related processes
    // macOS apps: Antigravity.app and TechGravity.app
    const { stdout } = await execAsync(
      'pgrep -f "Antigravity.app|TechGravity.app|gemini-cli|jules" 2>/dev/null || true',
      { timeout: 5000 }
    );

    const pids = stdout.trim().split('\n').filter(Boolean);
    if (pids.length === 0) return null;

    // Try to find listening port for the first PID
    const pid = parseInt(pids[0], 10);

    try {
      const { stdout: lsofOutput } = await execAsync(
        `lsof -i -P -n -p ${pid} 2>/dev/null | grep LISTEN || true`,
        { timeout: 5000 }
      );

      const portMatch = lsofOutput.match(/:(\d+)\s+\(LISTEN\)/);
      if (portMatch) {
        return { pid, port: parseInt(portMatch[1], 10) };
      }
    } catch {
      // Continue without port info
    }

    return { pid, port: 0 };
  } catch {
    return null;
  }
}

/**
 * Get conversation statistics for an account directory
 */
async function getConversationStats(accountDir: string): Promise<ConversationStats> {
  const stats: ConversationStats = {
    totalConversations: 0,
    totalSizeBytes: 0,
    formattedSize: '0 B',
    recentConversations: 0,
  };

  try {
    const conversationsDir = path.join(accountDir, 'conversations');
    const files = await fs.readdir(conversationsDir).catch(() => []);

    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (file.endsWith('.pb')) {
        stats.totalConversations++;

        const filePath = path.join(conversationsDir, file);
        const fileStat = await fs.stat(filePath).catch(() => null);

        if (fileStat) {
          stats.totalSizeBytes += fileStat.size;
          if (fileStat.mtime.getTime() > oneWeekAgo) {
            stats.recentConversations++;
          }
        }
      }
    }

    stats.formattedSize = formatBytes(stats.totalSizeBytes);
  } catch {
    // Directory doesn't exist or can't be read
  }

  return stats;
}

/**
 * Get brain (task) statistics for an account directory
 */
async function getBrainStats(accountDir: string): Promise<{ totalTasks: number; totalSizeBytes: number }> {
  const stats = { totalTasks: 0, totalSizeBytes: 0 };

  try {
    const brainDir = path.join(accountDir, 'brain');
    const entries = await fs.readdir(brainDir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (entry.isDirectory()) {
        stats.totalTasks++;

        // Sum up files in the task directory
        const taskDir = path.join(brainDir, entry.name);
        const taskFiles = await fs.readdir(taskDir).catch(() => []);

        for (const file of taskFiles) {
          const fileStat = await fs.stat(path.join(taskDir, file)).catch(() => null);
          if (fileStat) {
            stats.totalSizeBytes += fileStat.size;
          }
        }
      } else if (entry.name.endsWith('.pb')) {
        // Implicit brain tasks stored as .pb files
        stats.totalTasks++;
        const fileStat = await fs.stat(path.join(brainDir, entry.name)).catch(() => null);
        if (fileStat) {
          stats.totalSizeBytes += fileStat.size;
        }
      }
    }
  } catch {
    // Directory doesn't exist
  }

  return stats;
}

/**
 * Get the active Google account email if available
 */
async function getActiveAccountEmail(): Promise<string | undefined> {
  try {
    const accountsFile = path.join(os.homedir(), '.gemini', 'google_accounts.json');
    const content = await fs.readFile(accountsFile, 'utf-8');
    const data = JSON.parse(content);
    return data.active;
  } catch {
    return undefined;
  }
}

/**
 * Create default quota data (fallback when API unavailable)
 */
function createDefaultQuotaModels(): ModelQuota[] {
  return [
    { modelId: 'gemini-3-pro-high', label: 'Gemini 3 Pro (High)', remainingPercentage: 100, isExhausted: false },
    { modelId: 'gemini-3-flash', label: 'Gemini 3 Flash', remainingPercentage: 100, isExhausted: false },
    { modelId: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', remainingPercentage: 100, isExhausted: false },
    { modelId: 'claude-sonnet-4.5-thinking', label: 'Claude 4.5 (Thinking)', remainingPercentage: 100, isExhausted: false },
    { modelId: 'claude-opus-4.5', label: 'Claude Opus 4.5', remainingPercentage: 100, isExhausted: false },
    { modelId: 'gpt-oss-120b', label: 'gpt-oss-120b', remainingPercentage: 100, isExhausted: false },
  ];
}

/**
 * Get Antigravity usage summary
 */
export async function getAntigravitySummary(forceRefresh = false): Promise<AntigravitySummary> {
  const now = Date.now();

  if (!forceRefresh && cachedStatus && (now - cacheTimestamp) < CACHE_TTL) {
    return cachedStatus;
  }

  const processInfo = await findAntigravityProcess();
  const languageServers = await findLanguageServers();
  const fallbackEmail = await getActiveAccountEmail();

  const status: AntigravityStatus = {
    isRunning: processInfo !== null || languageServers.length > 0,
    processId: processInfo?.pid || languageServers[0]?.pid,
    port: processInfo?.port || languageServers[0]?.httpsPort,
    accounts: [],
  };

  const conversationStats: { [key: string]: ConversationStats } = {};
  const brainStats: { [key: string]: { totalTasks: number; totalSizeBytes: number } } = {};

  // Get file-based stats for each account directory
  for (const account of ACCOUNT_DIRS) {
    try {
      await fs.access(account.dir);
      conversationStats[account.id] = await getConversationStats(account.dir);
      brainStats[account.id] = await getBrainStats(account.dir);
    } catch {
      // Directory doesn't exist
    }
  }

  // Query ALL language servers to get real-time account data
  // Multiple servers can be logged into different Google accounts
  const seenEmails = new Set<string>();

  for (const server of languageServers) {
    const realQuota = await fetchQuotaFromLanguageServer(server);
    if (realQuota && realQuota.email && !seenEmails.has(realQuota.email)) {
      seenEmails.add(realQuota.email);

      // Map email to account name (Antigravity = Abdullah, Techgravity = Sana)
      const accountMapping = EMAIL_TO_ACCOUNT[realQuota.email];
      const accountId = accountMapping?.id || realQuota.email.split('@')[0];
      const displayName = accountMapping?.displayName || realQuota.name || 'Unknown';

      // Find the account directory
      const accountDir = ACCOUNT_DIRS.find(a => a.id === accountId || a.id === 'primary');

      const accountQuota: AccountQuota = {
        accountId,
        accountName: displayName,
        accountEmail: realQuota.email,
        accountDir: accountDir?.dir || '',
        planName: realQuota.planName,
        monthlyPromptCredits: realQuota.monthlyPromptCredits,
        availablePromptCredits: realQuota.availablePromptCredits,
        monthlyFlowCredits: realQuota.monthlyFlowCredits,
        availableFlowCredits: realQuota.availableFlowCredits,
        models: realQuota.models,
        lastUpdated: new Date().toISOString(),
      };

      status.accounts.push(accountQuota);
    }
  }

  // If no accounts found from language servers, fall back to directory-based accounts
  if (status.accounts.length === 0) {
    for (const account of ACCOUNT_DIRS) {
      try {
        await fs.access(account.dir);

        const accountQuota: AccountQuota = {
          accountId: account.id,
          accountName: account.name,
          accountDir: account.dir,
          accountEmail: account.id === 'primary' ? fallbackEmail : undefined,
          models: createDefaultQuotaModels(),
          lastUpdated: new Date().toISOString(),
        };

        status.accounts.push(accountQuota);
      } catch {
        // Directory doesn't exist
      }
    }
  }

  const summary: AntigravitySummary = {
    status,
    conversationStats,
    brainStats,
  };

  cachedStatus = summary;
  cacheTimestamp = now;

  return summary;
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Clear the cache
 */
export function clearAntigravityCache(): void {
  cachedStatus = null;
  cacheTimestamp = 0;
}

/**
 * Check if any Antigravity accounts exist
 */
export async function hasAntigravityAccounts(): Promise<boolean> {
  for (const account of ACCOUNT_DIRS) {
    try {
      await fs.access(account.dir);
      return true;
    } catch {
      // Continue checking
    }
  }
  return false;
}
