/**
 * Workspace & State Persistence
 *
 * Provides a workspace directory for agents to save intermediate results
 * and persist state across sessions.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface WorkspaceFile {
  name: string;
  path: string;
  size: number;
  createdAt: Date;
  modifiedAt: Date;
  isDirectory: boolean;
}

export interface SessionState {
  sessionId: string;
  createdAt: Date;
  lastAccessedAt: Date;
  data: Record<string, unknown>;
}

/**
 * Workspace Manager - Handles file storage for agent state
 */
export class WorkspaceManager {
  private workspacePath: string;
  private sessionsPath: string;
  private skillsPath: string;

  constructor(basePath?: string) {
    this.workspacePath = basePath ?? join(__dirname, '../../workspace');
    this.sessionsPath = join(this.workspacePath, 'sessions');
    this.skillsPath = join(this.workspacePath, 'skills');

    this.ensureDirectories();
  }

  /**
   * Ensure workspace directories exist
   */
  private ensureDirectories(): void {
    const dirs = [this.workspacePath, this.sessionsPath, this.skillsPath];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        logger.info(`Created workspace directory: ${dir}`);
      }
    }
  }

  /**
   * Save data to workspace file
   */
  saveFile(filename: string, content: string | Buffer, subdir?: string): string {
    const dir = subdir ? join(this.workspacePath, subdir) : this.workspacePath;

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const filePath = join(dir, filename);
    writeFileSync(filePath, content, 'utf-8');
    logger.info(`Saved workspace file: ${filePath}`);

    return filePath;
  }

  /**
   * Read file from workspace
   */
  readFile(filename: string, subdir?: string): string | null {
    const dir = subdir ? join(this.workspacePath, subdir) : this.workspacePath;
    const filePath = join(dir, filename);

    if (!existsSync(filePath)) {
      return null;
    }

    return readFileSync(filePath, 'utf-8');
  }

  /**
   * Delete file from workspace
   */
  deleteFile(filename: string, subdir?: string): boolean {
    const dir = subdir ? join(this.workspacePath, subdir) : this.workspacePath;
    const filePath = join(dir, filename);

    if (!existsSync(filePath)) {
      return false;
    }

    unlinkSync(filePath);
    logger.info(`Deleted workspace file: ${filePath}`);
    return true;
  }

  /**
   * List files in workspace directory
   */
  listFiles(subdir?: string): WorkspaceFile[] {
    const dir = subdir ? join(this.workspacePath, subdir) : this.workspacePath;

    if (!existsSync(dir)) {
      return [];
    }

    const entries = readdirSync(dir);
    return entries.map(name => {
      const filePath = join(dir, name);
      const stats = statSync(filePath);

      return {
        name,
        path: filePath,
        size: stats.size,
        createdAt: stats.birthtime,
        modifiedAt: stats.mtime,
        isDirectory: stats.isDirectory(),
      };
    });
  }

  /**
   * Save session state
   */
  saveSessionState(sessionId: string, data: Record<string, unknown>): void {
    const state: SessionState = {
      sessionId,
      createdAt: new Date(),
      lastAccessedAt: new Date(),
      data,
    };

    const filename = `${sessionId}.json`;
    this.saveFile(filename, JSON.stringify(state, null, 2), 'sessions');
  }

  /**
   * Load session state
   */
  loadSessionState(sessionId: string): SessionState | null {
    const filename = `${sessionId}.json`;
    const content = this.readFile(filename, 'sessions');

    if (!content) {
      return null;
    }

    try {
      const state = JSON.parse(content) as SessionState;
      state.lastAccessedAt = new Date();

      // Update last accessed time
      this.saveFile(filename, JSON.stringify(state, null, 2), 'sessions');

      return state;
    } catch {
      return null;
    }
  }

  /**
   * Update session data (merge with existing)
   */
  updateSessionState(sessionId: string, data: Record<string, unknown>): SessionState {
    const existing = this.loadSessionState(sessionId);

    const state: SessionState = {
      sessionId,
      createdAt: existing?.createdAt ?? new Date(),
      lastAccessedAt: new Date(),
      data: {
        ...(existing?.data ?? {}),
        ...data,
      },
    };

    const filename = `${sessionId}.json`;
    this.saveFile(filename, JSON.stringify(state, null, 2), 'sessions');

    return state;
  }

  /**
   * Delete session state
   */
  deleteSessionState(sessionId: string): boolean {
    return this.deleteFile(`${sessionId}.json`, 'sessions');
  }

  /**
   * List all sessions
   */
  listSessions(): SessionState[] {
    const files = this.listFiles('sessions');

    return files
      .filter(f => f.name.endsWith('.json'))
      .map(f => {
        const content = this.readFile(f.name, 'sessions');
        if (!content) return null;
        try {
          return JSON.parse(content) as SessionState;
        } catch {
          return null;
        }
      })
      .filter((s): s is SessionState => s !== null);
  }

  /**
   * Clean up old sessions (older than maxAge hours)
   */
  cleanupOldSessions(maxAgeHours: number = 24): number {
    const sessions = this.listSessions();
    const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
    let deleted = 0;

    for (const session of sessions) {
      const lastAccess = new Date(session.lastAccessedAt).getTime();
      if (lastAccess < cutoff) {
        this.deleteSessionState(session.sessionId);
        deleted++;
      }
    }

    if (deleted > 0) {
      logger.info(`Cleaned up ${deleted} old sessions`);
    }

    return deleted;
  }

  /**
   * Get workspace path
   */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  /**
   * Get skills path
   */
  getSkillsPath(): string {
    return this.skillsPath;
  }
}
