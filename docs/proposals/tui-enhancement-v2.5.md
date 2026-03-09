# TUI Enhancement Proposals — v2.4-v2.5

**Date**: 2026-03-08
**Status**: Proposal
**Related**: [Product Strategy v2.5](product-strategy-v2.5.md)
**Inspired by**: [RepoCheckAI](https://github.com/glaucia86/repocheckai)

> Historical proposal: kept for context. Parts of this document informed shipped v2.5 work, but it is not the canonical source for current behavior.

---

## Context

GHAGGA's CLI uses a `@clack/prompts` facade (`tui.ts`) with styled/plain modes. The output is functional but visually minimal — no colors beyond what `@clack` provides, no box-drawing, no progress bars, no rich formatting. RepoCheckAI demonstrates what a polished CLI TUI looks like: chalk colors, box drawing, ASCII logo, status bars, interactive REPL.

This document proposes concrete TUI improvements that maintain GHAGGA's architecture (facade pattern, styled/plain modes, no direct imports of UI libs in commands) while delivering a premium terminal experience.

---

## Design Constraints

1. **Facade pattern preserved** — commands only import `tui.ts` and `theme.ts`, never `chalk` or `@clack/prompts` directly (AD1)
2. **Plain mode always works** — CI, non-TTY, and `--plain` flag produce zero ANSI codes (R8, R10)
3. **No new heavy dependencies** — `chalk` is acceptable (~5KB), Ink/React is not
4. **ncc-compatible** — all deps must bundle cleanly with `@vercel/ncc`
5. **Tests must pass in CI** — plain mode is tested; styled mode can use snapshots or regex

---

## Proposal 1: Color Theming with Chalk

### Current State

`theme.ts` defines emoji maps (`SEVERITY_EMOJI`, `STATUS_EMOJI`, `STEP_ICON`) but no color functions. All text is the terminal's default color.

### Proposed Change

Add semantic color functions to `theme.ts` that use `chalk` in styled mode and return plain strings in plain mode.

```typescript
// apps/cli/src/ui/theme.ts
import chalk from 'chalk';

/** Brand purple — consistent with landing page (#a78bfa) */
const BRAND = chalk.hex('#a78bfa');

/** Semantic color functions for styled mode */
export const c = {
  brand:    (s: string) => BRAND(s),
  critical: (s: string) => chalk.red(s),
  high:     (s: string) => chalk.hex('#f97316')(s),  // orange
  medium:   (s: string) => chalk.yellow(s),
  low:      (s: string) => chalk.green(s),
  info:     (s: string) => chalk.hex('#a78bfa')(s),  // purple
  success:  (s: string) => chalk.green(s),
  warning:  (s: string) => chalk.yellow(s),
  error:    (s: string) => chalk.red(s),
  dim:      (s: string) => chalk.dim(s),
  bold:     (s: string) => chalk.bold(s),
  white:    (s: string) => chalk.white(s),
} as const;

/** No-op color functions for plain mode */
export const cPlain: typeof c = {
  brand:    (s) => s,
  critical: (s) => s,
  high:     (s) => s,
  medium:   (s) => s,
  low:      (s) => s,
  info:     (s) => s,
  success:  (s) => s,
  warning:  (s) => s,
  error:    (s) => s,
  dim:      (s) => s,
  bold:     (s) => s,
  white:    (s) => s,
};
```

**In `tui.ts`**, expose a `colors()` getter that returns `c` or `cPlain` based on mode:

```typescript
export function colors(): typeof c {
  return _plain ? cPlain : c;
}
```

**Usage in commands** (no direct chalk import):

```typescript
import * as tui from '../ui/tui.js';
const c = tui.colors();
tui.log.info(`${c.critical('CRITICAL')} SQL injection in ${c.dim('src/db.ts:42')}`);
```

### Effort: 4 hours
### Impact: High — biggest visual improvement for least effort

---

## Proposal 2: Box-Drawing Summary

### Current State

Review results print as flat markdown text with no visual grouping.

### Proposed Change

Add a `box()` function to `tui.ts` that renders text inside a Unicode box:

```typescript
export function box(title: string, lines: string[], width?: number): void {
  if (_plain) {
    console.log(`═══ ${title} ═══`);
    for (const line of lines) console.log(`  ${line}`);
    console.log('═'.repeat(title.length + 8));
    return;
  }
  
  const w = width ?? Math.max(60, ...lines.map(l => stripAnsi(l).length + 4));
  const c = colors();
  console.log(c.dim(`╭─ ${title} ${'─'.repeat(Math.max(0, w - title.length - 4))}╮`));
  for (const line of lines) {
    const pad = ' '.repeat(Math.max(0, w - stripAnsi(line).length - 2));
    console.log(c.dim('│') + ` ${line}${pad}` + c.dim('│'));
  }
  console.log(c.dim(`╰${'─'.repeat(w)}╯`));
}
```

**Example output** (styled mode):

```
╭─ GHAGGA Code Review ──────────────────────────╮
│ ✅ PASSED  │  simple  │  gpt-4o-mini  │  3.2s │
│                                                │
│ 🔴 2 critical  🟡 3 medium  🟢 1 info         │
│ 🛡️ Semgrep: 2  📋 CPD: 1  🤖 AI: 3            │
╰────────────────────────────────────────────────╯
```

### Effort: 4 hours
### Impact: High — frames the review result as a polished artifact

---

## Proposal 3: Step Progress Indicator

### Current State

Verbose mode (`--verbose`) uses `tui.log.step()` with icons per step. No overall progress context.

### Proposed Change

Add a step counter to the spinner messages in verbose mode:

```
[1/7] 🔍 Validating input...
[2/7] 📄 Parsing diff (42 files, 12 filtered)...
[3/7] 🧩 Detecting stacks: TypeScript, Python
[4/7] 📊 Token budget: 45,000 / 128,000
[5/7] 🛡️ Running static analysis (15 tools)...
[6/7] 🤖 AI review (workflow mode, 5 agents)...
[7/7] 📋 Merging findings (18 total)...
```

**Implementation**: Add `stepOf(current: number, total: number)` to `tui.ts`:

```typescript
export function stepOf(current: number, total: number, message: string): string {
  if (_plain) return `[${current}/${total}] ${message}`;
  const c = colors();
  return `${c.dim(`[${current}/${total}]`)} ${message}`;
}
```

### Effort: 3 hours
### Impact: Medium — gives users confidence the process is progressing

---

## Proposal 4: `--output <file>` Flag

### Current State

Review results go to stdout only. Format can be `markdown` or `json` via `--format`.

### Proposed Change

Add `--output <path>` flag to the `review` command that writes the formatted result to a file:

```bash
ghagga review --output report.md          # markdown
ghagga review --format json --output report.json  # json
ghagga health --output health-report.md   # (future health command)
```

**Implementation** in `commands/review.ts`:

```typescript
if (options.output) {
  const content = options.format === 'json'
    ? JSON.stringify(result, null, 2)
    : formatMarkdownResult(result);
  writeFileSync(options.output, content, 'utf-8');
  tui.log.success(`Report saved to ${options.output}`);
}
```

### Effort: 2 hours
### Impact: Medium — essential for CI pipelines and archival

---

## Proposal 5: `--copy` Flag

### Current State

No clipboard integration. Users must manually select + copy terminal output.

### Proposed Change

Add `--copy` flag that copies the review result to the system clipboard:

```bash
ghagga review --copy              # copies markdown result
ghagga review --format json --copy  # copies JSON result
```

**Implementation**: Use native clipboard commands to avoid dependency issues with ncc:

```typescript
import { execSync } from 'node:child_process';
import { platform } from 'node:os';

function copyToClipboard(text: string): boolean {
  try {
    const cmd = platform() === 'darwin' ? 'pbcopy'
              : platform() === 'win32'  ? 'clip'
              : 'xclip -selection clipboard';
    execSync(cmd, { input: text });
    return true;
  } catch {
    return false;
  }
}
```

### Effort: 2 hours
### Impact: Low-Medium — convenience for terminal users

---

## Proposal 6: Score Visualization Bar

### Current State

No numeric scores or visual bars.

### Proposed Change

Add a `scoreBar()` function for the health feature (and potentially review quality):

```typescript
export function scoreBar(score: number, width: number = 20): string {
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  const c = colors();
  
  const color = score >= 80 ? c.success : score >= 60 ? c.warning : c.error;
  const label = score >= 80 ? 'GOOD' : score >= 60 ? 'FAIR' : 'POOR';
  
  if (_plain) return `[${score}/100] ${label}`;
  
  return `${color(`${'█'.repeat(filled)}${'░'.repeat(empty)}`)} ${color(`${score}%`)} ${c.dim(`[${label}]`)}`;
}
```

**Example output**:

```
████████████████░░░░ 78% [GOOD]
████████████░░░░░░░░ 60% [FAIR]
██████░░░░░░░░░░░░░░ 30% [POOR]
```

### Effort: 2 hours
### Impact: High — essential for health feature, strong visual impression

---

## Proposal 7: Section Dividers

### Current State

Review output sections use markdown headers (`## Summary`, `## Findings`) which look flat in the terminal.

### Proposed Change

Add a `section()` function for styled section headers:

```typescript
export function section(title: string): void {
  if (_plain) {
    console.log(`\n── ${title} ──`);
    return;
  }
  const c = colors();
  console.log(`\n  ${c.brand('━━━')} ${c.bold(title)} ${c.brand('━'.repeat(Math.max(0, 50 - title.length)))}`);
}
```

**Example output** (styled):

```
  ━━━ Static Analysis ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  
  🔴 CRITICAL  SQL injection in src/db.ts:42
     Suggestion: Use parameterized queries
  
  ━━━ AI Review ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  
  🟡 MEDIUM  Missing error handling in fetchUser()
```

### Effort: 2 hours
### Impact: Medium — better visual hierarchy in output

---

## Proposal 8: Agent Step Limits (Guardrails)

### Current State

No explicit limits on agent execution steps. In Workflow mode (5 specialist agents + 1 synthesis) or Consensus mode (3 models), a stalled LLM provider could consume tokens indefinitely.

### Proposed Change

Add per-mode timeout and step limits in the pipeline:

```typescript
// packages/core/src/constants.ts
export const AGENT_LIMITS = {
  simple:    { maxSteps: 1,  timeoutMs: 60_000  },
  workflow:  { maxSteps: 10, timeoutMs: 180_000 },
  consensus: { maxSteps: 6,  timeoutMs: 180_000 },
} as const;
```

**Integration in pipeline.ts**: wrap each agent call with `AbortSignal.timeout()` and a step counter. If limits are exceeded, gracefully degrade to available results.

### Effort: 4 hours
### Impact: Medium-High — prevents token waste in production

---

## Proposal 9: Colored Findings in Review Output

### Current State

Findings use emoji for severity (`🔴`, `🟡`) but the text itself is uncolored.

### Proposed Change

In `format.ts`, apply color to severity text and dim the metadata:

**Before**:
```
🔴 [CRITICAL] security
   src/db.ts:42
   SQL injection vulnerability in query builder
```

**After** (styled):
```
🔴 CRITICAL  security
   src/db.ts:42
   SQL injection vulnerability in query builder
   💡 Use parameterized queries instead of string concatenation
```

Where `CRITICAL` is in red, `src/db.ts:42` is dimmed, and the suggestion is in the default color.

### Effort: 3 hours
### Impact: High — makes findings scannable at a glance

---

## Summary: Implementation Priority

### v2.4.0 — TUI Polish (Week 1-2)

| # | Proposal | Effort | Files Changed |
|---|----------|--------|---------------|
| 1 | Color theming with chalk | 4h | `theme.ts`, `tui.ts` |
| 2 | Box-drawing summary | 4h | `tui.ts`, `review.ts` |
| 3 | Step progress indicator | 3h | `tui.ts`, `review.ts` |
| 4 | `--output` flag | 2h | `index.ts`, `review.ts` |
| 7 | Section dividers | 2h | `tui.ts`, `format.ts` |
| 8 | Agent step limits | 4h | `pipeline.ts`, `constants.ts` |
| 9 | Colored findings | 3h | `format.ts` |
| | Tests (~50 new) | 8h | `*.test.ts` |
| | **Total** | **~30h** | |

### v2.5.0 — Health Feature (Weeks 3-6)

| # | Proposal | Effort | Files Changed |
|---|----------|--------|---------------|
| 5 | `--copy` flag | 2h | `review.ts`, `health.ts` |
| 6 | Score visualization bar | 2h | `tui.ts` |
| | Health engine | ~90h | See product-strategy-v2.5.md |
| | **Total** | **~94h** | |

### Rejected

| Proposal | Reason |
|----------|--------|
| Interactive REPL | Wrong interaction model — GHAGGA is run-and-exit |
| Local Web UI | Redundant with Dashboard (GitHub Pages) |
| ASCII logo animation | Vanity — wastes terminal space |
| Model selector UI | Flags are faster and more scriptable |

---

## Dependencies

| Package | Version | Size | Purpose | ncc-compatible? |
|---------|---------|------|---------|-----------------|
| `chalk` | ^5.3.0 | ~5KB | Terminal colors | Yes (ESM) |

No other new dependencies. `--copy` uses native `pbcopy`/`xclip`/`clip` via `child_process.execSync`.

---

## Testing Strategy

- All TUI functions have plain mode tests (zero ANSI codes in output)
- Styled mode tests use regex or `stripAnsi()` to verify content
- `--output` and `--copy` have integration tests with tmp files
- Agent guardrails have unit tests with mock providers
- Existing 287 CLI tests must continue passing without modification
