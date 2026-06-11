/**
 * Unified diff parser — the single line-based parser for packages/core.
 *
 * Replaces (via thin adapters, see migration plan sdd/unify-diff-parsers) the
 * five historical parsers: utils/diff.ts, recursive/patch-extractor.ts,
 * scope/diff-mapper.ts, scope/entity-diff.ts and the local parseHunks of
 * semantic-diff/index.ts.
 *
 * Invariants:
 *  - NEVER throws, for any input string (spec R1).
 *  - Byte-exact reconstruction (spec R2): every input line lands in exactly
 *    one bucket — `preamble` or one file's `rawLines` — so
 *    `[...preamble, ...files.flatMap((f) => f.rawLines)].join('\n') === raw`.
 *  - Quoted paths (`core.quotepath` octal/C-style escapes) are parsed and
 *    unescaped (CORE-M6 fix) instead of being dropped.
 *
 * Known retained limitation (documented, out of scope): in the unquoted
 * `diff --git a/x b/y` header, a path containing a literal ` b/` is ambiguous;
 * like the historical regex, the LAST ` b/` occurrence wins.
 */

import type { DiffHunk, HunkLine, ParsedDiff, ParsedFileDiff } from './types.js';

// ─── Header regexes ─────────────────────────────────────────────

/**
 * Unquoted form. Greedy `.+` + backtracking makes the b-side capture start at
 * the LAST ` b/` — identical boundary to the historical
 * `/^diff --git a\/.+ b\/(.+)$/` (utils/diff.ts), so unquoted paths with
 * spaces keep parsing exactly as before (C2 parity).
 */
const HEADER_PLAIN_RE = /^diff --git a\/(.+) b\/(.+)$/;

/** Both sides quoted (core.quotepath): `diff --git "a/x" "b/y"`. */
const HEADER_QUOTED_RE = /^diff --git "a\/((?:[^"\\]|\\.)*)" "b\/((?:[^"\\]|\\.)*)"$/;

/** Mixed quoting (one side needs quoting, e.g. rename ascii → non-ascii). */
const HEADER_QUOTED_OLD_RE = /^diff --git "a\/((?:[^"\\]|\\.)*)" b\/(.+)$/;
const HEADER_QUOTED_NEW_RE = /^diff --git a\/(.+) "b\/((?:[^"\\]|\\.)*)"$/;

/**
 * Strict hunk header with the 4 captures (design decision: based on
 * scope/diff-mapper.ts, single-space form as emitted by git; omitted counts
 * default to 1).
 */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * `---`/`+++` lines: quoted, unquoted or /dev/null. Git appends a trailing
 * TAB after unquoted paths containing spaces (GNU patch disambiguation) — it
 * is not part of the path, so it is matched outside the capture.
 */
const OLD_FILE_RE = /^--- (?:"a\/((?:[^"\\]|\\.)*)"|a\/(.*?)|(\/dev\/null))\t?$/;
const NEW_FILE_RE = /^\+\+\+ (?:"b\/((?:[^"\\]|\\.)*)"|b\/(.*?)|(\/dev\/null))\t?$/;

// ─── Quoted-path unescaping (CORE-M6) ───────────────────────────

const ESCAPE_MAP: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '"': 0x22,
  '\\': 0x5c,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Unescape the inner content of a git-quoted path: C-style escapes plus
 * octal byte sequences (`caf\303\251` → `café`). Octal escapes are raw UTF-8
 * bytes, so the whole result is assembled as bytes and decoded once.
 */
function unescapeQuotedPath(inner: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string;
    if (ch === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1] as string;
      if (next >= '0' && next <= '7') {
        let oct = '';
        let j = i + 1;
        while (j < inner.length && oct.length < 3) {
          const d = inner[j] as string;
          if (d < '0' || d > '7') break;
          oct += d;
          j++;
        }
        bytes.push(Number.parseInt(oct, 8));
        i = j - 1;
        continue;
      }
      const mapped = ESCAPE_MAP[next];
      if (mapped !== undefined) {
        bytes.push(mapped);
        i++;
        continue;
      }
      // Unknown escape — keep the backslash literally (defensive).
      bytes.push(0x5c);
      continue;
    }
    for (const b of encoder.encode(ch)) bytes.push(b);
  }
  return decoder.decode(Uint8Array.from(bytes));
}

// ─── Internal section state ─────────────────────────────────────

interface FileState {
  headerOldPath: string | null;
  headerNewPath: string | null;
  oldPath: string | null;
  oldPathSeen: boolean;
  newPath: string | null;
  newPathSeen: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
  isBinary: boolean;
  oldMode?: string;
  newMode?: string;
  hunks: DiffHunk[];
  rawLines: string[];
}

/** Try the 4 header forms; returns unescaped a/b paths on match. */
function matchFileHeader(line: string): { oldPath: string; newPath: string } | null {
  let m = HEADER_QUOTED_RE.exec(line);
  if (m)
    return { oldPath: unescapeQuotedPath(m[1] ?? ''), newPath: unescapeQuotedPath(m[2] ?? '') };
  m = HEADER_QUOTED_OLD_RE.exec(line);
  if (m) return { oldPath: unescapeQuotedPath(m[1] ?? ''), newPath: m[2] ?? '' };
  m = HEADER_QUOTED_NEW_RE.exec(line);
  if (m) return { oldPath: m[1] ?? '', newPath: unescapeQuotedPath(m[2] ?? '') };
  m = HEADER_PLAIN_RE.exec(line);
  if (m) return { oldPath: m[1] ?? '', newPath: m[2] ?? '' };
  return null;
}

