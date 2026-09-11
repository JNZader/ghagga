import type { ExplanationCommentRef } from 'ghagga-forge';

const EXPLANATION_COMMENT_MARKER_NAMESPACE = 'ghagga-explanation:v1';

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates the exact identity binding required for explanation comments. */
export function assertExplanationCommentReference(
  prNumber: number,
  reference: ExplanationCommentRef,
): void {
  const candidate = reference as unknown;
  if (!isRecord(candidate)) {
    throw new TypeError('Explanation comment reference is not exactly bound');
  }

  const changeRequest = candidate.changeRequest;
  if (!isRecord(changeRequest)) {
    throw new TypeError('Explanation comment reference is not exactly bound');
  }

  const repository = changeRequest.repo;
  if (!isRecord(repository)) {
    throw new TypeError('Explanation comment reference is not exactly bound');
  }

  const ownerId = Number(candidate.ownerId);
  if (
    !isPositiveSafeInteger(prNumber) ||
    typeof candidate.forgeInstance !== 'string' ||
    candidate.forgeInstance.length === 0 ||
    typeof candidate.installationId !== 'string' ||
    candidate.installationId.length === 0 ||
    typeof candidate.repositoryId !== 'string' ||
    candidate.repositoryId.length === 0 ||
    repository.kind !== 'github' ||
    repository.nativeId !== candidate.repositoryId ||
    changeRequest.iid !== prNumber ||
    candidate.ownerId !== String(ownerId) ||
    !isPositiveSafeInteger(ownerId) ||
    typeof candidate.invocationId !== 'string' ||
    candidate.invocationId.length === 0 ||
    (candidate.channel !== 'progress' && candidate.channel !== 'answer')
  ) {
    throw new TypeError('Explanation comment reference is not exactly bound');
  }
}

function referencePrNumber(reference: ExplanationCommentRef): number {
  const candidate = reference as unknown;
  if (!isRecord(candidate) || !isRecord(candidate.changeRequest)) return Number.NaN;
  return typeof candidate.changeRequest.iid === 'number' ? candidate.changeRequest.iid : Number.NaN;
}

/** Creates a canonical marker only for a valid, exactly bound reference. */
export function explanationCommentMarker(reference: ExplanationCommentRef): string {
  assertExplanationCommentReference(referencePrNumber(reference), reference);
  const encoded = Buffer.from(
    JSON.stringify([
      reference.forgeInstance,
      reference.installationId,
      reference.repositoryId,
      reference.changeRequest.repo.kind,
      reference.changeRequest.repo.nativeId,
      reference.changeRequest.iid,
      reference.changeRequest.globalId ?? null,
      reference.ownerId,
      reference.channel,
      reference.invocationId,
    ]),
  ).toString('base64url');
  return `<!-- ${EXPLANATION_COMMENT_MARKER_NAMESPACE}:${encoded} -->`;
}

/** Appends the canonical marker without changing supplied explanation text. */
export function explanationCommentBody(reference: ExplanationCommentRef, body: string): string {
  return `${body}\n\n${explanationCommentMarker(reference)}`;
}
