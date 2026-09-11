# OpenReview Comparison and GHAGGA Adoption Strategy

> **Status:** Approved direction; implementation deferred
> **Decision date:** 2026-08-28
> **GHAGGA evidence baseline:** `origin/main` at `ddc7a02`
> **OpenReview evidence baseline:** `672deb21e70e471e0536d5ad7a67c14b8359e97e`

## Executive decision

GHAGGA remains the review engine. OpenReview is not a replacement for it.

OpenReview demonstrates a compelling PR-native conversation and ephemeral
execution experience. GHAGGA already has the stronger foundation for dependable
review: deterministic analysis, structured findings, persistent memory, code
intelligence, multiple review modes, provider routing, forge abstractions,
privacy controls, and several distribution options.

The approved direction is therefore selective adoption:

1. Keep GHAGGA's core pipeline and security posture.
2. Add conversational PR intents and visible progress.
3. Represent suggestions as immutable, explicitly approved artifacts.
4. Add progressive skills as untrusted, metadata-first inputs.
5. Introduce a provider-neutral sandbox interface only where dynamic execution
   materially improves review evidence.
6. Keep read-only review separate from any mutation capability.

This document records a product and architecture direction. It does not
authorize implementation, dependency adoption, or code reuse from OpenReview.

## Evidence grades

- **Verified:** observed in source code, repository metadata, or the current
  GHAGGA checkout.
- **Advertised:** claimed by project documentation but not fully established by
  the inspected implementation.
- **Inferred:** a design consequence or risk derived from verified behavior.

All OpenReview source claims below are pinned to the immutable baseline commit,
not to the moving default branch.

## Baseline: GHAGGA

### Verified strengths

- A staged review pipeline: prepare, gather context, execute, enrich, and
  finalize.
- Deterministic static analysis before model-based analysis.
- Persistent project memory and optional embedding retrieval.
- SCIP/tree-sitter code intelligence, blast-radius analysis, and call chains.
- Multiple execution modes, including simple, workflow, consensus, fan-out,
  and diagnostic paths in the core.
- Provider routing and fallback rather than a single hardcoded model.
- Structured `ReviewResult` output, explicit coverage state, JSON, SARIF,
  Markdown, and dashboard surfaces.
- GitHub and GitLab integration through forge abstractions.
- GitHub App, GitHub Action, npm CLI, and self-hosted deployment options.
- Privacy stripping, input fencing, encrypted credentials, HMAC boundaries,
  SSRF protections, and credentials kept out of Redis queue payloads.
- Human approval is already an established invariant for issue-triage drafts.

### Current tradeoffs

- The conversational experience inside a pull request is command-oriented,
  rather than a stateful natural-language thread.
- Core capabilities are not exposed uniformly across CLI, Action, server, and
  dashboard surfaces.
- Dynamic execution against the full repository is not expressed through one
  portable executor contract.
- Inline fixes and reaction-driven actions do not yet use a typed immutable
  suggestion artifact.
- Progress could be communicated at finer-grained pipeline stages.

## Baseline: OpenReview

### Verified strengths

- Natural-language invocation and follow-up inside a pull request.
- Visible work-in-progress feedback and inline responses.
- Ephemeral full-repository execution in Vercel Sandbox.
- Shell and filesystem tools allow the agent to inspect beyond the diff and run
  repository tooling.
- Progressive skill disclosure: metadata is shown first and full instructions
  are loaded on demand.
- A compact workflow with explicit sandbox cleanup.
- The agent can explain, test, edit, and respond within one PR-native flow.

### Verified limitations

- The inspected implementation is described as a beta/internal experiment.
- It has no tagged release, test suite, test script, or repository CI at the
  analyzed baseline.
- It is GitHub-specific and tied to Vercel Workflow and Vercel Sandbox.
- It selects `anthropic/claude-sonnet-4.6` rather than exposing a provider-neutral
  routing contract.
- It uses a single agent rather than GHAGGA's multi-mode orchestration.
- Redis preserves thread state, not durable project learning across reviews.
- Findings and suggestions are largely prompt-driven rather than represented by
  a typed review schema.
- A reaction starts another workflow; it is not cryptographically or
  structurally bound to one exact patch.

### Security tradeoffs

