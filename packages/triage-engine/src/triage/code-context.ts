/**
 * Code-context builder — turns LOCATE's `contextFiles` (a bounded pool of
 * relative paths) into the `memoryContext` string consumed by ghagga-core's
 * `runIssueTriage`. Direct generalization of the biogas PoC's snippet
 * builder (see biogas-triage.mts `snippet()`/codeContext assembly), made
 * language/project-agnostic: no hardcoded ```go fence, no hardcoded module
 * label.
 */

/** Number of lines shown per file when no `linesPerFile` override is given. */
const DEFAULT_LINES_PER_FILE = 40;

/**
 * Extract a bounded snippet window from `content`, centered on the first
 * line matching any of `keywords` (case-insensitive substring match). Falls
 * back to the top of the file when no keyword hits. Lines are numbered from
 * their real position in the file (not always "1:"), so the model can cite
 * accurate line numbers.
 */
function snippet(content: string, keywords: string[], lines: number): string {
  const rows = content.split('\n');
  const lowered = rows.map((r) => r.toLowerCase());
  let hit = lowered.findIndex((r) => keywords.some((k) => k && r.includes(k)));
  if (hit < 0) hit = 0;
  const start = Math.max(0, hit - 6);
  return rows
    .slice(start, start + lines)
    .map((row, i) => `${start + i + 1}: ${row}`)
    .join('\n');
}

/**
 * Build a markdown code-context block for the given `contextFiles`, reading
 * each file's content from the `files` map (produced by LOCATE's scan
 * stage). A file listed but missing from the map still gets a heading (with
 * an empty snippet) rather than being silently dropped — surfaces a LOCATE
 * bug instead of hiding it.
 *
 * @returns '' when `contextFiles` is empty (no code-context section at all).
 */
export function buildCodeContext(
  contextFiles: string[],
  files: Map<string, string>,
  keywords: string[],
  linesPerFile: number = DEFAULT_LINES_PER_FILE,
): string {
  if (contextFiles.length === 0) return '';

  const sections = contextFiles.map((path) => {
    const content = files.get(path) ?? '';
    return `\n### ${path}\n\`\`\`\n${snippet(content, keywords, linesPerFile)}\n\`\`\``;
  });

  return ['## RELEVANT SOURCE CODE (located via keyword search + LLM rerank)', ...sections].join(
    '\n',
  );
}
