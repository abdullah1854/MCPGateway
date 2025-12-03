/**
 * Configuration Manager for MCP Gateway
 */

import { readFileSync, writeFileSync, existsSync, watchFile, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  GatewayConfig,
  GatewayConfigSchema,
  ServersConfig,
  ServersConfigSchema,
  ServerConfig,
} from './types.js';
import { logger } from './logger.js';

/**
 * UI State - persisted tool/backend enabled/disabled selections
 */
export interface UIState {
  disabledTools: string[];
  disabledBackends: string[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Substitute environment variables in strings
 * Supports ${VAR_NAME} syntax
 */
export function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      logger.warn(`Environment variable ${varName} not found`);
      return match;
    }
    return envValue;
  });
}

/**
 * Deep substitute environment variables in an object
 */
export function substituteEnvVarsDeep<T>(obj: T): T {
  if (typeof obj === 'string') {
    return substituteEnvVars(obj) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(substituteEnvVarsDeep) as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVarsDeep(value);
    }
    return result as T;
  }
  return obj;
}

/**
 * Load gateway configuration from environment
 */
export function loadGatewayConfig(): GatewayConfig {
  const config = {
    port: parseInt(process.env.PORT ?? '3010', 10),
    host: process.env.HOST ?? '0.0.0.0',
    name: process.env.GATEWAY_NAME ?? 'mcp-gateway',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    auth: {
      mode: process.env.AUTH_MODE ?? 'none',
      apiKeys: process.env.API_KEYS?.split(',').map(k => k.trim()).filter(Boolean),
      oauth: {
        issuer: process.env.OAUTH_ISSUER,
        audience: process.env.OAUTH_AUDIENCE,
        jwksUri: process.env.OAUTH_JWKS_URI,
      },
    },
    cors: {
      origins: process.env.CORS_ORIGINS ?? '*',
    },
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10),
      maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS ?? '100', 10),
    },
  };

  return GatewayConfigSchema.parse(config);
}

/**
 * Load servers configuration from JSON file
 */
export function loadServersConfig(configPath?: string): ServersConfig {
  const path = configPath ?? resolve(__dirname, '../config/servers.json');
  
  if (!existsSync(path)) {
    logger.warn(`Servers config not found at ${path}, using empty config`);
    return { servers: [] };
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(content);
    const config = ServersConfigSchema.parse(parsed);
    
    // Substitute environment variables in transport configs
    const servers = config.servers.map(server => ({
      ...server,
      transport: substituteEnvVarsDeep(server.transport),
    }));

    return { servers };
  } catch (error) {
    logger.error('Failed to load servers config', { error, path });
    throw error;
  }
}

/**
 * Get enabled servers from config
 */
export function getEnabledServers(config: ServersConfig): ServerConfig[] {
  return config.servers.filter(server => server.enabled);
}

/**
 * Watch servers config for changes
 */
export function watchServersConfig(
  configPath: string,
  onChange: (config: ServersConfig) => void
): void {
  watchFile(configPath, { interval: 1000 }, () => {
    logger.info('Servers config changed, reloading...');
    try {
      const config = loadServersConfig(configPath);
      onChange(config);
    } catch (error) {
      logger.error('Failed to reload servers config', { error });
    }
  });
}

/**
 * Configuration singleton
 */
class ConfigManager {
  private static instance: ConfigManager;
  private gatewayConfig: GatewayConfig;
  private serversConfig: ServersConfig;
  private serversConfigPath: string;
  private uiStatePath: string;
  private uiState: UIState;

  private constructor() {
    this.serversConfigPath = resolve(__dirname, '../config/servers.json');
    this.uiStatePath = resolve(__dirname, '../config/.ui-state.json');
    this.gatewayConfig = loadGatewayConfig();
    this.serversConfig = loadServersConfig(this.serversConfigPath);
    this.uiState = this.loadUIState();
  }

  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  getGatewayConfig(): GatewayConfig {
    return this.gatewayConfig;
  }

  getServersConfig(): ServersConfig {
    return this.serversConfig;
  }

  getEnabledServers(): ServerConfig[] {
    return getEnabledServers(this.serversConfig);
  }

