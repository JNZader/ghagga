# Spec: CLI Git Hooks

> **Change**: cli-git-hooks
> **Status**: draft

## Domains

This change spans 4 spec domains:

| Domain       | Type  | Spec Location                |
| ------------ | ----- | ---------------------------- |
| hooks        | New   | `specs/hooks/spec.md`        |
| cli-tui      | Delta | `specs/cli-tui/spec.md`      |
| core-engine  | Delta | `specs/core-engine/spec.md`  |
| distribution | Delta | `specs/distribution/spec.md` |

## Summary

### hooks (new)

Full specification for the `ghagga hooks` command group: `install`, `uninstall`, and `status` subcommands. Covers hook script generation, GHAGGA marker identification, backup/restore, graceful degradation when `ghagga` is not in PATH, `core.hooksPath` detection, and `GHAGGA_HOOK_ARGS` runtime customization.

### cli-tui (delta)

Adds TUI requirements for the hooks command group output (styled and plain modes). Modifies the review command help text to document the four new flags.

### core-engine (delta)

Adds staged diff mode, quick mode (static analysis only), commit message validation mode, exit-on-issues mode, and mutual exclusivity between `--staged` and `--commit-msg`. Modifies ReviewInput type extension notes.

### distribution (delta)

Modifies CLI mode to register the hooks command group and support new review flags. Adds hook-triggered review scope requirements. Explicitly states SaaS and Action modes are unaffected.
