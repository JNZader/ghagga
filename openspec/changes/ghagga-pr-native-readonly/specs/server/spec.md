# Server Delta

## ADDED Requirements

### Requirement: Authorized GitHub App explanation routing

The server MUST parse `/ghagga explain <question>` commands from GitHub App events, resolve the installation and stable actor identity, enforce OWNER/MEMBER/COLLABORATOR eligibility, and dispatch only when the explanation opt-in is enabled.

#### Scenario: Eligible opted-in command
- GIVEN a signed GitHub App event from an eligible actor with a non-empty question and enabled opt-in
- WHEN the webhook is handled
- THEN the server acknowledges promptly and dispatches one identity-bound explanation invocation
- AND existing review authorization rules remain unchanged

#### Scenario: Unsupported, revoked, or disabled request
- GIVEN the actor is unsupported/revoked, identity cannot be resolved, or the opt-in is disabled
- WHEN the command is handled
- THEN the server emits an explicit non-answer outcome
- AND no explanation model job is dispatched

### Requirement: Explanation publication isolation

The server MUST publish explanation progress and terminal results using the dedicated publication namespace, with idempotent retry behavior, and MUST NOT overwrite review comments or markers. A terminal non-answer MUST be explicit and MUST be publicly projected only when identity, opt-in, and current-target guards permit; otherwise no public output is allowed.

#### Scenario: Retry-safe publication
- GIVEN an explanation result or progress update is delivered more than once
- WHEN the server retries publication
- THEN one equivalent explanation publication remains
- AND the prior review publication is unchanged

#### Scenario: Stale target at publication
- GIVEN the requested PR head SHA is superseded before publication
- WHEN the worker attempts to publish
- THEN it records a replayable stale publication status separate from any persisted generation outcome
- AND it publishes no answer for the old SHA

### Requirement: Distribution and rollback compatibility

The explanation route MUST be reversible without changing CLI, Action, GitLab, 1-click, or existing review behavior.

#### Scenario: Opt-out rollback
- GIVEN the installation or repository turns explanation opt-in off
- WHEN a new command or queued explanation is observed
- THEN it is explicitly disabled or cancelled without review fallback
- AND normal review processing continues unchanged