  reload(): void {
    this.gatewayConfig = loadGatewayConfig();
    this.serversConfig = loadServersConfig(this.serversConfigPath);
  }

  /**
   * Get the path to the servers config file
   */
  getServersConfigPath(): string {
    return this.serversConfigPath;
  }

  /**
   * Add a new server to the configuration and persist to file
   */
  addServer(server: ServerConfig): void {
    // Check if server ID already exists
    const existingIndex = this.serversConfig.servers.findIndex(s => s.id === server.id);
    if (existingIndex !== -1) {
      throw new Error(`Server with ID '${server.id}' already exists`);
    }

    this.serversConfig.servers.push(server);
    this.saveServersConfig();
    logger.info(`Server added: ${server.id}`);
  }

  /**
   * Update an existing server in the configuration and persist to file
   */
  updateServer(id: string, server: ServerConfig): void {
    const index = this.serversConfig.servers.findIndex(s => s.id === id);
    if (index === -1) {
      throw new Error(`Server with ID '${id}' not found`);
    }

    // If the ID is changing, check that the new ID doesn't already exist
    if (server.id !== id) {
      const newIdExists = this.serversConfig.servers.some(s => s.id === server.id);
      if (newIdExists) {
        throw new Error(`Server with ID '${server.id}' already exists`);
      }
    }

    this.serversConfig.servers[index] = server;
    this.saveServersConfig();
    logger.info(`Server updated: ${id}${server.id !== id ? ` -> ${server.id}` : ''}`);
  }

  /**
   * Delete a server from the configuration and persist to file
   */
  deleteServer(id: string): void {
    const index = this.serversConfig.servers.findIndex(s => s.id === id);
    if (index === -1) {
      throw new Error(`Server with ID '${id}' not found`);
    }

    this.serversConfig.servers.splice(index, 1);
    this.saveServersConfig();
    logger.info(`Server deleted: ${id}`);
  }

  /**
   * Get a server by ID
   */
  getServer(id: string): ServerConfig | undefined {
    return this.serversConfig.servers.find(s => s.id === id);
  }

  /**
   * Save the current servers configuration to file
   */
  private saveServersConfig(): void {
    try {
      const content = JSON.stringify({
        "$schema": "./servers.schema.json",
        servers: this.serversConfig.servers
      }, null, 2);
      writeFileSync(this.serversConfigPath, content, 'utf-8');
      logger.info('Servers config saved successfully');
    } catch (error) {
      logger.error('Failed to save servers config', { error });
      throw error;
    }
  }

  /**
   * Load UI state from file
   */
  private loadUIState(): UIState {
    const defaultState: UIState = { disabledTools: [], disabledBackends: [] };

    if (!existsSync(this.uiStatePath)) {
      return defaultState;
    }

    try {
      const content = readFileSync(this.uiStatePath, 'utf-8');
      const parsed = JSON.parse(content);
      return {
        disabledTools: Array.isArray(parsed.disabledTools) ? parsed.disabledTools : [],
        disabledBackends: Array.isArray(parsed.disabledBackends) ? parsed.disabledBackends : [],
      };
    } catch (error) {
      logger.warn('Failed to load UI state, using defaults', { error });
      return defaultState;
    }
  }

  /**
   * Get the current UI state
   */
  getUIState(): UIState {
    return this.uiState;
  }

  /**
   * Save UI state to file
   */
  saveUIState(state: UIState): void {
    this.uiState = state;
    try {
      // Ensure config directory exists
      const configDir = dirname(this.uiStatePath);
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }

      const content = JSON.stringify(state, null, 2);
      writeFileSync(this.uiStatePath, content, 'utf-8');
      logger.debug('UI state saved successfully');
    } catch (error) {
      logger.error('Failed to save UI state', { error });
    }
  }

  /**
   * Update disabled tools list and persist
   */
  updateDisabledTools(disabledTools: string[]): void {
    this.uiState.disabledTools = disabledTools;
    this.saveUIState(this.uiState);
  }

  /**
   * Update disabled backends list and persist
   */
  updateDisabledBackends(disabledBackends: string[]): void {
    this.uiState.disabledBackends = disabledBackends;
    this.saveUIState(this.uiState);
  }
}

export default ConfigManager;

