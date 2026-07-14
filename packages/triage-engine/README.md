# ghagga-triage-engine

Config-driven, code-aware issue triage and reproduction engine for GHAGGA.

Generalizes two internal PoCs (biogas GitLab-issue triage + a Playwright
reproduction harness) into a package that any project can drive from its own
config — no project-specific literal (repo, language, dirs, stopwords) is
hardcoded in the engine source.

Runs **parallel** to GHAGGA's shipped GitHub-App review pipeline
(`apps/server`). It is CLI-first, keeps its queue as local JSON, and **never
auto-posts** — every comment that reaches a forge went through an explicit
human `approve`.

## Pipeline

```
config → forge.getIssue → LOCATE (keywords → scan → rerank → expand)
       → [optional] REPRODUCE (lazy Playwright, only if app+loginRecipe configured)
       → TRIAGE (wraps ghagga-core's runIssueTriage for the internal technical
                  analysis, then a separate jargon-banned client-reply call)
       → queue.save (draft, status PENDING_APPROVAL)
human review (CLI or the local web UI)
       → approve → PostableReply (branded, type-level guarantee) → forge.postComment (POSTED)
```

## Security guarantees

These are **type-level and structural** invariants, not conventions:

- **Never auto-posts.** `triageIssue`/`triageNew` write a `PENDING_APPROVAL`
  draft to the local queue and stop. Only `approveIssue` — which a human
  triggers explicitly (CLI `approve` or the web UI's Approve button) — calls
  `ForgeAdapter.postComment`.
- **Never posts the technical analysis.** `PostableReply` is a branded
  string, constructible ONLY via `approveDraft`/`approveAndPost`. A draft's
  `report` field (the internal technical analysis) is a plain `string` —
  TypeScript rejects passing it to `postComment` at compile time, not just by
  convention.
- **Idempotent approval.** Approving an already-`POSTED` draft is a no-op —
  it never re-posts.
- **Reject never posts**, under any circumstance.

## Config schema

A `TriageConfig` (zod-validated) is the only source of project-specific
behavior:

| Field | Type | Notes |
|---|---|---|
| `forge` | `'gitlab' \| 'github'` | Which CLI adapter to use (`glab` / `gh`) |
| `repo` | `string` | `owner/name` |
| `codeRoot` | `string` | Absolute path to the target repo's checkout |
| `moduleMap` | `Record<string, string[]>` | `módulo::x` label → code dirs to scan |
| `synonyms` | `Record<string, string[]>` | ES→EN (or any) keyword bridge |
| `stopwords` | `string[]` | Overrides the built-in default stopword set |
| `language` | `'go' \| 'ts' \| 'js' \| 'py' \| 'rust' \| 'java'` | Default `'go'` |
| `graphExpand` | `boolean` | Use ghagga-core's `buildGraph`/`computeBlastRadius` for EXPAND instead of dir-sibling. **Only `ts`/`js` actually resolve seed→dependents today** (see caveat below) — default `false` |
| `models` | `{ rerank: string; analysis: string; reproduce?: string }` | Model ids passed to `createCLIBridgeGenerateFn` (`preferredCLI: 'opencode'`). `reproduce` is optional — the CLI's `--reproduce` flag falls back to a hardcoded default (`opencode-go/kimi-k2.7-code`) when it is unset |
| `app` | `{ baseURL: string; loginRecipe: LoginRecipe }` (optional) | Enables the REPRODUCE stage |
| `clientReplyPolicy` | `{ language: string; jargonBan?: string[] }` (optional) | Client-reply language + banned jargon terms |

### `loginRecipe`

```ts
type LoginRecipe =
  | { kind: 'none' }
  | { kind: 'steps'; steps: Array<{ action: 'goto' | 'fill' | 'click'; role?: string; name?: string; label?: string; value?: string; url?: string }> }
  | { kind: 'storageState'; path: string };
```

`steps` walks a login form via Playwright locators. `storageState` loads a
pre-authenticated Playwright storage-state file (needed for SSO/MFA) — that
path **must be gitignored**; it is a live session token. `none` is for public
targets that need no login.

### Graph-resolution caveat

`graphExpand: true` asks ghagga-core's `buildGraph`/`computeBlastRadius` to
find real dependents of the seed files instead of falling back to
dir-sibling expansion. This was validated empirically per language and
**only TypeScript and JavaScript actually resolve seed→dependent edges
today** — Python, Rust, Java, and Go do not, and Go additionally has a known
dir-sibling-only default. Leave `graphExpand: false` (the default) for any
other language; `expand()` always falls back to dir-sibling for
non-resolvable languages regardless of the flag.

## CLI usage (`ghagga triage`)

```
ghagga triage [--config <path>] triage <iid>       # triage one issue -> PENDING_APPROVAL draft
ghagga triage [--config <path>] triage --new       # triage every listed issue not already queued
ghagga triage [--config <path>] list                # list the local queue
ghagga triage [--config <path>] show <iid>          # show a draft in full (report + clientReply)
ghagga triage [--config <path>] edit <iid> --reply <text>  # edit the client reply
ghagga triage [--config <path>] approve <iid> [--reply <text>]  # approve + post (ONLY posting path)
ghagga triage [--config <path>] reject <iid>        # reject — never posts
ghagga triage [--config <path>] serve [port]        # local web review UI (default port 4599)
```

Config resolution precedence: `--config <path>` → `$GHAGGA_TRIAGE_CONFIG` →
`./.ghagga/triage.config.json`.

### Web review UI

`ghagga triage serve` starts a native-http server (no extra dependency) on
`localhost` with a card per queued draft: the technical analysis is shown
inside a collapsible `<details>` block (for the human reviewer only — it is
never sent anywhere), and the client reply is an editable textarea with
Save / Approve+post / Reject buttons. It binds to localhost by design (no
auth layer) — do not expose it on a public interface.

## Manual real-app reproduction

The REPRODUCE stage's automated test suite runs against a bundled static
fixture page (`src/reproduce/fixtures/fake-app.html`) with a mocked
`generateFn` — deterministic and browser-download-gated, never against a live
app in CI. Reproducing against your actual target application is a
documented **manual** step: run `ghagga triage triage <iid>` (or the `serve`
UI's "Triage issue" action) with `app.baseURL` + `app.loginRecipe` configured
and `@playwright/test`'s browsers installed (`npx playwright install
chromium`).

## Example config

See [`examples/biogas.config.json`](./examples/biogas.config.json) for a
reference shape (no secrets — the real repo/paths shown there were already
public in this monorepo's own PoC).
