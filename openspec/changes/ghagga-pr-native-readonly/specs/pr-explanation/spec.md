# PR Explanation Specification

## Purpose

Provide an explicit, read-only answer to an eligible user's question about one pull-request revision without creating review findings or conversational transcript state.

## Requirements

### Requirement: Explicit question and neutral result

The system MUST accept only `/ghagga explain <question>` with a non-empty question, treat question text as untrusted data, and return a finding-free explanation or an explicit non-answer outcome.

#### Scenario: Valid question
- GIVEN an eligible actor supplies `/ghagga explain Why was this function changed?`
- WHEN the command is processed
- THEN exactly one explanation invocation is created for the requested revision
- AND the result contains an answer with no findings, verdict, or review score
- AND no conversational transcript is persisted

#### Scenario: Missing question
- GIVEN an actor supplies `/ghagga explain` with no non-whitespace text
- WHEN parsing occurs
- THEN the request is rejected as invalid
- AND no model dispatch, review, or transcript is created

#### Scenario: Prompt-like question is data
- GIVEN the question contains instructions to ignore policy or emit findings
- WHEN the explanation is generated
- THEN those instructions are treated only as question data
- AND the output remains an explanation or explicit non-answer

### Requirement: Eligibility and immutable identity

The system MUST authorize only `OWNER`, `MEMBER`, or `COLLABORATOR` actors and MUST bind forge instance/installation, stable actor identity, repository, PR number, and requested head SHA before execution.

#### Scenario: Unsupported or revoked actor
- GIVEN an actor is neither an allowed role nor currently authorized at execution
- WHEN authorization is checked
- THEN the request returns an explicit authorization non-answer
- AND no model dispatch occurs

#### Scenario: Missing identity
- GIVEN any required principal or target identity field is absent or unstable
- WHEN an explanation is requested
- THEN it is rejected as unprocessable
- AND no invocation or public output is created

### Requirement: Stale revision rejection

The system MUST reject a request when the requested SHA is superseded at acquisition, execution, or publication; it MUST NOT publish an answer for another revision.

#### Scenario: SHA changes at acquisition
- GIVEN a command references a SHA that is no longer the current PR head
- WHEN acquisition validates the request
- THEN the request is rejected as stale before model dispatch
- AND no explanation publication is created

#### Scenario: SHA changes before execution
- GIVEN a request was acquired for SHA A and the PR now points to SHA B
- WHEN execution begins
- THEN the invocation terminates as stale with no answer
- AND no review fallback is run

#### Scenario: SHA changes before publication
- GIVEN an answer was produced for SHA A but publication observes SHA B
- WHEN publication is attempted
- THEN a replayable stale PUBLICATION status is recorded separately from the persisted generation outcome
- AND no explanation answer for the old SHA is published or overwrites the generation outcome


### Requirement: AI unavailable semantics and isolation

When AI is disabled, unavailable, or exhausted, the system MUST return an explicit no-answer outcome and MUST NOT fall back to review; explanation processing MUST NOT write review findings or review memory.

#### Scenario: Provider unavailable
- GIVEN an eligible, identity-bound request and no usable AI provider
- WHEN execution occurs
- THEN a terminal `AI_UNAVAILABLE` non-answer is returned
- AND no review is dispatched or persisted