/** Parse a `--- `/`+++ ` line. Returns the path, or null for /dev/null. */
function matchFileLine(re: RegExp, line: string): { path: string | null } | undefined {
  const m = re.exec(line);
  if (!m) return undefined;
  if (m[3] !== undefined) return { path: null }; // /dev/null
  if (m[1] !== undefined) return { path: unescapeQuotedPath(m[1]) };
  return { path: m[2] ?? '' };
}

function finalizeFile(state: FileState): ParsedFileDiff {
  // Resolved oldPath: explicit `--- ` line wins (including /dev/null → null),
  // then `rename from`, then the header a-side.
  const oldPath = state.oldPathSeen ? state.oldPath : (state.renameFrom ?? state.headerOldPath);
  const newPath = state.newPathSeen ? state.newPath : (state.renameTo ?? state.headerNewPath);

  // Display-path authority (design): `+++ b/` → `rename to` → header b-side → old.
  const path =
    (state.newPathSeen ? state.newPath : null) ??
    state.renameTo ??
    state.headerNewPath ??
    oldPath ??
    '';

  const file: ParsedFileDiff = {
    oldPath,
    newPath,
    path,
    isNew: state.isNew,
    isDeleted: state.isDeleted,
    isRename: state.isRename,
    isBinary: state.isBinary,
    hunks: state.hunks,
    rawLines: state.rawLines,
  };
  if (state.oldMode !== undefined) file.oldMode = state.oldMode;
  if (state.newMode !== undefined) file.newMode = state.newMode;
  return file;
}

// ─── Parser ─────────────────────────────────────────────────────

/**
 * Parse a unified diff. Defensive: never throws — non-diff input yields
 * `{ preamble: [...lines], files: [] }` (spec R1, C13/C14).
 */
export function parseUnifiedDiff(raw: string): ParsedDiff {
  const lines = raw.split('\n');
  const preamble: string[] = [];
  const files: ParsedFileDiff[] = [];

  let state: FileState | null = null;
  let currentHunk: DiffHunk | null = null;

  const flush = () => {
    if (state) files.push(finalizeFile(state));
    state = null;
    currentHunk = null;
  };

  for (const line of lines) {
    // 1) Hunk body lines bind tighter than anything else while a hunk is open
    //    (a deleted line `--- x` inside a hunk is content, not metadata).
    if (currentHunk && line.length > 0) {
      const prefix = line[0];
      if (prefix === '+' || prefix === '-' || prefix === ' ' || prefix === '\\') {
        const hunkLine: HunkLine = {
          prefix: prefix as HunkLine['prefix'],
          content: line.slice(1),
          raw: line,
        };
        currentHunk.lines.push(hunkLine);
        state?.rawLines.push(line);
        continue;
      }
    }

    // 2) File boundary?
    const header = matchFileHeader(line);
    if (header) {
      flush();
      state = {
        headerOldPath: header.oldPath,
        headerNewPath: header.newPath,
        oldPath: null,
        oldPathSeen: false,
        newPath: null,
        newPathSeen: false,
        renameFrom: null,
        renameTo: null,
        isNew: false,
        isDeleted: false,
        isRename: false,
        isBinary: false,
        hunks: [],
        rawLines: [line],
      };
      continue;
    }

    // 3) Before the first header everything is preamble.
    if (!state) {
      preamble.push(line);
      continue;
    }

    state.rawLines.push(line);

    // 4) New hunk?
    const hm = HUNK_HEADER_RE.exec(line);
    if (hm) {
      currentHunk = {
        oldStart: Number.parseInt(hm[1] ?? '0', 10),
        oldCount: hm[2] !== undefined ? Number.parseInt(hm[2], 10) : 1,
        newStart: Number.parseInt(hm[3] ?? '0', 10),
        newCount: hm[4] !== undefined ? Number.parseInt(hm[4], 10) : 1,
        header: line,
        lines: [],
      };
      state.hunks.push(currentHunk);
      continue;
    }

    // 5) Any other line closes an open hunk and is inspected as metadata.
    currentHunk = null;

    if (line.startsWith('new file mode ')) {
      state.isNew = true;
      state.newMode = line.slice('new file mode '.length);
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      state.isDeleted = true;
      state.oldMode = line.slice('deleted file mode '.length);
      continue;
    }
    if (line.startsWith('old mode ')) {
      state.oldMode = line.slice('old mode '.length);
      continue;
    }
    if (line.startsWith('new mode ')) {
      state.newMode = line.slice('new mode '.length);
      continue;
    }
    if (line.startsWith('rename from ')) {
      state.isRename = true;
      const value = line.slice('rename from '.length);
      state.renameFrom = value.startsWith('"') ? unescapeQuotedPath(value.slice(1, -1)) : value;
      continue;
    }
    if (line.startsWith('rename to ')) {
      state.isRename = true;
      const value = line.slice('rename to '.length);
      state.renameTo = value.startsWith('"') ? unescapeQuotedPath(value.slice(1, -1)) : value;
      continue;
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      state.isBinary = true;
      continue;
    }
    const oldLine = matchFileLine(OLD_FILE_RE, line);
    if (oldLine !== undefined && !state.oldPathSeen) {
      state.oldPath = oldLine.path;
      state.oldPathSeen = true;
      continue;
    }
    const newLine = matchFileLine(NEW_FILE_RE, line);
    if (newLine !== undefined && !state.newPathSeen) {
      state.newPath = newLine.path;
      state.newPathSeen = true;
    }
    // Anything else (index lines, similarity, binary payload, truncation
    // markers, garbage) stays in rawLines only.
  }

  flush();

  return { preamble, files };
}
