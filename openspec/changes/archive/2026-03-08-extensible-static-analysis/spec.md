# Extensible Static Analysis — Specification Summary

> **Change**: extensible-static-analysis
> **Status**: Draft
> **Date**: 2026-03-08

## Overview

This change replaces GHAGGA's hardcoded 3-tool static analysis (`semgrep`, `trivy`, `cpd`) with an extensible tool registry pattern supporting 15+ tools via auto-detection and plugin definitions.

## Spec Domains

| Domain              | Spec Path                | Type  | Description                                                                                      |
| ------------------- | ------------------------ | ----- | ------------------------------------------------------------------------------------------------ |
| Core Types          | `specs/core/spec.md`     | Delta | `ToolDefinition`, `ToolResult`, `StaticAnalysisResult` refactor, `ToolCategory`, `FindingSource` |
| Tool Definitions    | `specs/tools/spec.md`    | New   | 14 new + 3 adapted tool plugins with detect/install/run/parse contracts                          |
| Runner/Orchestrator | `specs/runner/spec.md`   | New   | Time budget, on-demand install, failure isolation, result aggregation                            |
| Settings            | `specs/settings/spec.md` | Delta | Migration from boolean flags to `enabled_tools` JSONB, backward compat                           |
| CLI                 | `specs/cli/spec.md`      | Delta | `--disable-tool`/`--enable-tool` flags, deprecated aliases                                       |

## Cross-Cutting Concerns

- **Backward compatibility**: `StaticAnalysisResult` MUST preserve `.semgrep`, `.trivy`, `.cpd` accessor patterns during migration window
- **All 4 distribution modes**: SaaS, GitHub Action, CLI, 1-click deploy MUST work with the new architecture
- **Finding cap**: Total findings injected into LLM context MUST be capped at 200, severity-sorted
- **Feature flag**: `GHAGGA_TOOL_REGISTRY=true` env var controls rollout; when false, fall back to hardcoded 3-tool path
