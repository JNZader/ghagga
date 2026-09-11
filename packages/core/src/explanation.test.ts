import { describe, expect, it } from 'vitest';
import {
  EXPLANATION_OUTCOME,
  type ExplanationIdentity,
  type ExplanationOutcome,
  type ExplanationRequest,
  type ExplanationSnapshot,
} from './explanation.js';
import type { ExplanationGenerateTextFn } from './providers/explanation-generate-fn.js';

const identity: ExplanationIdentity = {
  forgeInstance: 'github.com',
  installationId: 'installation-42',
  actorId: 'actor-7',
  repositoryId: 'repository-99',
  pullRequestNumber: 12,
  requestedHeadSha: 'head-a',
  sourceCommentId: 'comment-55',
  questionHash: 'sha256:question-a',
};

const request: ExplanationRequest = {
  identity,
  question: 'Why was this function changed?',
};

const snapshot: ExplanationSnapshot = {
  repositoryId: 'repository-99',
  baseSha: 'base-a',
  headSha: 'head-a',
  diff: 'diff --git a/source.ts b/source.ts',
  files: [
    {
      path: 'source.ts',
      content: 'export const answer = 42;',
    },
  ],
};

describe('explanation contracts', () => {
  it('models an identity-bound, forge-neutral request and pinned snapshot as data', () => {
    expect(request.identity).toMatchObject({
      forgeInstance: 'github.com',
      installationId: 'installation-42',
      actorId: 'actor-7',
      repositoryId: 'repository-99',
      pullRequestNumber: 12,
      requestedHeadSha: 'head-a',
      sourceCommentId: 'comment-55',
      questionHash: 'sha256:question-a',
    });
    expect(snapshot).toMatchObject({
      repositoryId: 'repository-99',
      baseSha: 'base-a',
      headSha: 'head-a',
      diff: 'diff --git a/source.ts b/source.ts',
    });
    expect(snapshot.files).toEqual([{ path: 'source.ts', content: 'export const answer = 42;' }]);
  });

  it('represents source-comment commands as inert question data', () => {
    const commandLikeQuestion = '--head other; ENV=production command --with-flags';
    const commandRequest: ExplanationRequest = {
      identity: { ...identity, questionHash: 'sha256:command-question' },
      question: commandLikeQuestion,
    };

    expect(commandRequest.question).toBe(commandLikeQuestion);
    expect(commandRequest.question).toContain('--head other');
    expect(commandRequest.question).toContain('ENV=production');
  });

  it('discriminates answers from explicit stale and unavailable non-answers without review fields', () => {
    const answered: ExplanationOutcome = {
      kind: EXPLANATION_OUTCOME.ANSWERED,
      answer: 'The function now validates the input before persisting it.',
      metadata: {
        provider: 'fixture-provider',
        model: 'fixture-model',
        tokensUsed: 7,
      },
    };
    const stale: ExplanationOutcome = {
      kind: EXPLANATION_OUTCOME.STALE,
      reason: 'The requested head no longer matches the pinned snapshot.',
    };
    const unavailable: ExplanationOutcome = {
      kind: EXPLANATION_OUTCOME.AI_UNAVAILABLE,
      reason: 'No configured provider can answer the request.',
    };

    expect(answered.kind).toBe('ANSWERED');
    expect('answer' in stale).toBe(false);
    expect('answer' in unavailable).toBe(false);
    expect(Object.hasOwn(answered, 'findings')).toBe(false);
    expect(Object.hasOwn(answered, 'reviewStatus')).toBe(false);
  });
});

function typeContractFixtures(): void {
  const validOutcome = {
    kind: EXPLANATION_OUTCOME.INVALID,
    reason: 'Question is empty.',
  } as const;
  const accepted: ExplanationOutcome = validOutcome;

  const reviewContaminatedOutcome = {
    kind: EXPLANATION_OUTCOME.ANSWERED,
    answer: 'This must stay an explanation.',
    metadata: { provider: 'fixture-provider', model: 'fixture-model', tokensUsed: 1 },
    findings: [],
    verdict: 'PASSED',
    coverage: 100,
    reviewStatus: 'completed',
  } as const;

  // @ts-expect-error Explanation outcomes reject review fields from non-fresh variables.
  const rejected: ExplanationOutcome = reviewContaminatedOutcome;

  const generate: ExplanationGenerateTextFn = async () => ({
    text: accepted.kind,
    tokensUsed: 0,
    provider: 'fixture-provider',
    model: 'fixture-model',
  });

  void rejected;
  void generate;
}

void typeContractFixtures;
