# Proposal: CLI Git Hooks — Pre-Commit and Commit-Msg Review

> **Priority**: v2.2.0  
> **Status**: Deferred (post v2.1.0 release)

## Intent

GHAGGA CLI already has `ghagga review .` for local code review, with Semgrep/Trivy/CPD static analysis, LLM-powered review, SQLite memory, TUI output via `@clack/prompts`, and a `--plain` flag for CI/non-TTY contexts. Everything needed to review code locally exists — but it requires the developer to explicitly run the command.

Adding git hook support would let GHAGGA automatically review code at the natural checkpoints in a developer's workflow: pre-commit (review staged changes before they're committed) and commit-msg (validate commit message quality). This closes the gap between GHAGGA and GGA (the Bash-based tool), making GHAGGA a complete replacement — from local hooks to PR review to SaaS dashboard.

With this feature, developers install hooks once (`ghagga hooks install`) and get automatic code review on every commit, with the option to block commits when critical issues are found (`--exit-on-issues`).

## Scope

### In Scope

- **`hooks` command group** (`apps/cli/src/commands/hooks/`): New subcommands `install` and `uninstall` registered under `ghagga hooks`
- **`ghagga hooks install`**: Writes pre-commit and commit-msg hook scripts to `.git/hooks/`, backing up any existing hooks. Hooks are shell scripts that invoke `ghagga review` with the appropriate flags
- **`ghagga hooks uninstall`**: Removes GHAGGA-installed hooks from `.git/hooks/`, restoring backed-up originals if they exist
- **`--staged` flag for `ghagga review`**: Reviews only staged files (`git diff --staged --name-only` for file list, `git diff --staged` for diff content). Runs the full review pipeline but scoped to the staged changeset
- **`--commit-msg <file>` flag for `ghagga review`**: Reads the commit message from the provided file path and validates it for quality (length, structure, conventional commit format). Uses a lightweight LLM prompt focused on commit message review only — no file analysis
- **`--exit-on-issues` flag for `ghagga review`**: Exit code 1 when critical or high severity issues are found. Default behavior (without the flag) remains exit code 0 regardless of findings. This flag is what makes hooks blocking vs. advisory
- **`--quick` flag for `ghagga review`**: Runs only static analysis (Semgrep, Trivy, CPD) without the LLM review step. Designed for pre-commit hooks where speed matters — static analysis completes in seconds vs. LLM review taking 10-30 seconds
- **Hook template files**: Shell scripts (`pre-commit.sh`, `commit-msg.sh`) embedded in the CLI bundle or generated programmatically. Each script calls `ghagga review` with `--plain` (non-TTY context), appropriate flags, and `--exit-on-issues`
- **Memory integration**: Hook-triggered reviews save observations to SQLite memory (same `~/.config/ghagga/memory.db`), building institutional knowledge from every commit

### Out of Scope

- **`pre-push` hook**: Not included in v2.2.0 — pre-push would review the entire branch diff, which is closer to what `ghagga review .` already does. Can be added later
- **Husky/lint-staged integration**: GHAGGA installs hooks directly to `.git/hooks/`. Integration with hook managers like Husky is deferred — they can coexist but GHAGGA doesn't manage Husky config
- **Shared hooks via `.githooks/`**: Git 2.9+ supports `core.hooksPath` for team-shared hooks. GHAGGA v2.2.0 targets per-developer installation only. Team-shared configuration is a future feature
- **Hook configuration file** (e.g., `.ghagga-hooks.yml`): No config file for hook behavior — flags are embedded in the hook scripts. Customization is done by editing the hook scripts directly or reinstalling with different options
- **Windows support**: Hook scripts are POSIX shell (`#!/bin/sh`). Windows users would need Git Bash or WSL. Native `.cmd`/PowerShell hooks are deferred
- **SaaS/Action mode**: Hooks are CLI-only. The Action and SaaS server are not affected

## Approach

### What Already Exists (No New Work Needed)

| Capability                               | Status  | Location                                              |
| ---------------------------------------- | ------- | ----------------------------------------------------- |
| Local code review                        | Working | `ghagga review .` — `apps/cli/src/commands/review.ts` |
| Semgrep/Trivy/CPD static analysis        | Working | `packages/core/src/analyzers/`                        |
| LLM multi-provider review                | Working | `packages/core/src/pipeline.ts`                       |
| SQLite memory                            | Working | `packages/core/src/memory/sqlite.ts`                  |
| TUI with `@clack/prompts`                | Working | `apps/cli/src/ui/`                                    |
| `--plain` flag for CI/non-TTY            | Working | `apps/cli/src/index.ts`                               |
| `--no-memory` flag                       | Working | `apps/cli/src/commands/review.ts`                     |
| `--no-semgrep`, `--no-trivy`, `--no-cpd` | Working | `apps/cli/src/commands/review.ts`                     |

