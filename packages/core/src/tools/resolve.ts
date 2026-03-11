/**
 * Tool Activation Resolver — determines which tools should run.
 *
 * Resolution order (per spec):
 * 1. Start with all always-on tools
 * 2. Run detect(files) for each auto-detect tool; add matches
 * 3. Add tools from enabledTools (force-enable override)
 * 4. Remove tools from disabledTools (force-disable override)
 * 5. Remove tools disabled by deprecated boolean flags (fallback only)
 *
 * disabledTools takes precedence over everything.
 * New fields take precedence over deprecated boolean flags.
 */

import type { ToolRegistry } from './registry.js';
import type { ToolDefinition } from './types.js';

export interface ToolActivationInput {
  registry: ToolRegistry;
  files: string[];
  enabledTools?: string[];
  disabledTools?: string[];
  /** Deprecated boolean flags (backward compat) */
  enableSemgrep?: boolean;
  enableTrivy?: boolean;
  enableCpd?: boolean;
}

export interface ActivatedTool {
  definition: ToolDefinition;
  reason: 'always-on' | 'auto-detect' | 'force-enabled';
}

/**
 * Resolve which tools should run for this review.
 *
 * Returns activated tools in execution order: always-on first, then auto-detect,
 * then force-enabled.
 */
export function resolveActivatedTools(input: ToolActivationInput): ActivatedTool[] {
  const { registry, files, enabledTools, disabledTools } = input;

  const activated = new Map<string, ActivatedTool>();

  // Step 1: Start with all always-on tools
  for (const tool of registry.getByTier('always-on')) {
    activated.set(tool.name, { definition: tool, reason: 'always-on' });
  }

  // Step 2: Run detect(files) for each auto-detect tool
  for (const tool of registry.getByTier('auto-detect')) {
    if (tool.detect?.(files)) {
      activated.set(tool.name, { definition: tool, reason: 'auto-detect' });
    }
  }

  // Step 3: Add tools from enabledTools (force-enable)
  if (enabledTools && enabledTools.length > 0) {
    for (const name of enabledTools) {
      if (!activated.has(name)) {
        const tool = registry.getByName(name);
        if (tool) {
          activated.set(name, { definition: tool, reason: 'force-enabled' });
        }
      }
    }
  }

  // Step 4: Remove tools from disabledTools (force-disable) — takes precedence over everything
  if (disabledTools && disabledTools.length > 0) {
    for (const name of disabledTools) {
      activated.delete(name);
    }
  }

  // Step 5: Apply deprecated boolean flags as fallback
  // Only apply when the new disabledTools field does NOT already handle the tool
  const hasNewDisabledField = disabledTools !== undefined && disabledTools.length > 0;
  if (!hasNewDisabledField) {
    const deprecatedFlags: Array<{ flag: boolean | undefined; tool: string }> = [
      { flag: input.enableSemgrep, tool: 'semgrep' },
      { flag: input.enableTrivy, tool: 'trivy' },
      { flag: input.enableCpd, tool: 'cpd' },
    ];

    for (const { flag, tool } of deprecatedFlags) {
      if (flag === false) {
        activated.delete(tool);
      }
    }
  }

  return Array.from(activated.values());
}