- A review requires push access even when the requested outcome is read-only.
- The execution environment receives authenticated Git and GitHub capabilities.
- The agent has broad shell, read, write, and reply tools.
- The workflow may stage all changes, bypass hooks, commit, and push.
- Dependency installation occurs inside the execution flow without GHAGGA-style
  policy and evidence gates.
- **Inferred:** prompt injection from repository content or PR conversation can
  target the write-capable credentials placed inside the sandbox. The sandbox
  isolates the host infrastructure, but it does not isolate those deliberately
  supplied forge capabilities.

## Comparison

| Dimension | Stronger baseline | Decision |
|---|---|---|
| PR-native conversation | OpenReview | Adopt the interaction pattern. |
| Visible staged progress | OpenReview | Adopt with GHAGGA pipeline states. |
| Full-repository dynamic execution | OpenReview | Add through an optional executor SPI. |
| Deterministic/reproducible review | GHAGGA | Preserve. |
| Structured findings and coverage | GHAGGA | Preserve and extend. |
| Persistent cross-review memory | GHAGGA | Preserve; connect feedback to it. |
| Code graph and impact context | GHAGGA | Preserve. |
| Multi-agent and multi-mode review | GHAGGA | Preserve. |
| Provider neutrality and fallback | GHAGGA | Make mandatory for new runtime work. |
| Forge and deployment portability | GHAGGA | Preserve and strengthen. |
| Read-only security boundary | GHAGGA | Preserve; do not copy OpenReview's gate. |
| Immediate fix UX | OpenReview | Rebuild around immutable approval artifacts. |
| Tests, CI, and operational maturity | GHAGGA | Preserve GHAGGA's evidence standard. |

The useful distinction is architectural: OpenReview is a strong reference for
an agentic interface and execution runtime, while GHAGGA is the stronger review
engine and policy foundation.

## Approved adoption candidates

### 1. Stateful PR-native intents

Introduce a typed `ReviewIntent` above the existing command surface. Initial
intents should be deliberately narrow:

- `review`: run the normal evidence-producing review.
- `explain`: answer a question about the affected code without creating
  findings or modifying files.
- `test`: propose or execute approved verification in a read-only sandbox.
- `propose-fix`: generate an immutable patch artifact without applying it.

Conversation state should combine a bounded recent PR transcript, a summary of
older turns, and GHAGGA's existing project memory. A reply must retain the
target repository, PR, and commit identity.

### 2. Progressive, metadata-first skills

Only skill name, description, version, origin, and integrity metadata should be
available during selection. Full instructions are loaded only when required.

Repository-provided skills are untrusted inputs. They must be opt-in, pinned by
content hash, constrained by policy, and clearly distinguished from
operator-installed trusted skills. Loading a skill never grants tools or
credentials by itself.

### 3. Provider-neutral `SandboxExecutor`

Define GHAGGA-owned contracts for:

- immutable source materialization;
- command forecasting and authorization;
- execution limits, timeouts, and cancellation;
- filesystem changes and artifact collection;
- network/egress policy;
- logs, exit status, and validation evidence;
- cleanup and resumability.

Candidate adapters may include GitHub Action, local process, Docker, and Vercel
Sandbox. Vercel is an optional adapter, never a core dependency. The contract
must also remain usable by other agents, CLIs, IDEs, and future executors.

### 4. Separate review and mutation sandboxes

The review sandbox is the default. It has immutable inputs, no forge write
credential, no unrestricted egress, and no authority to alter the source
branch.

The mutation sandbox exists only after an authorized human approves one exact
artifact. It receives the minimum time-bound capability needed to apply and
validate that artifact. Review execution must never silently upgrade itself to
mutation authority.

### 5. Immutable suggestions and reaction binding

Every actionable suggestion should include at least:

```text
finding_id
target_commit_sha
path
range
patch_digest
patch_content or immutable artifact reference
validation_evidence
producer and policy version
expiration or stale-state rule
```

A reaction or button applies exactly this artifact. If the branch no longer
matches `target_commit_sha`, GHAGGA rejects it as stale rather than rerunning an
agent and hoping it reconstructs the same intent.

### 6. Stage-aware progress UX

Project GHAGGA's real pipeline states into the PR:

```text
queued → gathering context → static analysis → AI review
       → validating → awaiting approval | complete | partial | failed
```

