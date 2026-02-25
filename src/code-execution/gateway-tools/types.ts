
export interface GatewayTool {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
    inputExamples?: Record<string, unknown>[];
}

export interface GatewayToolsConfig {
    prefix?: string; // Default: 'gateway'
    enableCodeExecution?: boolean; // Default: true
    enableSkills?: boolean; // Default: true
    liteMode?: boolean; // Default: false
}
