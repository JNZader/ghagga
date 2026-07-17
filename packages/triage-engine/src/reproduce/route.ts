/**
 * Route extractor — pulls the in-app route a user was on when they reported
 * an issue out of the issue body, so REPRODUCE can navigate there without a
 * human specifying it by hand. Matches the biogas feedback widget's embedded
 * context line, in both variants the GitLab/GitHub description formatter
 * emits: the plain `Módulo: X · Ruta: /app/alertas` line and the markdown
 * `- Ruta: \`/app/alertas\`` bullet.
 *
 * Pure, unit-tested, and swappable: callers targeting a different widget
 * shape can pass a custom `pattern` with a single capture group for the
 * route.
 */

const DEFAULT_ROUTE_PATTERN = /Ruta:\s*`?(\/\S*?)`?(?:\s|$)/i;

/**
 * Extracts the app route from an issue body, or `null` when no `Ruta:` line
 * is present.
 */
export function extractRouteFromIssueBody(
  body: string,
  pattern: RegExp = DEFAULT_ROUTE_PATTERN,
): string | null {
  const match = body.match(pattern);
  return match?.[1] ?? null;
}

const MODULE_LABEL_PATTERN = /^m[oó]dulo::(.+)$/i;

/**
 * Deduces the in-app route from an issue's MODULE LABEL (`módulo::X`) when the
 * body has no `Ruta:` line — the fallback for issues created from meeting
 * notes rather than the in-app feedback widget.
 *
 * Finds the first `módulo::<slug>` label (also accepts `modulo::` without the
 * accent for safety), then resolves the route: an explicit `moduleRoutes[slug]`
 * override wins, otherwise the default `/app/<slug>` heuristic applies. Returns
 * `null` when no `módulo::` label is present.
 *
 * Pure and unit-tested.
 */
export function deduceRouteFromLabels(
  labels: string[],
  moduleRoutes?: Record<string, string>,
): string | null {
  for (const label of labels) {
    const match = label.match(MODULE_LABEL_PATTERN);
    const slug = match?.[1]?.trim();
    if (slug) {
      return moduleRoutes?.[slug] ?? `/app/${slug}`;
    }
  }
  return null;
}
