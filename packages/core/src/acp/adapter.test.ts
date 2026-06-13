import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACPAdapter, ACPTaskStore, resetTaskCounter } from './adapter.js';
import type { ACPRequest, ACPTask, ACPTaskInput } from './types.js';

// Mock the review pipeline to avoid actual LLM calls
vi.mock('../pipeline.js', () => ({
  reviewPipeline: vi.fn().mockResolvedValue({
    status: 'PASSED',
    summary: 'All good.',
    findings: [
      {
        severity: 'low',
        category: 'style',
        file: 'src/app.ts',
        line: 10,
        message: 'Minor style issue',
        source: 'ai',
      },
    ],
    staticAnalysis: {
      semgrep: { status: 'skipped', findings: [], executionTimeMs: 0 },
      trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
      cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
    },
    memoryContext: null,
    // Present in the mock so the artifact test below can pin that the
    // full-result `review-result` artifact carries it (deliberate contract).
    semanticDiff: {
      changes: [{ kind: 'function_added', name: 'newHelper', filePath: 'src/util.ts' }],
      summary: '1 function added',
    },
    metadata: {
      mode: 'simple',
      provider: 'gateway',
      model: 'test-model',
      tokensUsed: 100,
      executionTimeMs: 500,
      toolsRun: ['semgrep'],
      toolsSkipped: ['trivy'],
    },
  }),
}));

// Mock SARIF builder
vi.mock('../sarif/index.js', () => ({
  buildSarif: vi.fn().mockReturnValue({ $schema: 'sarif', runs: [] }),
}));

// ─── ACPTaskStore ──────────────────────────────────────────────

