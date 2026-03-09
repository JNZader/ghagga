/**
 * Tool grid component for configuring static analysis tools.
 *
 * Displays all registered tools grouped by category with toggle switches.
 * Each tool shows: display name, category badge, tier badge, and a toggle.
 *
 * When `readOnly` is true, shows "Inherited" badges and non-interactive toggles
 * (for repos using global settings).
 */

import type { RegisteredTool } from '@/lib/types';

// ─── Category Display Config ─────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  security: 'Security',
  quality: 'Quality',
  secrets: 'Secrets',
  complexity: 'Complexity',
  duplication: 'Duplication',
  sca: 'SCA / Dependencies',
  docs: 'Documentation',
  linting: 'Linting',
};

const CATEGORY_ORDER = [
  'security',
  'secrets',
  'sca',
  'quality',
  'complexity',
  'duplication',
  'linting',
  'docs',
];

// ─── Types ──────────────────────────────────────────────────────

interface ToolGridProps {
  /** All registered tools from the API */
  tools: RegisteredTool[];
  /** Currently disabled tool names */
  disabledTools: string[];
  /** Callback when a tool is toggled. Receives the updated disabledTools array. */
  onToggle: (disabledTools: string[]) => void;
  /** When true, all toggles are non-interactive and show "Inherited" badges */
  readOnly?: boolean;
}

// ─── Component ──────────────────────────────────────────────────

export function ToolGrid({ tools, disabledTools, onToggle, readOnly = false }: ToolGridProps) {
  // Group tools by category, respecting CATEGORY_ORDER
  const grouped = new Map<string, RegisteredTool[]>();
  for (const tool of tools) {
    const group = grouped.get(tool.category) ?? [];
    group.push(tool);
    grouped.set(tool.category, group);
  }

  // Sort categories
  const sortedCategories = [...grouped.keys()].sort(
    (a, b) =>
      (CATEGORY_ORDER.indexOf(a) === -1 ? 99 : CATEGORY_ORDER.indexOf(a)) -
      (CATEGORY_ORDER.indexOf(b) === -1 ? 99 : CATEGORY_ORDER.indexOf(b)),
  );

  const handleToggle = (toolName: string, enabled: boolean) => {
    if (readOnly) return;
    if (enabled) {
      onToggle(disabledTools.filter((t) => t !== toolName));
    } else {
      onToggle([...disabledTools, toolName]);
    }
  };

  return (
    <div className="space-y-4" data-testid="tool-grid">
      {sortedCategories.map((category) => {
        const categoryTools = grouped.get(category) ?? [];
        return (
          <div key={category}>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
              {CATEGORY_LABELS[category] ?? category}
            </h4>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {categoryTools.map((tool) => {
                const isEnabled = !disabledTools.includes(tool.name);
                return (
                  <div
                    key={tool.name}
                    className="flex items-center justify-between rounded-lg border border-surface-border bg-surface-bg p-3"
                    data-testid={`tool-row-${tool.name}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary">
                        {tool.displayName}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          tool.tier === 'always-on'
                            ? 'bg-primary-600/20 text-primary-400'
                            : 'bg-yellow-600/20 text-yellow-400'
                        }`}
                      >
                        {tool.tier === 'always-on' ? 'Always-on' : 'Auto-detect'}
                      </span>
                      {readOnly && (
                        <span className="rounded-sm bg-primary-600/20 px-2 py-0.5 text-xs text-primary-400">
                          Inherited
                        </span>
                      )}
                    </div>
                    <label className="relative inline-flex cursor-pointer items-center">
                      <input
                        type="checkbox"
                        checked={isEnabled}
                        onChange={(e) => handleToggle(tool.name, e.target.checked)}
                        disabled={readOnly}
                        className="peer sr-only"
                        data-testid={`tool-toggle-${tool.name}`}
                        aria-label={`Toggle ${tool.displayName}`}
                      />
                      <div
                        className={`h-5 w-9 rounded-full transition-colors ${
                          readOnly
                            ? isEnabled
                              ? 'bg-primary-600/50'
                              : 'bg-surface-border/50'
                            : 'bg-surface-border peer-checked:bg-primary-600'
                        }`}
                      />
                      <div
                        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                          isEnabled ? 'translate-x-4' : 'translate-x-0'
                        }`}
                      />
                    </label>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
