/**
 * Graceful Shutdown Service
 *
 * Handles SIGTERM, SIGINT, and SIGUSR2 (nodemon) signals with:
 * - Connection draining (stop accepting new, wait for in-flight)
 * - Backend cleanup with timeout
 * - Pretty-printed shutdown progress with ANSI colors
 * - Force kill timer if graceful shutdown exceeds grace period
 */

import type { Server } from 'node:net';
import type { BackendManager } from '../backend/manager.js';
import { logger } from '../logger.js';

// ANSI color helpers for terminal output
const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
} as const;

function colorize(color: keyof typeof ansi, text: string): string {
  return `${ansi[color]}${text}${ansi.reset}`;
}

function timestamp(): string {
  return colorize('dim', new Date().toISOString());
}

function stepLog(icon: string, message: string): void {
  console.log(`  ${icon}  ${timestamp()} ${message}`);
}

export interface ShutdownOptions {
  server: Server;
  backendManager: BackendManager;
  gracePeriodMs?: number;    // default 15000
  onShutdownStart?: () => void;
  onShutdownComplete?: () => void;
}

export function setupGracefulShutdown(options: ShutdownOptions): void {
  const {
    server,
    backendManager,
    gracePeriodMs = 15_000,
    onShutdownStart,
    onShutdownComplete,
  } = options;

  let isShuttingDown = false;

  // Track active connections for draining
  const activeConnections = new Set<import('node:net').Socket>();

  server.on('connection', (socket) => {
    activeConnections.add(socket);
    socket.once('close', () => {
      activeConnections.delete(socket);
    });
  });

  async function shutdown(signal: string): Promise<void> {
    // Prevent re-entrant shutdown from multiple signals
    if (isShuttingDown) {
      logger.debug(`Duplicate ${signal} received, shutdown already in progress`);
      return;
    }
    isShuttingDown = true;

    const shutdownStart = Date.now();

    console.log('');
    console.log(colorize('bold', colorize('yellow', '  ==========================================')));
    console.log(colorize('bold', colorize('yellow', '     MCP Gateway - Graceful Shutdown')));
    console.log(colorize('bold', colorize('yellow', '  ==========================================')));
    console.log('');

    stepLog(colorize('cyan', 'SIG'), `Received ${colorize('bold', signal)}`);

    if (onShutdownStart) {
      try {
        onShutdownStart();
      } catch {
        // Callback errors should not block shutdown
      }
    }

    // Set up force kill timer
    const forceKillTimer = setTimeout(() => {
      console.log('');
      stepLog(
        colorize('red', 'FORCE'),
        colorize('red', `Graceful shutdown exceeded ${gracePeriodMs}ms - forcing exit`)
      );
      process.exit(1);
    }, gracePeriodMs);

    // Unref so the timer alone does not keep the event loop alive
    // (if everything else closes cleanly, Node can exit before the timer fires)
    forceKillTimer.unref();

    try {
      // Step 1: Stop accepting new connections
      stepLog(colorize('yellow', 'STOP'), 'Stopping new connections...');
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            // "Server is not running" is fine -- means it was already closed
            if ((err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
              resolve();
            } else {
              reject(err);
            }
          } else {
            resolve();
          }
        });
      });
      stepLog(colorize('green', 'DONE'), 'No longer accepting connections');

      // Step 2: Drain in-flight connections
      const connectionCount = activeConnections.size;
      if (connectionCount > 0) {
        stepLog(
          colorize('yellow', 'DRAIN'),
          `Waiting for ${colorize('bold', String(connectionCount))} in-flight connection(s)...`
        );

        // Give connections a reasonable window to finish, then destroy them
        const drainTimeout = Math.min(gracePeriodMs / 2, 5_000);
        await Promise.race([
          waitForConnectionsDrained(activeConnections),
          sleep(drainTimeout),
        ]);

        // Force-close any remaining connections
        const remaining = activeConnections.size;
        if (remaining > 0) {
          stepLog(
            colorize('yellow', 'CLOSE'),
            `Force-closing ${colorize('bold', String(remaining))} remaining connection(s)`
          );
          for (const socket of activeConnections) {
            socket.destroy();
          }
          activeConnections.clear();
        }

        stepLog(colorize('green', 'DONE'), 'All connections drained');
      } else {
        stepLog(colorize('green', 'SKIP'), 'No in-flight connections');
      }

      // Step 3: Disconnect backends in parallel
      const backendStatus = backendManager.getStatus();
      const backendCount = Object.keys(backendStatus).length;
      const connectedCount = Object.values(backendStatus).filter(
        (s) => s.status === 'connected'
      ).length;

      if (backendCount > 0) {
        stepLog(
          colorize('magenta', 'BACK'),
          `Disconnecting ${colorize('bold', String(connectedCount))}/${backendCount} backend(s)...`
        );

        // Race backend disconnection against a portion of the remaining grace period
        const elapsed = Date.now() - shutdownStart;
        const backendTimeout = Math.max(gracePeriodMs - elapsed - 1_000, 2_000);
        await Promise.race([
          backendManager.disconnectAll(),
          sleep(backendTimeout),
        ]);

        stepLog(colorize('green', 'DONE'), 'Backends disconnected');
      } else {
        stepLog(colorize('green', 'SKIP'), 'No backends to disconnect');
      }

      // Step 4: Report completion
      const totalDuration = Date.now() - shutdownStart;
      console.log('');
      stepLog(
        colorize('green', 'EXIT'),
        colorize(
          'green',
          `Shutdown complete in ${colorize('bold', `${totalDuration}ms`)}`
        )
      );
      console.log('');

      clearTimeout(forceKillTimer);

      if (onShutdownComplete) {
        try {
          onShutdownComplete();
        } catch {
          // Callback errors should not block exit
        }
      }

      logger.info('Graceful shutdown complete', {
        signal,
        durationMs: totalDuration,
      });

      process.exit(0);
    } catch (error) {
      const totalDuration = Date.now() - shutdownStart;
      const message = error instanceof Error ? error.message : String(error);
      stepLog(
        colorize('red', 'ERR'),
        colorize('red', `Shutdown error after ${totalDuration}ms: ${message}`)
      );
      logger.error('Shutdown error', { error: message, durationMs: totalDuration });
      clearTimeout(forceKillTimer);
      process.exit(1);
    }
  }

  // Register signal handlers
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGUSR2', () => shutdown('SIGUSR2'));   // nodemon sends SIGUSR2
}

// ---- Helpers ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForConnectionsDrained(
  connections: Set<import('node:net').Socket>
): Promise<void> {
  return new Promise((resolve) => {
    if (connections.size === 0) {
      resolve();
      return;
    }

    // Poll every 100ms until all connections are closed
    const interval = setInterval(() => {
      if (connections.size === 0) {
        clearInterval(interval);
        resolve();
      }
    }, 100);
  });
}
