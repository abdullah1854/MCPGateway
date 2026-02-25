/**
 * Topology Service - Generates live topology maps of the MCP Gateway
 *
 * Provides both JSON topology data and Mermaid diagram generation
 * for visualizing the gateway's backend connections, their statuses,
 * circuit breaker states, and tool counts.
 */

import { BackendManager } from '../backend/manager.js';

// --- Topology Data Types ---

export interface TopologyNode {
  id: string;
  type: 'gateway' | 'backend';
  status: string;
  metadata: Record<string, unknown>;
}

export interface TopologyEdge {
  from: string;
  to: string;
  transport: string;
  toolCount: number;
  circuitBreaker: string;
}

export interface Topology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  mermaid: string;
  generatedAt: string;
}

// --- Topology Generation ---

/**
 * Generate a live topology map from the current BackendManager state.
 *
 * The topology includes:
 * 1. The gateway node (center)
 * 2. All backend connections with their status
 * 3. Tool counts per backend
 * 4. Circuit breaker states
 * 5. Transport type for each backend
 */
export function generateTopology(backendManager: BackendManager): Topology {
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];

  const backends = backendManager.getBackends();
  const status = backendManager.getStatus();
  const disabledBackends = backendManager.getDisabledBackends();

  // Compute aggregate stats for the gateway node
  let totalTools = 0;
  const totalBackends = backends.size;
  let connectedBackends = 0;

  for (const info of Object.values(status)) {
    totalTools += info.toolCount;
    if (info.status === 'connected') {
      connectedBackends++;
    }
  }

  // 1. Gateway node (center)
  nodes.push({
    id: 'gateway',
    type: 'gateway',
    status: 'running',
    metadata: {
      name: 'MCP Gateway',
      port: parseInt(process.env.PORT || '3010', 10),
      totalTools,
      totalBackends,
      connectedBackends,
    },
  });

  // 2. Backend nodes and edges
  for (const [id, backend] of backends) {
    const info = status[id];
    const isDisabled = disabledBackends.has(id);
    const transportType = backend.config.transport.type;
    const circuitBreakerState = info?.circuitBreaker?.state ?? 'CLOSED';

    nodes.push({
      id,
      type: 'backend',
      status: isDisabled ? 'disabled' : (info?.status ?? 'unknown'),
      metadata: {
        name: backend.config.name,
        description: backend.config.description ?? null,
        toolPrefix: backend.config.toolPrefix ?? null,
        transport: transportType,
        toolCount: info?.toolCount ?? 0,
        resourceCount: info?.resourceCount ?? 0,
        promptCount: info?.promptCount ?? 0,
        enabled: !isDisabled,
        error: info?.error ?? null,
        lastErrorAt: info?.lastErrorAt ?? null,
        circuitBreaker: info?.circuitBreaker ?? null,
      },
    });

    edges.push({
      from: 'gateway',
      to: id,
      transport: transportType,
      toolCount: info?.toolCount ?? 0,
      circuitBreaker: circuitBreakerState,
    });
  }

  const mermaid = generateMermaidDiagram(nodes, edges);

  return {
    nodes,
    edges,
    mermaid,
    generatedAt: new Date().toISOString(),
  };
}

// --- Mermaid Diagram Generation ---

/**
 * Generate a valid Mermaid flowchart string from topology data.
 *
 * - Gateway at center
 * - Each backend as a node with status color (green=connected, red=error, yellow=disconnected)
 * - Edge labels showing tool count and transport type
 * - Circuit breaker status indicators
 */
function generateMermaidDiagram(nodes: TopologyNode[], edges: TopologyEdge[]): string {
  const lines: string[] = [];

  lines.push('flowchart TD');

  // Style definitions for status colors
  lines.push('    classDef gateway fill:#4F46E5,stroke:#3730A3,color:#fff,stroke-width:2px');
  lines.push('    classDef connected fill:#059669,stroke:#047857,color:#fff');
  lines.push('    classDef disconnected fill:#D97706,stroke:#B45309,color:#fff');
  lines.push('    classDef error fill:#DC2626,stroke:#B91C1C,color:#fff');
  lines.push('    classDef disabled fill:#6B7280,stroke:#4B5563,color:#fff');
  lines.push('    classDef cbOpen fill:#DC2626,stroke:#B91C1C,color:#fff,stroke-dasharray: 5 5');
  lines.push('    classDef cbHalfOpen fill:#D97706,stroke:#B45309,color:#fff,stroke-dasharray: 5 5');

  // Render nodes
  for (const node of nodes) {
    const safeId = sanitizeMermaidId(node.id);

    if (node.type === 'gateway') {
      const toolCount = node.metadata.totalTools ?? 0;
      const connCount = node.metadata.connectedBackends ?? 0;
      const totalCount = node.metadata.totalBackends ?? 0;
      const label = escapeMermaidLabel(`MCP Gateway\\n${connCount}/${totalCount} backends | ${toolCount} tools`);
      lines.push(`    ${safeId}[["${label}"]]`);
      lines.push(`    class ${safeId} gateway`);
    } else {
      const name = escapeMermaidLabel(String(node.metadata.name ?? node.id));
      const toolCount = node.metadata.toolCount ?? 0;
      const transport = node.metadata.transport ?? 'unknown';
      const label = escapeMermaidLabel(`${name}\\n${toolCount} tools | ${transport}`);

      // Use different shapes for different statuses
      lines.push(`    ${safeId}["${label}"]`);

      // Apply status class
      const statusClass = getStatusClass(node.status);
      lines.push(`    class ${safeId} ${statusClass}`);
    }
  }

  // Render edges
  for (const edge of edges) {
    const fromId = sanitizeMermaidId(edge.from);
    const toId = sanitizeMermaidId(edge.to);
    const cbIndicator = edge.circuitBreaker !== 'CLOSED' ? ` | CB:${edge.circuitBreaker}` : '';
    const edgeLabel = escapeMermaidLabel(`${edge.transport} | ${edge.toolCount} tools${cbIndicator}`);

    // Use different arrow styles based on circuit breaker state
    if (edge.circuitBreaker === 'OPEN') {
      lines.push(`    ${fromId} -. "${edgeLabel}" .-> ${toId}`);
    } else if (edge.circuitBreaker === 'HALF_OPEN') {
      lines.push(`    ${fromId} -. "${edgeLabel}" .-> ${toId}`);
    } else {
      lines.push(`    ${fromId} --> |"${edgeLabel}"| ${toId}`);
    }
  }

  return lines.join('\n');
}

/**
 * Sanitize a string to be a valid Mermaid node ID.
 * Mermaid IDs must be alphanumeric (with underscores).
 */
function sanitizeMermaidId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Escape special characters in Mermaid label text.
 */
function escapeMermaidLabel(label: string): string {
  return label.replace(/"/g, "'");
}

/**
 * Map a backend status string to a Mermaid CSS class name.
 */
function getStatusClass(status: string): string {
  switch (status) {
    case 'connected':
      return 'connected';
    case 'disconnected':
    case 'connecting':
      return 'disconnected';
    case 'error':
      return 'error';
    case 'disabled':
      return 'disabled';
    default:
      return 'disconnected';
  }
}
