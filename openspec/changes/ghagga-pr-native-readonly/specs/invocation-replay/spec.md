# Invocation Replay Specification

## Purpose

Make explanation delivery durable across webhook, queue, process, and publication retries without promising impossible external exactly-once effects.

## Requirements

### Requirement: Stable invocation claim

The system MUST derive a stable invocation identity from the bound principal, target revision, and command request, and MUST persist one claim before model execution.

#### Scenario: First delivery
- GIVEN a valid identity-bound explanation request with no existing claim
- WHEN the request is accepted
- THEN one durable claim is created in a pending state
- AND at most one model dispatch is permitted for that invocation

#### Scenario: Duplicate delivery
- GIVEN a matching claim already exists
- WHEN a webhook or queue retry arrives
- THEN the existing invocation is returned
- AND an active invocation's current progress is returned
- AND no second model dispatch is started

#### Scenario: Reservation precedes network dispatch
- GIVEN a new valid explanation invocation
- WHEN dispatch is prepared
- THEN its durable reservation is committed before any model network request
- AND a lease timeout is not treated as proof that the prior request stopped

### Requirement: Terminal outcome replay

The system MUST persist one terminal outcome per invocation and replay it for retries, including non-answer outcomes; it MUST NOT automatically resubmit after an ambiguous model result.

#### Scenario: Retry after completed answer
- GIVEN an invocation has a persisted answer outcome
- WHEN the same invocation is delivered again
- THEN the persisted outcome is replayed
- AND no new database result or model call is created

#### Scenario: Crash or ambiguous dispatch
- GIVEN the process crashes or cannot determine whether its model request completed
- WHEN retry processing resumes
- THEN the invocation is marked explicitly ambiguous or requires operator resolution
- AND no automatic model resubmission occurs
- AND the model outcome remains distinct from any later publication status

### Requirement: Claim identity and stale protection

A claim MUST remain bound to its original principal, installation, repository, PR, and head SHA; a retry with any changed identity MUST NOT attach to the prior claim.

#### Scenario: Identity mismatch on retry
- GIVEN a claim for installation I, actor X, repository R, PR 7, and SHA A
- WHEN a retry supplies a different actor, installation, repository, PR, or SHA
- THEN the retry is rejected as mismatched or stale
- AND the original terminal state is unchanged

### Requirement: Durable result isolation

Invocation persistence MUST contain explanation state only and MUST NOT create review findings, verdicts, coverage, or review-memory records.

#### Scenario: Explanation result stored
- GIVEN an explanation completes successfully
- WHEN its claim and result are persisted
- THEN only explanation invocation/result records are written
- AND existing review records remain unchanged
