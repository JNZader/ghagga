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
