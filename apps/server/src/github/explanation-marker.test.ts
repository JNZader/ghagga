import type { ExplanationCommentRef } from 'ghagga-forge';
import { describe, expect, it } from 'vitest';
import {
  assertExplanationCommentReference,
  explanationCommentBody,
  explanationCommentMarker,
} from './explanation-marker.js';

const reference: ExplanationCommentRef = {
  forgeInstance: 'github.com',
  installationId: 'installation-42',
  repositoryId: 'repository-99',
  changeRequest: {
    repo: { kind: 'github', nativeId: 'repository-99', path: 'octo/demo' },
    iid: 7,
    globalId: 'PR_7',
  },
  ownerId: '42',
  channel: 'answer',
  invocationId: 'invocation-1',
};

const goldenMarker =
  '<!-- ghagga-explanation:v1:WyJnaXRodWIuY29tIiwiaW5zdGFsbGF0aW9uLTQyIiwicmVwb3NpdG9yeS05OSIsImdpdGh1YiIsInJlcG9zaXRvcnktOTkiLDcsIlBSXzciLCI0MiIsImFuc3dlciIsImludm9jYXRpb24tMSJd -->';

describe('explanation comment marker', () => {
  it('encodes the canonical ordered reference payload with a stable golden marker', () => {
    expect(explanationCommentMarker(reference)).toBe(goldenMarker);
  });

  it('changes for every identity component and keeps progress separate from answer', () => {
    const variants: readonly ExplanationCommentRef[] = [
      { ...reference, forgeInstance: 'github.example' },
      { ...reference, installationId: 'installation-43' },
      {
        ...reference,
        repositoryId: 'repository-100',
        changeRequest: {
          ...reference.changeRequest,
          repo: { ...reference.changeRequest.repo, nativeId: 'repository-100' },
        },
      },
      { ...reference, changeRequest: { ...reference.changeRequest, iid: 8 } },
      { ...reference, changeRequest: { ...reference.changeRequest, globalId: 'PR_8' } },
      { ...reference, ownerId: '43' },
      { ...reference, channel: 'progress' },
      { ...reference, invocationId: 'invocation-2' },
    ];

    for (const variant of variants) {
      expect(explanationCommentMarker(variant)).not.toBe(goldenMarker);
    }
  });

  it.each(['', 'not-a-number', '0', '-1', '42.5', '9007199254740992', '042', '+42'])(
    'fails closed for invalid canonical owner ID %j',
    (ownerId) => {
      expect(() => explanationCommentMarker({ ...reference, ownerId })).toThrow(
        'Explanation comment reference is not exactly bound',
      );
      expect(() => explanationCommentBody({ ...reference, ownerId }, 'answer')).toThrow(
        'Explanation comment reference is not exactly bound',
      );
    },
  );

  it('fails closed for PR/repository binding mismatches and invalid channels', () => {
    expect(() => assertExplanationCommentReference(8, reference)).toThrow(
      'Explanation comment reference is not exactly bound',
    );
    expect(() =>
      explanationCommentMarker({
        ...reference,
        changeRequest: {
          ...reference.changeRequest,
          repo: { ...reference.changeRequest.repo, nativeId: 'repository-100' },
        },
      }),
    ).toThrow('Explanation comment reference is not exactly bound');
    expect(() =>
      explanationCommentMarker({
        ...reference,
        channel: 'other' as ExplanationCommentRef['channel'],
      }),
    ).toThrow('Explanation comment reference is not exactly bound');
  });

  it.each(['', 'line one\nline two', '  spaced\t', 'respuesta ñ 🦾'])(
    'preserves %j exactly',
    (body) => {
      expect(explanationCommentBody(reference, body)).toBe(`${body}\n\n${goldenMarker}`);
    },
  );

  it('does not share the legacy review marker namespace', () => {
    expect(explanationCommentMarker(reference)).not.toContain('ghagga-review');
  });
});
