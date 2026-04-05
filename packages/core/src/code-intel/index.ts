/**
 * Code Intelligence module barrel export.
 *
 * Provides structural code queries via MCP (Model Context Protocol)
 * to ground AI reviews in real code structure.
 */

// ─── Types ─────────────────────────────────────────────────────

export type {
  CodeIntelMetadata,
  CodeIntelProvider,
  CodeIntelResult,
  SymbolReference,
} from './types.js';

// ─── Client ────────────────────────────────────────────────────

export { McpCodeIntelClient } from './client.js';

// ─── Context Builder ───────────────────────────────────────────

export { buildCodeIntelContext } from './context.js';
