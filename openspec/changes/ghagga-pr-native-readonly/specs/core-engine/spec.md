# Core Engine Delta

## ADDED Requirements

### Requirement: Neutral read-only explanation contract

The core engine MUST expose provider- and forge-neutral contracts for an identity-bound read-only explanation, pinned snapshot, progress state, and explanation result. The contract MUST NOT require GitHub types or review finalization.

#### Scenario: Neutral caller
- GIVEN a caller supplies a validated principal, target, question, and immutable snapshot
- WHEN the explanation contract executes
- THEN it returns a typed explanation or explicit non-answer
- AND no forge-specific dependency is required

#### Scenario: Snapshot mismatch
- GIVEN the snapshot identity no longer matches the requested target
- WHEN the core contract executes
- THEN it returns a stale non-answer
- AND it does not invoke review finalization

### Requirement: Finding-free execution boundary

Read-only explanation execution MUST NOT emit findings, verdicts, coverage, review status, or review-memory writes, regardless of answer content or provider outcome.

#### Scenario: Successful explanation
- GIVEN a valid pinned snapshot and available provider
- WHEN generation completes
- THEN the result contains only explanation data and metadata
- AND review outputs and memory remain untouched

#### Scenario: Provider unavailable
- GIVEN no provider can answer the explanation
- WHEN execution completes
- THEN the result is an explicit unavailable non-answer
- AND no review fallback is invoked

### Requirement: Existing review compatibility

Adding explanation contracts MUST preserve current review pipeline behavior and MUST allow existing review callers to continue without supplying explanation fields.

#### Scenario: Existing review caller
- GIVEN an existing simple, workflow, consensus, staged, quick, or commit-message review invocation
- WHEN it executes without explanation input
- THEN its prior result shape and review side effects remain unchanged
