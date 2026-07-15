/**
 * Web review UI tests — native http server, tested end-to-end against a
 * real ephemeral port (no external HTTP-testing dependency).
 *
 * SECURITY: /approve is the ONLY route that posts; /save and /reject never
 * post. Approve is exercised for the exactly-once + only-on-approve
 * guarantee already covered at the engine/queue layers — here we assert the
 * HTTP wiring itself preserves that guarantee.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GenerateTextFn } from 'ghagga-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriageConfig } from '../config/schema.js';
import type { EngineOptions } from '../engine.js';
import type { ForgeAdapter, ForgeIssue } from '../forge/port.js';
import { buildDraft, upsertDraft } from '../queue/draft.js';
import { loadQueue, saveQueue } from '../queue/store.js';
import { createTriageRequestHandler, startTriageServer } from './serve.js';

function makeConfig(): TriageConfig {
  return {
    forge: 'gitlab',
    repo: 'acme/widgets',
    codeRoot: '/tmp/does-not-exist-ghagga-triage-web',
    language: 'go',
    graphExpand: false,
    models: { rerank: 'x', analysis: 'y' },
    clientReplyPolicy: { language: 'es' },
  };
}

function makeGenerateFn(): GenerateTextFn {
  return vi.fn(async () => ({ text: '', tokensUsed: 0, provider: 'cli-bridge', model: 'x' }));
}

/** Waits for a server started via `startTriageServer` to finish binding and returns its port. */
async function listen(server: http.Server): Promise<number> {
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once('listening', resolve));
  }
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('failed to bind ephemeral port');
  }
  return address.port;
}

describe('web review UI', () => {
  let dir: string;
  let queuePath: string;
  let forge: ForgeAdapter & { postComment: ReturnType<typeof vi.fn> };
  let options: EngineOptions;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ghagga-triage-web-'));
    queuePath = join(dir, 'queue.json');
    forge = {
      listIssues: vi.fn(async () => [] as ForgeIssue[]),
      getIssue: vi.fn(async (iid: string) => ({
        iid,
        title: `Issue ${iid}`,
        description: 'body',
        labels: [],
        url: 'https://example.test',
        comments: [],
      })),
      postComment: vi.fn(async () => undefined),
    };
    options = {
      config: makeConfig(),
      forge,
      rerankGenerateFn: makeGenerateFn(),
      analysisGenerateFn: makeGenerateFn(),
      queuePath,
    };

    const draft = buildDraft({
      iid: '42',
      repo: 'acme/widgets',
      report: 'internal analysis: db constraint chk_alert_range',
      clientReply: 'Estamos revisando tu consulta.',
    });
    saveQueue(queuePath, upsertDraft({}, draft));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET / renders the queue with the client reply visible and the report inside a collapsible block', async () => {
    const server = startTriageServer(options, 0);
    const port = await listen(server);
    try {
      const res = await fetch(`http://localhost:${port}/`);
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(html).toContain('#42');
      expect(html).toContain('Estamos revisando tu consulta.');
      expect(html).toContain('chk_alert_range'); // present but inside a <details> (collapsible)
      expect(html).toContain('<details');
    } finally {
      server.close();
    }
  });

  it('POST /approve posts exactly once via forge and only the client reply', async () => {
    const server = startTriageServer(options, 0);
    const port = await listen(server);
    try {
      const res = await fetch(`http://localhost:${port}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ iid: '42' }).toString(),
        redirect: 'manual',
      });

      expect(res.status).toBe(303);
      expect(forge.postComment).toHaveBeenCalledTimes(1);
      const [, posted] = forge.postComment.mock.calls[0] as [string, string];
      expect(posted).toBe('Estamos revisando tu consulta.');
      expect(posted).not.toContain('chk_alert_range');
      expect(loadQueue(queuePath)['42']?.status).toBe('POSTED');
    } finally {
      server.close();
    }
  });

  it('POST /approve with an edited reply posts the edited text', async () => {
    const server = startTriageServer(options, 0);
    const port = await listen(server);
    try {
      await fetch(`http://localhost:${port}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ iid: '42', reply: 'edited by human reviewer' }).toString(),
        redirect: 'manual',
      });

      expect(forge.postComment).toHaveBeenCalledWith('42', 'edited by human reviewer');
    } finally {
      server.close();
    }
  });

  it('POST /reject never posts and marks the draft REJECTED', async () => {
    const server = startTriageServer(options, 0);
    const port = await listen(server);
    try {
      const res = await fetch(`http://localhost:${port}/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ iid: '42' }).toString(),
        redirect: 'manual',
      });

      expect(res.status).toBe(303);
      expect(forge.postComment).not.toHaveBeenCalled();
      expect(loadQueue(queuePath)['42']?.status).toBe('REJECTED');
    } finally {
      server.close();
    }
  });

  it('POST /save edits the client reply without posting', async () => {
    const server = startTriageServer(options, 0);
    const port = await listen(server);
    try {
      await fetch(`http://localhost:${port}/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ iid: '42', reply: 'saved draft text' }).toString(),
        redirect: 'manual',
      });

      expect(forge.postComment).not.toHaveBeenCalled();
      const persisted = loadQueue(queuePath)['42'];
      expect(persisted?.clientReply).toBe('saved draft text');
      expect(persisted?.status).toBe('PENDING_APPROVAL');
    } finally {
      server.close();
    }
  });

  it('createTriageRequestHandler returns 404 for unknown routes', async () => {
    const server = startTriageServer(options, 0);
    const port = await listen(server);
    try {
      const res = await fetch(`http://localhost:${port}/nope`);
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('createTriageRequestHandler', () => {
  it('is exported and usable independently of startTriageServer', () => {
    const handler = createTriageRequestHandler({
      config: makeConfig(),
      forge: {
        listIssues: vi.fn(async () => []),
        getIssue: vi.fn(),
        postComment: vi.fn(),
      },
      rerankGenerateFn: makeGenerateFn(),
      analysisGenerateFn: makeGenerateFn(),
      queuePath: '/tmp/does-not-matter/queue.json',
    });
    expect(typeof handler).toBe('function');
  });
});
