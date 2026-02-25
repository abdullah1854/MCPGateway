/**
 * MCP Gateway - Startup Banner
 *
 * Prints a professional ASCII art banner with system info on startup.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ANSI color codes
const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  white:   '\x1b[37m',
};

export interface BannerOptions {
  host: string;
  port: number;
  backendCount: number;
  toolCount: number;
  resourceCount: number;
  name: string;
}

function getVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pkgPath = resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

export function printStartupBanner(options: BannerOptions): void {
  const { host, port, backendCount, toolCount, resourceCount, name } = options;

  const version = getVersion();
  const nodeVersion = process.version;
  const startTime = new Date().toLocaleTimeString('en-US', { hour12: true });
  const baseUrl = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;

  // Hand-crafted ASCII art logo
  const logo = [
    `${c.cyan}${c.bold}`,
    `    ███╗   ███╗ ██████╗██████╗`,
    `    ████╗ ████║██╔════╝██╔══██╗`,
    `    ██╔████╔██║██║     ██████╔╝`,
    `    ██║╚██╔╝██║██║     ██╔═══╝`,
    `    ██║ ╚═╝ ██║╚██████╗██║`,
    `    ╚═╝     ╚═╝ ╚═════╝╚═╝`,
    ``,
    `     ██████╗  █████╗ ████████╗███████╗██╗    ██╗ █████╗ ██╗   ██╗`,
    `    ██╔════╝ ██╔══██╗╚══██╔══╝██╔════╝██║    ██║██╔══██╗╚██╗ ██╔╝`,
    `    ██║  ███╗███████║   ██║   █████╗  ██║ █╗ ██║███████║ ╚████╔╝`,
    `    ██║   ██║██╔══██║   ██║   ██╔══╝  ██║███╗██║██╔══██║  ╚██╔╝`,
    `    ╚██████╔╝██║  ██║   ██║   ███████╗╚███╔███╔╝██║  ██║   ██║`,
    `     ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝ ╚══╝╚══╝ ╚═╝  ╚═╝   ╚═╝`,
    `${c.reset}`,
  ].join('\n');

  const line = `${c.dim}   ${'─'.repeat(64)}${c.reset}`;
  const dots = `${c.dim}   ${'·'.repeat(64)}${c.reset}`;

  const row = (label: string, value: string): string => {
    return `   ${c.dim}${label.padEnd(20)}${c.reset}${value}`;
  };

  const output = [
    '',
    logo,
    line,
    '',
    row('Name',    `${c.cyan}${c.bold}${name}${c.reset}`),
    row('Version', `${c.green}v${version}${c.reset}`),
    row('Node.js', `${c.white}${nodeVersion}${c.reset}`),
    row('Started', `${c.white}${startTime}${c.reset}`),
    '',
    dots,
    '',
    `   ${c.green}${c.bold}  Endpoints${c.reset}`,
    '',
    row('HTTP Streamable', `${c.white}${baseUrl}/mcp${c.reset}`),
    row('SSE Transport',   `${c.white}${baseUrl}/sse${c.reset}`),
    row('Dashboard',       `${c.cyan}${c.bold}${baseUrl}/dashboard${c.reset}`),
    row('Health',          `${c.white}${baseUrl}/health${c.reset}`),
    row('Metrics',         `${c.white}${baseUrl}/metrics${c.reset}`),
    '',
    dots,
    '',
    `   ${c.green}${c.bold}  Status${c.reset}`,
    '',
    row('Backends',  `${c.green}${c.bold}${backendCount}${c.reset} ${c.dim}loaded${c.reset}`),
    row('Tools',     `${c.green}${c.bold}${toolCount}${c.reset} ${c.dim}available${c.reset}`),
    row('Resources', `${c.green}${c.bold}${resourceCount}${c.reset} ${c.dim}registered${c.reset}`),
    '',
    line,
    '',
    `   ${c.dim}Ready for connections from Claude, Cursor, Codex, and VS Code${c.reset}`,
    '',
  ];

  console.log(output.join('\n'));
}