Updates should be idempotent and should expose skips, degraded coverage, and
timeouts rather than presenting activity as success.

### 7. Feedback-to-memory

Positive and negative reactions to findings should become structured feedback
for repository-level calibration. Store finding identity, rule/lens, outcome,
target revision, reviewer authority, and reason where available.

Feedback may improve ranking, suppression, and prompt selection, but it must not
silently rewrite security policy or turn one reaction into global truth.

## Security invariants

These are acceptance requirements, not implementation suggestions:

1. Read-only is the default for every intent.
2. The invoker's repository association and requested capability are checked.
3. No forge write token is visible to the model or read-only tool process.
4. Network egress is denied or allowlisted and observable.
5. Mutation requires explicit consent for one immutable artifact and target.
6. Approval is rejected when the target commit or patch digest is stale.
7. Never use broad `git add -A` staging for generated changes.
8. Never bypass repository hooks with `--no-verify` as a product workflow.
9. Never run implicit dependency-install scripts from untrusted code.
10. Forecast installs and commands; require policy or human authorization.
11. Skills, comments, source code, test output, and tool output are untrusted
    prompt inputs.
12. Credentials, secrets, and sensitive environment values are redacted from
    prompts, logs, memory, and artifacts.
13. Every mutation and external side effect has an auditable actor, scope,
    target, and result.

## GHAGGA integration seams

The design should extend existing ports instead of bypassing the core:

- `ReviewInput.memoryStorage`
- `ReviewInput.graphLoader`
- `ReviewInput.codeIntelProvider`
- `ReviewInput.embeddingProvider`
- `ReviewInput.precomputedStaticAnalysis`
- `packages/core/src/pipeline/execute.ts`
- `packages/core/src/agents/fan-out-lenses.ts`
- `packages/forge/src/ports/forge-adapter.ts`
- `ReviewResult`, formatters, and SARIF output
- `apps/server/src/queues/*`
- `apps/dashboard/src/pages/Reviews.tsx`
- `apps/dashboard/src/pages/IssueTriage.tsx`

New conversational and sandbox capabilities should enter through typed ports,
then be projected consistently to CLI, Action, server, and dashboard surfaces.

## Phased roadmap

### Phase 0 — Reconcile the implementation baseline

- Preserve the existing uncommitted Action bundle.
- Reconcile the active branch with `origin/main`.
- Reconfirm integration seams and refresh stale documentation.
- Capture baseline review quality, latency, and cost before behavior changes.

### Phase 1 — Conversational UX and progress

- Add typed read-only `review` and `explain` intents.
- Bind conversation to repository, PR, and commit identities.
- Project real pipeline stages into idempotent status updates.
- Preserve current review behavior as the control path.

### Phase 2 — Typed suggestions and feedback memory

- Define the immutable suggestion schema.
- Emit suggestions without mutation authority.
- Reject stale reactions deterministically.
- Store authorized feedback as calibrated memory evidence.

### Phase 3 — Progressive skills

- Define skill metadata, provenance, trust, and integrity contracts.
- Load bodies on demand without granting capabilities.
- Add opt-in repository skills with hash pinning and policy fences.

### Phase 4 — Optional sandbox execution

- Define the provider-neutral `SandboxExecutor` SPI.
- Implement at least two adapters before declaring the abstraction portable.
- Start with read-only verification and bounded tooling.
- Add durable status, cancellation, timeout, cleanup, and evidence collection.

### Phase 5 — Guarded mutation

- Add a distinct mutation capability and explicit approval flow.
- Apply only immutable, target-bound artifacts.
- Validate the resulting tree before any forge write.
- Keep commit, push, and PR delivery separate from model discretion.

Each phase should be independently releasable and reversible. Advancing to the
next phase requires its evaluation gates to pass against the prior baseline.

## Acceptance and evaluation gates

### Security

- A read-only run exposes zero write credentials to model-visible processes.
- Unauthorized invokers and unsupported mutation intents are rejected.
- Prompt-injection canaries cannot access credentials or unrestricted egress.
- Skill and repository content cannot escalate their declared capabilities.

### Correctness

- Suggestion approval verifies exact `target_commit_sha` and `patch_digest`.
- Stale or ambiguous artifacts fail closed.
- Findings, inline ranges, and applied patches retain traceable identities.
- `coverageComplete` and failed-step semantics remain truthful.

