# PR Progress Publication Specification

## Purpose

Publish truthful explanation progress and answers through namespaces independent from existing review comments and markers.

## Requirements

### Requirement: Monotonic truthful progress

The system MUST expose progress states that advance monotonically to a terminal state, and MUST represent rejection, stale identity, AI unavailability, ambiguity, and success explicitly.

#### Scenario: Normal progress
- GIVEN an accepted explanation invocation
- WHEN its lifecycle advances
- THEN each published state reflects completed work
- AND states never regress or claim model work before it occurred

#### Scenario: Terminal non-answer
- GIVEN execution is stale, unauthorized, unavailable, or ambiguous
- WHEN progress is finalized
- THEN the invocation records an explicit truthful terminal non-answer outcome
- AND that outcome is publicly projected only when identity, opt-in, and current-target guards permit
- AND otherwise no public output is created
- AND no success answer is shown

### Requirement: Separate publication namespaces

Explanation progress and results MUST use markers and records distinct from review publications, and MUST NOT overwrite prior review output.

#### Scenario: Existing review preserved
- GIVEN a PR already has a review comment and review markers
- WHEN explanation progress and an answer are published
- THEN the prior review content remains byte-for-byte unaffected
- AND explanation content is identifiable as a separate publication

#### Scenario: Finding and memory isolation
- GIVEN an explanation has completed
- WHEN all publications are applied
- THEN no finding, verdict, coverage, or review-memory marker is emitted

### Requirement: Idempotent publication and stale checks

Publication MUST upsert by stable invocation identity, tolerate repeated delivery, and revalidate target identity immediately before publishing.

#### Scenario: Publication retry
- GIVEN the same progress or result publication is retried
- WHEN the retry executes
- THEN one equivalent explanation publication remains
- AND duplicate comments or markers are not created

#### Scenario: Stale publication
- GIVEN the PR head changed since the invocation was acquired
- WHEN a progress or answer publication is attempted
- THEN publication is rejected as stale
- AND no new progress or answer publication is created after supersession is detected
- AND previously valid visible progress is not retrospectively guaranteed absent

#### Scenario: Ambiguous comment publication
- GIVEN a comment create request was durably marked `create-started` but its response is unknown
- WHEN publication retries
- THEN the system suppresses recreation and may reconcile only an explanation marker owned by this invocation
- AND a negative search alone is not proof that the original request will not arrive

### Requirement: Opt-out and distribution compatibility

The GitHub App explanation route MUST be disabled by an explicit opt-out, while CLI, Action, GitLab, 1-click, and existing review behavior remain unchanged.

#### Scenario: Opt-out
- GIVEN explanation is disabled for the installation or repository
- WHEN an explanation command arrives
- THEN it receives an explicit disabled non-answer
- AND no explanation worker, model dispatch, or marker is created

#### Scenario: Other distributions
- GIVEN a CLI, Action, GitLab, or 1-click review is run with explanation disabled
- WHEN the existing review path executes
- THEN its behavior and authorization remain unchanged
