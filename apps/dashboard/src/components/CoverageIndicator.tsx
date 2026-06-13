const TOOLTIP = 'Incomplete coverage — some pipeline steps degraded';

interface CoverageIndicatorProps {
  coverageComplete?: boolean;
}

/**
 * Discreet warning shown next to a review's StatusBadge when the pipeline
 * reported incomplete coverage (`coverageComplete === false`): the verdict
 * stands, but at least one pipeline step degraded while producing it.
 *
 * Renders NOTHING when coverage is complete (`true`) or not applicable
 * (`undefined` — legacy rows and SKIPPED reviews where the pipeline never ran).
 */
export function CoverageIndicator({ coverageComplete }: CoverageIndicatorProps) {
  if (coverageComplete !== false) return null;

  return (
    <span title={TOOLTIP} aria-label={TOOLTIP} role="img" className="text-sm text-amber-400">
      ⚠
    </span>
  );
}