### Reliability

- Workflow steps are idempotent or have explicit deduplication keys.
- Interrupted runs can resume without duplicate comments or mutations.
- Timeouts, cancellation, and sandbox cleanup are tested.
- Partial evidence produces a partial/needs-review state, never a false pass.

### Quality, cost, and latency

- Use `md-evals` and a versioned benchmark corpus to compare the new path with
  the current GHAGGA baseline.
- Measure confirmed finding recall, false-positive rate, unsupported claims,
  end-to-end latency, tool failures, tokens, and monetary cost.
- Run paired evaluations on the same commits; do not infer improvement from UX
  preference or repository popularity.
- Retain the old path until the new path passes preregistered thresholds.

### Portability

- The core depends only on GHAGGA-owned executor and forge contracts.
- At least two executor adapters pass the same conformance suite.
- No intent, artifact, or policy schema contains a required Claude, Vercel, or
  GitHub-specific field.
- A provider or executor can be removed without losing review history or
  immutable suggestion records.

## Explicitly rejected patterns

GHAGGA must not adopt:

- model-visible forge write credentials;
- automatic commit or push based only on model behavior;
- `git add -A`, disabled hooks, or `git commit --no-verify` as remediation
  shortcuts;
- mandatory write permission for read-only review;
- implicit installation of dependencies or lifecycle scripts from untrusted
  repositories;
- a hard dependency on Claude, Vercel, GitHub, or any single agent runtime;
- reaction handling that reruns an unconstrained agent instead of applying one
  immutable approved artifact;
- prompt-only findings or patches where typed contracts can enforce identity
  and safety.

## License and reuse warning

At the analyzed commit, OpenReview's README says MIT, but the repository does
not contain a `LICENSE` file and GitHub does not expose a detected license.
Issue #15 tracks the ambiguity. Treat the ideas as architectural research only;
do not copy source code until the copyright holder publishes clear license
terms.

## Local checkout caveat

The inspected GHAGGA checkout is not a clean implementation baseline:

- branch: `chore/dependabot-lockstep-families`;
- HEAD: `3d587af`;
- divergence: one commit ahead and six behind `origin/main`;
- pre-existing modified bundle: `apps/action/dist/index.js`;
- pre-existing untracked WASM artifact:
  `apps/action/dist/66b6fc4a81c30e732e66.wasm`.

Before implementation, reconcile the branch with `origin/main` while preserving
those local artifacts. Do not attribute the existing bundle changes to work
derived from this decision document.

## Sources

### GHAGGA

- Repository: https://github.com/JNZader/ghagga
- Main history: https://github.com/JNZader/ghagga/commits/main/

### OpenReview, pinned baseline

- Repository: https://github.com/vercel-labs/openreview
- Baseline commit: https://github.com/vercel-labs/openreview/commit/672deb21e70e471e0536d5ad7a67c14b8359e97e
- Workflow: https://github.com/vercel-labs/openreview/blob/672deb21e70e471e0536d5ad7a67c14b8359e97e/workflow/index.ts
- Agent and tools: https://github.com/vercel-labs/openreview/blob/672deb21e70e471e0536d5ad7a67c14b8359e97e/lib/agent.ts
- Bot and reaction handling: https://github.com/vercel-labs/openreview/blob/672deb21e70e471e0536d5ad7a67c14b8359e97e/lib/bot.ts
- Skill discovery: https://github.com/vercel-labs/openreview/blob/672deb21e70e471e0536d5ad7a67c14b8359e97e/lib/skills.ts
- Git configuration: https://github.com/vercel-labs/openreview/blob/672deb21e70e471e0536d5ad7a67c14b8359e97e/workflow/steps/configure-git.ts
- GitLab request: https://github.com/vercel-labs/openreview/issues/1
- Provider selection request: https://github.com/vercel-labs/openreview/issues/5
- License ambiguity: https://github.com/vercel-labs/openreview/issues/15

## Deferred implementation decision

When implementation is requested, start from Phase 0 and create a scoped plan
for only the next independently releasable phase. Revalidate OpenReview's
current state and license first; do not treat this pinned comparison as a
forever-current dependency assessment.