### What Needs to Be Added

#### 1. `hooks` Command Group

```
ghagga hooks install [options]
  --quick         Use --quick mode in pre-commit hook (static analysis only, no LLM)
  --no-commit-msg Skip commit-msg hook installation
  --no-pre-commit Skip pre-commit hook installation

ghagga hooks uninstall
```

`install` generates shell scripts and writes them to `.git/hooks/pre-commit` and `.git/hooks/commit-msg`. If existing hooks are found, they're backed up to `<hook>.ghagga-backup`.

`uninstall` removes GHAGGA-generated hooks (identified by a `# GHAGGA HOOK` marker comment) and restores backups if they exist.

#### 2. Hook Script Templates

**pre-commit hook:**
```sh
#!/bin/sh
# GHAGGA HOOK — installed by `ghagga hooks install`
# To uninstall: ghagga hooks uninstall

ghagga review --staged --exit-on-issues --plain ${GHAGGA_HOOK_ARGS:-}
```

With `--quick` option:
```sh
ghagga review --staged --quick --exit-on-issues --plain ${GHAGGA_HOOK_ARGS:-}
```

**commit-msg hook:**
```sh
#!/bin/sh
# GHAGGA HOOK — installed by `ghagga hooks install`
ghagga review --commit-msg "$1" --exit-on-issues --plain ${GHAGGA_HOOK_ARGS:-}
```

The `${GHAGGA_HOOK_ARGS:-}` variable allows developers to pass additional flags without editing the hook script (e.g., `GHAGGA_HOOK_ARGS="--no-memory" git commit`).

#### 3. Review Command Extensions

| New Flag              | Behavior                                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--staged`            | Scope review to staged files only. Uses `git diff --staged --name-only` for file list and `git diff --staged` for diff content. Passes the staged diff to the review pipeline instead of the full working tree |
| `--commit-msg <file>` | Read commit message from file, validate quality via a lightweight LLM prompt. No file analysis — only commit message review                                                                                    |
| `--exit-on-issues`    | Exit code 1 if any finding has severity `critical` or `high`. Exit code 0 otherwise. Default (without flag) is always exit code 0                                                                              |
| `--quick`             | Skip LLM review step entirely. Run only static analyzers (Semgrep, Trivy, CPD). Designed for speed in pre-commit hooks                                                                                         |

#### 4. Staged File Review Flow

```
git commit
  └─ .git/hooks/pre-commit
       └─ ghagga review --staged --exit-on-issues --plain
            ├─ git diff --staged --name-only → file list
            ├─ git diff --staged → diff content
            ├─ Run static analyzers on staged files only
            ├─ Run LLM review on staged diff (or skip with --quick)
            ├─ Save observations to memory
            ├─ Check findings: any critical/high? → exit 1 (blocks commit)
            └─ No critical/high → exit 0 (commit proceeds)
```

#### 5. Commit Message Validation Flow

```
git commit
  └─ .git/hooks/commit-msg .git/COMMIT_EDITMSG
       └─ ghagga review --commit-msg .git/COMMIT_EDITMSG --exit-on-issues --plain
            ├─ Read commit message from file
            ├─ LLM prompt: validate length, structure, conventional format
            ├─ If issues found → exit 1 (blocks commit)
            └─ No issues → exit 0 (commit proceeds)
```

## Affected Areas

| Area                                 | Impact   | Description                                                                                                                           |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cli/src/commands/hooks/` (new) | New      | `install.ts`, `uninstall.ts`, `index.ts` — hook management commands                                                                   |
| `apps/cli/src/commands/review.ts`    | Modified | Add `--staged`, `--commit-msg`, `--exit-on-issues`, `--quick` flags. Implement staged file scoping and commit message validation mode |
| `apps/cli/src/index.ts`              | Modified | Register `hooks` command group                                                                                                        |
| `packages/core/src/pipeline.ts`      | Modified | Support staged diff input mode; support `quick` mode (skip LLM step)                                                                  |
| `packages/core/src/types.ts`         | Modified | Add `staged`, `commitMsg`, `exitOnIssues`, `quick` fields to `ReviewInput` or `ReviewSettings`                                        |
| Existing tests                       | None     | New flags are additive; existing behavior unchanged when flags are not set                                                            |
| ncc bundle                           | None     | No new dependencies — hook scripts are plain strings embedded in the bundle                                                           |

## Risks