describe('ACPTaskStore', () => {
  it('stores and retrieves tasks', () => {
    const store = new ACPTaskStore();
    const task: ACPTask = {
      id: 'test-1',
      state: 'submitted',
      description: 'Test',
      input: { diff: 'test diff' },
      artifacts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.set(task);
    expect(store.get('test-1')).toBe(task);
  });

  it('returns undefined for missing tasks', () => {
    const store = new ACPTaskStore();
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('lists all tasks', () => {
    const store = new ACPTaskStore();
    const now = new Date().toISOString();
    store.set({
      id: 'a',
      state: 'submitted',
      description: '',
      input: { diff: '' },
      artifacts: [],
      createdAt: now,
      updatedAt: now,
    });
    store.set({
      id: 'b',
      state: 'working',
      description: '',
      input: { diff: '' },
      artifacts: [],
      createdAt: now,
      updatedAt: now,
    });

    expect(store.list()).toHaveLength(2);
  });

  it('deletes tasks', () => {
    const store = new ACPTaskStore();
    const now = new Date().toISOString();
    store.set({
      id: 'del',
      state: 'submitted',
      description: '',
      input: { diff: '' },
      artifacts: [],
      createdAt: now,
      updatedAt: now,
    });

    expect(store.delete('del')).toBe(true);
    expect(store.get('del')).toBeUndefined();
    expect(store.delete('del')).toBe(false);
  });
});

// ─── ACPAdapter ────────────────────────────────────────────────

describe('ACPAdapter', () => {
  let adapter: ACPAdapter;

  beforeEach(() => {
    resetTaskCounter();
    adapter = new ACPAdapter({
      provider: 'gateway',
      model: 'test-model',
      apiKey: 'test-key',
    });
  });

  describe('getCapabilities', () => {
    it('returns agent capabilities', () => {
      const caps = adapter.getCapabilities();

      expect(caps.name).toBe('ghagga');
      expect(caps.taskTypes).toContain('code-review');
      expect(caps.reviewModes).toContain('simple');
      expect(caps.reviewModes).toContain('workflow');
      expect(caps.supportsStreaming).toBe(true);
      expect(caps.supportsCancellation).toBe(true);
    });
  });

  describe('submitTask', () => {
    it('creates a task in submitted state', () => {
      const input: ACPTaskInput = {
        diff: 'diff --git a/test.ts\n+const x = 1;',
        mode: 'simple',
      };

      const task = adapter.submitTask(input);

      expect(task.id).toMatch(/^ghagga-/);
      expect(task.state).toBe('submitted');
      expect(task.input).toBe(input);
      expect(task.artifacts).toHaveLength(0);
      expect(task.createdAt).toBeDefined();
    });

    it('generates unique task IDs', () => {
      const input: ACPTaskInput = { diff: 'test' };
      const task1 = adapter.submitTask(input);
      const task2 = adapter.submitTask(input);

      expect(task1.id).not.toBe(task2.id);
    });
  });

  describe('executeTask', () => {
    it('transitions task through working to completed', async () => {
      const input: ACPTaskInput = {
        diff: 'diff --git a/test.ts\n+const x = 1;',
      };

      const task = adapter.submitTask(input);
      const states: string[] = [];

      const result = await adapter.executeTask(task.id, (t) => {
        states.push(t.state);
      });

      expect(result.state).toBe('completed');
      expect(states).toContain('working');
      expect(result.output).toBeDefined();
      expect(result.output!.status).toBe('PASSED');
      expect(result.output!.summary).toBe('All good.');
      expect(result.output!.findingCount).toBe(1);
    });

    it('produces review artifacts', async () => {
      const task = adapter.submitTask({ diff: 'test diff' });
      const result = await adapter.executeTask(task.id);

      expect(result.artifacts.length).toBeGreaterThanOrEqual(2);

      const reviewArtifact = result.artifacts.find((a) => a.type === 'review-result');
      expect(reviewArtifact).toBeDefined();
      expect(reviewArtifact!.mimeType).toBe('application/json');

      const findingsArtifact = result.artifacts.find((a) => a.type === 'findings-json');
      expect(findingsArtifact).toBeDefined();

      const sarifArtifact = result.artifacts.find((a) => a.type === 'sarif');
      expect(sarifArtifact).toBeDefined();
      expect(sarifArtifact!.mimeType).toBe('application/sarif+json');
    });

    it('review-result artifact carries semanticDiff — full-result serialization is a DELIBERATE contract', async () => {
      // Pins the decision documented on ReviewResult.semanticDiff (types.ts):
      // not in the DB, not on the HTTP API, but the ACP review-result
      // artifact stringifies the ENTIRE result — semanticDiff included.
      // If this test breaks, the ACP artifact contract changed — not an accident.
      const task = adapter.submitTask({ diff: 'test diff' });
      const result = await adapter.executeTask(task.id);

      const reviewArtifact = result.artifacts.find((a) => a.type === 'review-result');
      expect(reviewArtifact).toBeDefined();
      const parsed = JSON.parse(String(reviewArtifact?.data));
      expect(parsed.semanticDiff).toEqual({
        changes: [{ kind: 'function_added', name: 'newHelper', filePath: 'src/util.ts' }],
        summary: '1 function added',
      });
    });

    it('throws for nonexistent task', async () => {
      await expect(adapter.executeTask('nonexistent')).rejects.toThrow('not found');
    });

    it('throws for non-submitted task', async () => {
      const task = adapter.submitTask({ diff: 'test' });
      await adapter.executeTask(task.id);

      // Task is now completed, cannot execute again
      await expect(adapter.executeTask(task.id)).rejects.toThrow("expected 'submitted'");
    });
  });

  describe('cancelTask', () => {
    it('cancels a submitted task', () => {
      const task = adapter.submitTask({ diff: 'test' });
      const canceled = adapter.cancelTask(task.id);

      expect(canceled?.state).toBe('canceled');
    });

    it('returns undefined for nonexistent task', () => {
      expect(adapter.cancelTask('nonexistent')).toBeUndefined();
    });

    it('returns task unchanged if already in terminal state', async () => {
      const task = adapter.submitTask({ diff: 'test' });
      await adapter.executeTask(task.id);

      const result = adapter.cancelTask(task.id);
      expect(result?.state).toBe('completed');
    });
  });

  describe('getTask / listTasks', () => {
    it('retrieves task by ID', () => {
      const task = adapter.submitTask({ diff: 'test' });
      expect(adapter.getTask(task.id)).toBeDefined();
      expect(adapter.getTask(task.id)!.id).toBe(task.id);
    });

    it('returns undefined for unknown ID', () => {
      expect(adapter.getTask('unknown')).toBeUndefined();
    });

    it('lists all tasks', () => {
      adapter.submitTask({ diff: 'test1' });
      adapter.submitTask({ diff: 'test2' });

      expect(adapter.listTasks()).toHaveLength(2);
    });
  });

  describe('handleRequest (JSON-RPC)', () => {
    it('handles agent/capabilities', async () => {
      const request: ACPRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'agent/capabilities',
      };

      const response = await adapter.handleRequest(request);

      expect(response.result).toBeDefined();
      expect((response.result as any).name).toBe('ghagga');
    });

    it('handles task/submit', async () => {
      const request: ACPRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'task/submit',
        params: { diff: 'test diff', mode: 'simple' } as unknown as Record<string, unknown>,
      };

      const response = await adapter.handleRequest(request);

      expect(response.error).toBeUndefined();
      // The task is returned immediately; fire-and-forget execution may have
      // already transitioned it, so accept both 'submitted' and terminal states
      const resultState = (response.result as any).state;
      expect(['submitted', 'working', 'completed']).toContain(resultState);
      expect((response.result as any).id).toMatch(/^ghagga-/);
    });

    it('returns error for task/submit without diff', async () => {
      const request: ACPRequest = {
        jsonrpc: '2.0',
        id: 3,
        method: 'task/submit',
        params: { mode: 'simple' },
      };

      const response = await adapter.handleRequest(request);

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
    });

    it('handles task/get', async () => {
      const task = adapter.submitTask({ diff: 'test' });

      const response = await adapter.handleRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'task/get',
        params: { id: task.id },
      });

      expect((response.result as any).id).toBe(task.id);
    });

    it('handles task/get for unknown task', async () => {
      const response = await adapter.handleRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'task/get',
        params: { id: 'unknown' },
      });

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32001);
    });

    it('handles task/list', async () => {
      adapter.submitTask({ diff: 'test1' });
      adapter.submitTask({ diff: 'test2' });

      const response = await adapter.handleRequest({
        jsonrpc: '2.0',
        id: 6,
        method: 'task/list',
      });

      expect(response.result as any[]).toHaveLength(2);
    });

    it('handles task/cancel', async () => {
      const task = adapter.submitTask({ diff: 'test' });

      const response = await adapter.handleRequest({
        jsonrpc: '2.0',
        id: 7,
        method: 'task/cancel',
        params: { id: task.id },
      });

      expect((response.result as any).state).toBe('canceled');
    });

    it('returns method not found for unknown methods', async () => {
      const response = await adapter.handleRequest({
        jsonrpc: '2.0',
        id: 8,
        method: 'unknown/method',
      });

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32601);
    });
  });
});
