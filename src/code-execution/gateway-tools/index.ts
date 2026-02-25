
import { BackendManager } from '../../backend/index.js';
import { ToolDiscovery } from '../tool-discovery.js';
import { CodeExecutor } from '../executor.js';
import { SkillsManager } from '../skills.js';
import { WorkspaceManager } from '../workspace.js';
import { SchemaDeduplicator } from '../schema-dedup.js';
import ConfigManager from '../../config.js';
import { GatewayTool, GatewayToolsConfig } from './types.js';
import { getDiscoveryTools, handleDiscoveryToolCall } from './discovery.js';
import { getExecutionTools, handleExecutionToolCall } from './execution.js';
import { getSkillsTools, handleSkillsToolCall } from './skills.js';

// Re-export filtering utilities
export { applyResultFilter, estimateTokens, filterByTokenBudget } from './filtering.js';
export type { GatewayTool, GatewayToolsConfig } from './types.js';

/**
 * Creates gateway-level MCP tools for progressive disclosure and code execution
 */
export function createGatewayTools(
    backendManager: BackendManager,
    config: GatewayToolsConfig = {}
): { tools: GatewayTool[]; callTool: (name: string, args: unknown, ctx?: { sessionId?: string }) => Promise<unknown> } {
    // Check lite mode from config parameter, ConfigManager, or env var
    const configManager = ConfigManager.getInstance();
    const liteMode = config.liteMode ?? configManager.isLiteModeEnabled();

    const toolDiscovery = new ToolDiscovery(backendManager);
    const codeExecutor = new CodeExecutor(backendManager);
    const workspaceManager = new WorkspaceManager();
    const skillsManager = new SkillsManager(workspaceManager, codeExecutor);
    const schemaDeduplicator = new SchemaDeduplicator();

    // Combine tools from all modules
    const tools: GatewayTool[] = [
        ...getDiscoveryTools(config, liteMode),
        ...getExecutionTools(config, liteMode),
        ...getSkillsTools(config, liteMode),
    ];

    const requireAllowlist = process.env.CODE_EXECUTION_REQUIRE_ALLOWLIST === '1';
    const allowedTools = (process.env.CODE_EXECUTION_ALLOWED_TOOLS ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    const allowedPrefixes = (process.env.CODE_EXECUTION_ALLOWED_TOOL_PREFIXES ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    const enforceToolAllowlist = requireAllowlist || allowedTools.length > 0 || allowedPrefixes.length > 0;
    const allowedToolNames = new Set(allowedTools);

    const isProgrammaticToolAllowed = (toolName: string): boolean => {
        if (!enforceToolAllowlist) return true;
        if (allowedToolNames.has(toolName)) return true;
        return allowedPrefixes.some(p => toolName.startsWith(p));
    };

    /**
     * Main tool call handler that delegates to sub-modules
     */
    async function callTool(name: string, args: unknown, ctx?: { sessionId?: string }): Promise<unknown> {
        const params = (args || {}) as Record<string, unknown>;

        // Try Discovery Tools
        const discoveryResult = await handleDiscoveryToolCall(name, params, toolDiscovery, config);
        if (discoveryResult !== undefined) return discoveryResult;

        // Try Execution Tools
        const executionResult = await handleExecutionToolCall(
            name,
            params,
            backendManager,
            codeExecutor,
            schemaDeduplicator,
            isProgrammaticToolAllowed,
            config,
            ctx
        );
        if (executionResult !== undefined) return executionResult;

        // Try Skills Tools
        const skillsResult = await handleSkillsToolCall(
            name,
            params,
            skillsManager,
            config,
            ctx
        );
        if (skillsResult !== undefined) return skillsResult;

        return { error: `Unknown gateway tool: ${name}` };
    }

    return { tools, callTool };
}
