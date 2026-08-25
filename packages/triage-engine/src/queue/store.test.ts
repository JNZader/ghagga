/**
 * Queue store tests — local JSON persistence + default path resolution.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IssueDraft } from '../types/draft.js';
import { defaultQueuePath, loadQueue, repoSlug, saveQueue } from './store.js';

function makeDraft(overrides: Partial<IssueDraft> = {}): IssueDraft {
  return {
    id: 'acme/widgets#42',
    issueIid: '42',
    repo: 'acme/widgets',
    status: 'PENDING_APPROVAL',
    report: 'internal analysis',
    clientReply: 'client-facing reply',
    reproductionEvidence: null,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('repoSlug', () => {
  it('turns owner/name into a filesystem-safe slug', () => {
    expect(repoSlug('acme/widgets')).toBe('acme-widgets');
  });

  it('strips characters unsafe for a directory name', () => {
    expect(repoSlug('acme/widgets:staging')).toBe('acme-widgets-staging');
  });
});

describe('defaultQueuePath', () => {
  it('resolves to <baseDir>/<repoSlug>/queue.json', () => {
    const path = defaultQueuePath('acme/widgets', { baseDir: '/tmp/ghagga-triage-test' });
    expect(path).toBe(join('/tmp/ghagga-triage-test', 'acme-widgets', 'queue.json'));
  });

  it('defaults baseDir under the user home directory when not provided', () => {
    const path = defaultQueuePath('acme/widgets');
    expect(path).toContain(join('.ghagga-triage', 'acme-widgets', 'queue.json'));
  });
});

describe('loadQueue / saveQueue', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ghagga-triage-store-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loadQueue returns an empty object when the file does not exist', () => {
    const queuePath = join(dir, 'nested', 'queue.json');
    expect(loadQueue(queuePath)).toEqual({});
  });

  it('saveQueue creates parent directories and persists JSON; loadQueue reads it back', () => {
    const queuePath = join(dir, 'nested', 'queue.json');
    const draft = makeDraft();

    saveQueue(queuePath, { [draft.issueIid as string]: draft });
    const reloaded = loadQueue(queuePath);

    expect(reloaded).toEqual({ '42': draft });
  });

  it('loadQueue throws loudly for a corrupt-but-present file rather than silently dropping the queue', () => {
    const queuePath = join(dir, 'queue.json');
    writeFileSync(queuePath, '{not valid json', 'utf-8');

    // Returning {} here would erase every draft (incl. POSTED state) on a transient corruption.
    expect(() => loadQueue(queuePath)).toThrow(/corrupt triage queue/);
  });

  it('saveQueue writes atomically and leaves no .tmp file behind', () => {
    const queuePath = join(dir, 'nested', 'queue.json');
    const draft = makeDraft();

    saveQueue(queuePath, { [draft.issueIid as string]: draft });

    expect(existsSync(`${queuePath}.tmp`)).toBe(false);
    expect(loadQueue(queuePath)).toEqual({ '42': draft });
  });

  it('saveQueue over an existing queue replaces it without corrupting it', () => {
    const queuePath = join(dir, 'queue.json');
    const first = makeDraft({ issueIid: '1', id: 'acme/widgets#1' });
    const second = makeDraft({ issueIid: '2', id: 'acme/widgets#2' });

    saveQueue(queuePath, { '1': first });
    saveQueue(queuePath, { '1': first, '2': second });

    expect(loadQueue(queuePath)).toEqual({ '1': first, '2': second });
  });
});