| Risk                                                | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js not in PATH during git hook execution       | Medium     | High   | Hook scripts must find the `ghagga` binary. If installed globally via npm, it's in PATH. If installed locally, the hook should use `npx ghagga` or a project-relative path. Document requirements clearly. Add a PATH check at the top of hook scripts with a helpful error message                                                                                                 |
| Hook execution speed annoys developers              | High       | High   | Pre-commit hooks run on every commit. Full LLM review takes 10-30s, which is too slow. The `--quick` flag (static analysis only) is the primary mitigation — Semgrep/Trivy/CPD run in 2-5s. Make `--quick` the default for `ghagga hooks install` and let developers opt into full review with `--no-quick`                                                                         |
| Staged files not yet on disk (partially staged)     | Low        | Medium | `git diff --staged` works with the index, not the working tree. Files may be partially staged (some hunks staged, others not). The diff from `git diff --staged` correctly reflects only staged content. Static analyzers that read files from disk (Semgrep) may see un-staged changes. Mitigation: use `git stash --keep-index` before analysis or run analyzers on the diff only |
| Hook conflicts with Husky/other hook managers       | Medium     | Low    | GHAGGA installs directly to `.git/hooks/`. If Husky is managing hooks via `core.hooksPath`, GHAGGA's hooks won't run. Detect `core.hooksPath` and warn the user. Document coexistence patterns                                                                                                                                                                                      |
| `--exit-on-issues` blocks commit on false positives | Medium     | Medium | Developers can skip hooks with `git commit --no-verify`. Document this escape hatch. Tune severity thresholds — only `critical` and `high` block, not `medium` or `low`                                                                                                                                                                                                             |
| Commit message validation too strict/opinionated    | Low        | Medium | The LLM prompt should be advisory, not prescriptive. Focus on egregiously bad messages (empty, single word, "fix", "asdf") rather than enforcing a specific format. Make commit-msg hook optional with `--no-commit-msg` during install                                                                                                                                             |

## Rollback Plan

1. `ghagga hooks uninstall` removes all GHAGGA hooks — clean uninstall
2. Developers can also manually delete `.git/hooks/pre-commit` and `.git/hooks/commit-msg` (or restore from `.ghagga-backup`)
3. The new CLI flags (`--staged`, `--commit-msg`, `--exit-on-issues`, `--quick`) are additive — removing the `hooks` command group doesn't affect existing review functionality
4. No database migrations, no config changes, no server-side changes

## Dependencies

- No new npm dependencies
- Git (`>= 2.9` for `core.hooksPath` detection, but hooks work with any git version)
- Node.js must be available in the PATH where git hooks execute
- Existing GHAGGA CLI (`ghagga review .`) must be working

## Strategic Impact

This feature positions GHAGGA as a complete replacement for GGA (the Bash-based tool):

| Capability            | GGA (Bash)              | GHAGGA (after this change)      |
| --------------------- | ----------------------- | ------------------------------- |
| Pre-commit review     | Yes (hooks)             | Yes (`ghagga hooks install`)    |
| Commit-msg validation | Yes (hooks)             | Yes (`--commit-msg`)            |
| Local review          | Yes (`gga review`)      | Yes (`ghagga review .`)         |
| PR review (GitHub)    | No                      | Yes (GitHub Action)             |
| SaaS dashboard        | No                      | Yes (web app)                   |
| Memory/learning       | Limited (Engram bridge) | Yes (SQLite, PostgreSQL)        |
| Multi-provider AI     | No (OpenAI only)        | Yes (Anthropic, OpenAI, Google) |
| Static analysis       | Basic (ShellCheck)      | Full (Semgrep, Trivy, CPD)      |

After v2.2.0, GGA becomes a legacy/Bash-only alternative for users who prefer zero-dependency shell scripts. GHAGGA covers every use case GGA had, plus PR review, SaaS, dashboard, and multi-provider AI.

## Success Criteria

- [ ] `ghagga hooks install` creates working pre-commit and commit-msg hooks in `.git/hooks/`
- [ ] `ghagga hooks uninstall` removes GHAGGA hooks and restores backups
- [ ] `ghagga hooks install` backs up existing hooks before overwriting
- [ ] `ghagga review --staged` reviews only staged files (not the full working tree)
- [ ] `ghagga review --commit-msg .git/COMMIT_EDITMSG` validates commit message quality
- [ ] `ghagga review --exit-on-issues` exits with code 1 when critical/high findings exist
- [ ] `ghagga review --quick` runs static analysis only (no LLM), completes in < 5 seconds
- [ ] Hooks use `--plain` automatically (no ANSI output, no spinners in non-TTY)
- [ ] Hook-triggered reviews save observations to SQLite memory
- [ ] `git commit` with hooks installed triggers review and blocks on critical issues
- [ ] `git commit --no-verify` skips hooks (standard git behavior, no GHAGGA work needed)
- [ ] Existing `ghagga review .` behavior is unchanged (no flags = current behavior)
- [ ] All existing tests pass without modification
- [ ] `ghagga hooks --help` documents both subcommands
- [ ] `ghagga review --help` documents all new flags
