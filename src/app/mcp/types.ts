/**
 * The shapes AGstudio's MCP server shares between the dev server (tools/mcp, Node) and the page
 * (src/app/mcp). Pure types: no imports, so both sides can load this file.
 */

/**
 * The client name of Studio's own AI backends when they read the project during a turn (tools/ai/lookup.ts). It is not an
 * app the musician connected, so it gets no toast and no row in the settings' list of connected apps.
 */
export const STUDIO_LOOKUP_CLIENT = 'agstudio-studio';

/** Who is calling: the name an AI app gives itself when it connects ("claude-code"). */
export interface ClientInfo {
  name: string;
  version?: string;
}

export type ContentItem =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string };

/** What a tool call returns (MCP `CallToolResult`). A failure the AI can react to sets `isError`. */
export interface ToolResult {
  content: ContentItem[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface ResourceDef {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  /** The tool whose text answer is this resource. */
  tool: string;
}

/** A call as the dev server hands it to the page. */
export interface BridgeCall {
  id: string;
  /** The tab that must answer (others ignore the call). */
  tab: string;
  name: string;
  args: Record<string, unknown>;
  client?: ClientInfo;
  /** Lets this call upload files it renders (exports) to the dev server; valid while the call runs. */
  ticket?: string;
}

/** What the page tells the dev server about itself. */
export interface BridgeHello {
  tab: string;
  title?: string;
  /** The tab is the one the musician is looking at right now. */
  focused: boolean;
  /** Connections from AI apps are switched on in this tab's settings. */
  enabled: boolean;
  /** The open project's name. */
  project?: string;
}

export type BridgeResult =
  | { id: string; ok: true; result: ToolResult }
  | { id: string; ok: false; error: string };

export const BRIDGE_EVENTS = {
  hello: 'agstudio:mcp:hello',
  bye: 'agstudio:mcp:bye',
  call: 'agstudio:mcp:call',
  ack: 'agstudio:mcp:ack',
  result: 'agstudio:mcp:result',
  status: 'agstudio:mcp:status',
} as const;

/** What the dev server says about the connections, shown in Settings. */
export interface McpStatus {
  /** AI apps that called in the last minutes, newest first. */
  clients: { name: string; version?: string; lastSeen: number; calls: number }[];
  /** Tool calls in the last minute, over all clients. */
  callsLastMinute: number;
  /** Tabs open on this app (the most recently used one answers). */
  tabs: number;
}

/** The setup the dev server tells the page (same-origin only). */
export interface McpInfo {
  token: string;
  /** Absolute path of the AGstudio folder (for the stdio helper's command). */
  root: string;
  /** Where exported audio goes. */
  exportsDir: string;
  /** The operating system of the computer the dev server runs on (`win32`, `darwin`, `linux`…): paths and setup lines differ. */
  platform: string;
  status: McpStatus;
}
