/**
 * Web review UI — native `node:http` server (no new deps), generalized from
 * the biogas-triage PoC's `cmdServe`/`renderPage` (see biogas-triage.mts).
 *
 * SECURITY: drafts live locally only (queue/store.ts); this server is the
 * private review surface. `/approve` is the ONLY route that posts — it
 * delegates to `engine.ts`'s `approveIssue`, which itself only ever calls
 * `queue/approval.ts`'s `approveAndPost` (the sole caller of
 * `ForgeAdapter.postComment`). `/save` and `/reject` never post.
 *
 * This server binds to localhost by design (no auth layer) — it is meant to
 * run on the reviewer's own machine, matching design.md's "CLI-first, local
 * queue, never auto-posts" posture. Do NOT expose it on a public interface.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import type { EngineOptions } from '../engine.js';
import {
  approveIssue,
  editDraft,
  listQueue,
  rejectIssue,
  triageIssue,
  triageNew,
} from '../engine.js';
import type { IssueDraft } from '../types/draft.js';

const DEFAULT_PORT = 4599;

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });
}

const PAGE_CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{font:15px/1.55 system-ui,sans-serif;max-width:900px;margin:0 auto;padding:24px;background:#14161a;color:#e6e6e6}
h1{font-size:20px;margin:0 0 4px} .sub{color:#8a94a6;margin:0 0 20px;font-size:13px}
.triagebar{display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap}
input,textarea,button{font:inherit;border-radius:8px;border:1px solid #2b2f38;background:#1c1f26;color:#e6e6e6;padding:8px 10px}
button{cursor:pointer;background:#2a2f3a;border-color:#3a4150}
button:hover{background:#333a47} button:disabled{opacity:.4;cursor:not-allowed}
.card{border:1px solid #2b2f38;border-radius:12px;padding:16px;margin-bottom:16px;background:#191c22}
.card.POSTED{opacity:.6} .card.REJECTED{opacity:.45}
.card header{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:8px}
.badge{font-size:12px;padding:2px 8px;border-radius:20px;background:#2a2f3a}
.card.PENDING_APPROVAL .badge{background:#4a3a12;color:#f0c869}
.meta{color:#8a94a6;font-size:12px} a{color:#6ba7ff}
details{margin:8px 0} summary{cursor:pointer;color:#9aa4b6;font-size:13px}
pre{white-space:pre-wrap;background:#111318;border:1px solid #262a32;border-radius:8px;padding:12px;font-size:13px;overflow-x:auto}
label{display:block;font-size:13px;color:#c8b26a;margin:10px 0 4px}
textarea{width:100%;resize:vertical}
.btns{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.approve{background:#1e4620;border-color:#2e6b32} .approve:hover{background:#265a29}
.reject{background:#4a1e1e;border-color:#6b2e2e} .reject:hover{background:#5a2626}
`;

const STATUS_BADGE: Record<IssueDraft['status'], string> = {
  PENDING_APPROVAL: '⏳ pending',
  APPROVED: '✅ approved',
  POSTED: '✅ posted',
  REJECTED: '🚫 rejected',
};

function renderCard(draft: IssueDraft): string {
  const badge = STATUS_BADGE[draft.status];
  const disabled = draft.status !== 'PENDING_APPROVAL' ? 'disabled' : '';
  return `<article class="card ${draft.status}">
      <header><span class="badge">${badge}</span> <strong>#${esc(String(draft.issueIid))}</strong>
        <span class="meta">${esc(draft.repo)}</span></header>
      <details><summary>Technical analysis (internal — NEVER posted to the client)</summary><pre>${esc(draft.report)}</pre></details>
      <form method="POST">
        <input type="hidden" name="iid" value="${esc(String(draft.issueIid))}">
        <label>Client reply (editable — this IS what the client sees):</label>
        <textarea name="reply" rows="5" ${disabled}>${esc(draft.clientReply)}</textarea>
        <div class="btns">
          <button formaction="/save" ${disabled}>Save edit</button>
          <button formaction="/approve" class="approve" ${disabled} onclick="return confirm('Post the client reply for #${esc(String(draft.issueIid))}? The client will see it.')">Approve and post</button>
          <button formaction="/reject" class="reject" ${disabled} onclick="return confirm('Reject #${esc(String(draft.issueIid))}?')">Reject</button>
        </div>
      </form></article>`;
}

/** Renders the full review page for `options`'s persisted queue. */
export function renderQueuePage(options: Pick<EngineOptions, 'config' | 'queuePath'>): string {
  const drafts = Object.values(listQueue(options)).sort((a, b) =>
    String(a.issueIid).localeCompare(String(b.issueIid), undefined, { numeric: true }),
  );
  const cards = drafts.map(renderCard).join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ghagga-triage</title>
<style>${PAGE_CSS}</style></head><body>
<h1>ghagga-triage — approval queue</h1>
<p class="sub">Repo ${esc(options.config.repo)}. Drafts live locally; posting happens ONLY on approve. The technical analysis is NEVER sent to the client.</p>
<form method="POST" action="/triage" class="triagebar">
  <input name="iid" placeholder="issue #" size="10" inputmode="numeric">
  <button>Triage issue</button>
  <button formaction="/triage-new">Triage all new (slow)</button>
</form>
${cards || '<p>Queue is empty. Triage an issue to get started.</p>'}
</body></html>`;
}

/**
 * Builds the request handler used by `startTriageServer`. Exported
 * separately so tests (and alternative hosting, e.g. behind an existing
 * http server) can drive it directly.
 */
export function createTriageRequestHandler(
  options: EngineOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderQueuePage(options));
      return;
    }

    if (req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      const iid = params.get('iid') ?? '';
      const reply = params.get('reply') ?? undefined;

      try {
        if (url.pathname === '/approve' && iid) {
          await approveIssue(options, iid, reply);
        } else if (url.pathname === '/save' && iid) {
          editDraft(options, iid, reply ?? '');
        } else if (url.pathname === '/reject' && iid) {
          rejectIssue(options, iid);
        } else if (url.pathname === '/triage' && iid) {
          await triageIssue(options, iid);
        } else if (url.pathname === '/triage-new') {
          await triageNew(options);
        }
      } catch (error) {
        console.error('ghagga-triage web action error:', (error as Error).message);
      }

      res.writeHead(303, { location: '/' });
      res.end();
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  };
}

/** Starts the local review server on `port` (default 4599). Never binds off localhost. */
export function startTriageServer(options: EngineOptions, port = DEFAULT_PORT): http.Server {
  const handler = createTriageRequestHandler(options);
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use — try another port or free it.`);
    } else {
      console.error('ghagga-triage web server error:', error.message);
    }
  });

  server.listen(port, () => {
    console.log(`ghagga-triage web -> http://localhost:${port}`);
  });

  return server;
}
