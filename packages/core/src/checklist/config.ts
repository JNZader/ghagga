/**
 * Checklist config resolution — merges user overrides with defaults.
 *
 * Users can:
 * - Enable/disable dimensions
 * - Enable/disable individual checks
 * - Override check weights
 *
 * Missing fields fall back to DEFAULT_CHECKLIST values.
 */

import { DEFAULT_CHECKLIST } from './defaults.js';
import type { ChecklistCheck, ChecklistConfig, ChecklistDimension } from './types.js';

/**
 * Resolve the effective checklist configuration.
 *
 * Merges user-provided overrides with the default checklist.
 * Returns a fully populated ChecklistConfig ready for use.
 *
 * @param userConfig - Partial config from ReviewSettings.checklist (may be undefined)
 * @returns Fully resolved ChecklistConfig, or null if checklist is disabled
 */
export function resolveChecklistConfig(
  userConfig: ChecklistConfig | undefined,
): ChecklistConfig | null {
  // No config at all → checklist disabled
  if (!userConfig) return null;

  // Master switch off → disabled
  if (!userConfig.enabled) return null;

  // No user dimensions → use all defaults
  if (!userConfig.dimensions || userConfig.dimensions.length === 0) {
    return { ...DEFAULT_CHECKLIST };
  }

  // Merge user dimensions with defaults
  const mergedDimensions = DEFAULT_CHECKLIST.dimensions.map((defaultDim) => {
    const userDim = userConfig.dimensions.find((d) => d.id === defaultDim.id);
    if (!userDim) return defaultDim;

    return mergeDimension(defaultDim, userDim);
  });

  // Include any user-defined custom dimensions not in defaults
  const defaultIds = new Set(DEFAULT_CHECKLIST.dimensions.map((d) => d.id));
  const customDimensions = userConfig.dimensions.filter((d) => !defaultIds.has(d.id));

  return {
    enabled: true,
    dimensions: [...mergedDimensions, ...customDimensions],
  };
}

/**
 * Merge a user dimension override with a default dimension.
 * User fields take precedence where provided.
 */
function mergeDimension(
  defaultDim: ChecklistDimension,
  userDim: Partial<ChecklistDimension>,
): ChecklistDimension {
  const enabled = userDim.enabled ?? defaultDim.enabled;

  // No user checks → use defaults with dimension-level enabled toggle and name override
  if (!userDim.checks || userDim.checks.length === 0) {
    return { ...defaultDim, name: userDim.name ?? defaultDim.name, enabled };
  }

  // Merge checks
  const mergedChecks = defaultDim.checks.map((defaultCheck) => {
    const userCheck = userDim.checks?.find((c) => c.id === defaultCheck.id);
    if (!userCheck) return defaultCheck;

    return mergeCheck(defaultCheck, userCheck);
  });

  // Include custom checks not in defaults
  const defaultCheckIds = new Set(defaultDim.checks.map((c) => c.id));
  const customChecks = (userDim.checks ?? []).filter((c) => !defaultCheckIds.has(c.id));

  return {
    id: defaultDim.id,
    name: userDim.name ?? defaultDim.name,
    enabled,
    checks: [...mergedChecks, ...customChecks],
  };
}

/**
 * Merge a user check override with a default check.
 */
function mergeCheck(
  defaultCheck: ChecklistCheck,
  userCheck: Partial<ChecklistCheck>,
): ChecklistCheck {
  return {
    id: defaultCheck.id,
    description: userCheck.description ?? defaultCheck.description,
    weight: userCheck.weight ?? defaultCheck.weight,
    enabled: userCheck.enabled ?? defaultCheck.enabled,
  };
}
