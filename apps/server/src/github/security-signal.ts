/**
 * Publish the ghagga/security check run and a code-scanning SARIF upload
 * from the GitHub App. Neither call fails the review: the caller catches
 * check-run errors, and a SARIF rejection is logged here.
 *
 * A check run that already exists for this commit is updated in place, so
 * a failure stays until a later review no longer contains the finding.
 */

import { gzipSync } from 'node:zlib';
import {
  buildSarif,
  decideSecurityCheck,
  type ReviewFinding,
  type ReviewResult,
  shouldUpdateSecurityCheck,
} from 'ghagga-core';

export const SECURITY_CHECK_NAME = 'ghagga/security';

export interface SecuritySignalClient {
  listCheckRunsByName(
    owner: string,
    repo: string,
    sha: string,
    name: string,
    token: string,
  ): Promise<Array<{ id: number }>>;
  createCheckRun(
    owner: string,
    repo: string,
    body: {
      name: string;
      headSha: string;
      conclusion: 'success' | 'failure';
      title: string;
      summary: string;
    },
    token: string,
  ): Promise<{ id: number }>;
  updateCheckRun(
    owner: string,
    repo: string,
    checkRunId: number,
    body: { conclusion: 'success' | 'failure'; title: string; summary: string },
    token: string,
  ): Promise<void>;
  uploadSarif?(
    owner: string,
    repo: string,
    payload: { commitSha: string; ref: string; sarif: string },
    token: string,
  ): Promise<void>;
}

export interface PublishSecuritySignalInput {
  client: SecuritySignalClient;
  owner: string;
  repo: string;
  token: string;
  headSha: string | undefined;
  prNumber: number;
  status: string;
  findings: readonly ReviewFinding[];
  threshold: unknown;
  /** Called when SARIF upload fails. The check run is unaffected. */
  onSarifError?: (error: unknown) => void;
}

const SHA = /^[0-9a-f]{7,40}$/i;

export async function publishSecuritySignal(input: PublishSecuritySignalInput): Promise<void> {
  if (!shouldUpdateSecurityCheck(input.status)) return;
  if (!input.headSha || !SHA.test(input.headSha)) return;

  const decision = decideSecurityCheck(input.findings, input.threshold);
  const existing = await input.client.listCheckRunsByName(
    input.owner,
    input.repo,
    input.headSha,
    SECURITY_CHECK_NAME,
    input.token,
  );
  const latest = existing.at(-1);
  const output = {
    conclusion: decision.conclusion,
    title: decision.title,
    summary: decision.summary,
  };
  if (latest) {
    await input.client.updateCheckRun(input.owner, input.repo, latest.id, output, input.token);
  } else {
    await input.client.createCheckRun(
      input.owner,
      input.repo,
      { name: SECURITY_CHECK_NAME, headSha: input.headSha, ...output },
      input.token,
    );
  }

  if (typeof input.client.uploadSarif !== 'function') return;
  try {
    const published = input.findings.filter((finding) => finding.ledgerStatus !== 'refuted');
    const skipped = { status: 'skipped' as const, findings: [], executionTimeMs: 0 };
    const sarifResult: ReviewResult = {
      status: decision.conclusion === 'failure' ? 'FAILED' : 'PASSED',
      summary: decision.summary,
      findings: [...published],
      staticAnalysis: { semgrep: skipped, trivy: skipped, cpd: skipped },
      memoryContext: null,
      metadata: {
        mode: 'simple',
        provider: 'none',
        model: 'ghagga',
        tokensUsed: 0,
        executionTimeMs: 0,
        toolsRun: [],
        toolsSkipped: [],
      },
    };
    const encoded = gzipSync(
      Buffer.from(JSON.stringify(buildSarif(sarifResult, '3.2.4'))),
    ).toString('base64');
    await input.client.uploadSarif(
      input.owner,
      input.repo,
      { commitSha: input.headSha, ref: `refs/pull/${input.prNumber}/head`, sarif: encoded },
      input.token,
    );
  } catch (error) {
    input.onSarifError?.(error);
  }
}
