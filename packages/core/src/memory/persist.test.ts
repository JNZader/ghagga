import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryStorage } from '../types.js';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('./privacy.js', () => ({
  stripPrivateData: vi.fn((text: string) => `[STRIPPED]${text}`),
}));

import type { ReviewFinding, ReviewResult } from '../types.js';
import { persistReviewObservations } from './persist.js';
import { stripPrivateData } from './privacy.js';

// ─── Helpers ────────────────────────────────────────────────────

const mockStripPrivateData = vi.mocked(stripPrivateData);

function createMockStorage(overrides: Partial<MemoryStorage> = {}): MemoryStorage {
  return {
    searchObservations: vi.fn<MemoryStorage['searchObservations']>().mockResolvedValue([]),
    saveObservation: vi.fn<MemoryStorage['saveObservation']>().mockResolvedValue({
      id: 1,
      type: 'pattern',
      title: 'test',
      content: 'test',
      filePaths: null,
      severity: null,
    }),
    createSession: vi.fn<MemoryStorage['createSession']>().mockResolvedValue({ id: 1 }),
    endSession: vi.fn<MemoryStorage['endSession']>().mockResolvedValue(undefined),
    close: vi.fn<MemoryStorage['close']>().mockResolvedValue(undefined),
    listObservations: vi.fn().mockResolvedValue([]),
    getObservation: vi.fn().mockResolvedValue(null),
    deleteObservation: vi.fn().mockResolvedValue(false),
    getStats: vi.fn().mockResolvedValue({
      totalObservations: 0,
      byType: {},
      byProject: {},
      oldestObservation: null,
      newestObservation: null,
    }),
    clearObservations: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'high',
    category: 'security',
    file: 'src/auth.ts',
    line: 42,
    message: 'SQL injection vulnerability',
    suggestion: 'Use parameterized queries',
    source: 'ai',
    ...overrides,
  };
}

function makeResult(
  findings: ReviewFinding[] = [],
  overrides: Partial<ReviewResult> = {},
): ReviewResult {
  return {
    status: 'PASSED',
    summary: 'Review completed successfully.',
    findings,
    staticAnalysis: {
      semgrep: { status: 'skipped', findings: [], executionTimeMs: 0 },
      trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
      cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
    },
    memoryContext: null,
    metadata: {
      mode: 'simple',
      provider: 'gateway',
      model: 'claude-sonnet-4-20250514',
      tokensUsed: 150,
      executionTimeMs: 1200,
      toolsRun: [],
      toolsSkipped: [],
    },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('persistReviewObservations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Early return on null/falsy storage ──

  it('returns early when storage is null', async () => {
    const storage = createMockStorage();
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    await persistReviewObservations(null as any, 'owner/repo', 1, makeResult());

    expect(storage.createSession).not.toHaveBeenCalled();
    expect(storage.saveObservation).not.toHaveBeenCalled();
    expect(storage.endSession).not.toHaveBeenCalled();
  });

  it('returns early when storage is undefined', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    await persistReviewObservations(undefined as any, 'owner/repo', 1, makeResult());
    // No mock to check — just verify it doesn't throw
  });

  it('returns early when storage is empty string (falsy)', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    await persistReviewObservations('' as any, 'owner/repo', 1, makeResult());
    // No mock to check — just verify it doesn't throw
  });

  // ── Session lifecycle ──

  it('creates a memory session with project and prNumber', async () => {
    const storage = createMockStorage();
    await persistReviewObservations(
      storage,
      'owner/repo',
      42,
      makeResult([makeFinding({ severity: 'critical' })]),
    );

    expect(storage.createSession).toHaveBeenCalledWith({
      project: 'owner/repo',
      prNumber: 42,
    });
  });

  it('ends the memory session with a summary', async () => {
    const storage = createMockStorage();
    const result = makeResult([makeFinding({ severity: 'critical' })], { status: 'FAILED' });

    await persistReviewObservations(storage, 'owner/repo', 7, result);

    expect(storage.endSession).toHaveBeenCalledWith(1, expect.stringContaining('PR #7'));
    expect(storage.endSession).toHaveBeenCalledWith(
      1,
      expect.stringContaining('1 significant findings'),
    );
  });

  // ── Filtering: only critical and high ──

  it('persists critical, high, and medium severity findings', async () => {
    const findings = [
      makeFinding({ severity: 'critical', message: 'Critical issue' }),
      makeFinding({ severity: 'high', message: 'High issue' }),
      makeFinding({ severity: 'medium', message: 'Medium issue' }),
      makeFinding({ severity: 'low', message: 'Low issue' }),
      makeFinding({ severity: 'info', message: 'Info issue' }),
    ];
    const result = makeResult(findings);
    const storage = createMockStorage();

    await persistReviewObservations(storage, 'owner/repo', 1, result);

    // 3 finding observations + 1 summary = 4 saveObservation calls
    expect(storage.saveObservation).toHaveBeenCalledTimes(4);
  });

  it('does not persist low or info findings', async () => {
    const findings = [
      makeFinding({ severity: 'low', message: 'Low' }),
      makeFinding({ severity: 'info', message: 'Info' }),
    ];
    const result = makeResult(findings);
    const storage = createMockStorage();

    await persistReviewObservations(storage, 'owner/repo', 1, result);

    // No significant findings → no session, no observations, no summary
    expect(storage.createSession).not.toHaveBeenCalled();
    expect(storage.saveObservation).not.toHaveBeenCalled();
  });

  it('persists medium severity findings as significant', async () => {
    const findings = [makeFinding({ severity: 'medium', message: 'Medium issue' })];
    const result = makeResult(findings);
    const storage = createMockStorage();

    await persistReviewObservations(storage, 'owner/repo', 1, result);

    // 1 finding observation + 1 summary = 2 saveObservation calls
    expect(storage.createSession).toHaveBeenCalled();
    expect(storage.saveObservation).toHaveBeenCalledTimes(2);
  });

  it('passes severity field in saveObservation calls for findings', async () => {
    const result = makeResult([makeFinding({ severity: 'critical', category: 'security' })]);
    const storage = createMockStorage();
    await persistReviewObservations(storage, 'owner/repo', 1, result);

    const findingCall = vi.mocked(storage.saveObservation).mock.calls[0]?.[0];
    expect(findingCall.severity).toBe('critical');
  });

  it('does not pass severity field in summary observation', async () => {
    const result = makeResult([makeFinding({ severity: 'high' })]);
    const storage = createMockStorage();
    await persistReviewObservations(storage, 'owner/repo', 1, result);

    // Last call is the summary observation
    const summaryCall = vi.mocked(storage.saveObservation).mock.calls[1]?.[0];
    expect(summaryCall.severity).toBeUndefined();
  });

  // ── Category → ObservationType mapping ──

  it('maps security category to discovery observation type', async () => {
    const result = makeResult([makeFinding({ severity: 'critical', category: 'security' })]);
    const storage = createMockStorage();
    await persistReviewObservations(storage, 'owner/repo', 1, result);

    const findingCall = vi.mocked(storage.saveObservation).mock.calls[0]?.[0];
    expect(findingCall).toEqual(expect.objectContaining({ type: 'discovery' }));
  });

  it('maps bug category to bugfix observation type', async () => {
    const result = makeResult([makeFinding({ severity: 'high', category: 'bug' })]);
    const storage = createMockStorage();
    await persistReviewObservations(storage, 'owner/repo', 1, result);

    const findingCall = vi.mocked(storage.saveObservation).mock.calls[0]?.[0];
    expect(findingCall).toEqual(expect.objectContaining({ type: 'bugfix' }));
  });

  it('maps performance category to pattern observation type', async () => {
    const result = makeResult([makeFinding({ severity: 'high', category: 'performance' })]);
    const storage = createMockStorage();
    await persistReviewObservations(storage, 'owner/repo', 1, result);

    const findingCall = vi.mocked(storage.saveObservation).mock.calls[0]?.[0];
    expect(findingCall).toEqual(expect.objectContaining({ type: 'pattern' }));
  });

  it('maps style category to pattern observation type', async () => {
    const result = makeResult([makeFinding({ severity: 'high', category: 'style' })]);
    const storage = createMockStorage();
    await persistReviewObservations(storage, 'owner/repo', 1, result);

    const findingCall = vi.mocked(storage.saveObservation).mock.calls[0]?.[0];
    expect(findingCall).toEqual(expect.objectContaining({ type: 'pattern' }));
  });

  it('maps maintainability category to pattern observation type', async () => {
    const result = makeResult([makeFinding({ severity: 'high', category: 'maintainability' })]);
    const storage = createMockStorage();
    await persistReviewObservations(storage, 'owner/repo', 1, result);

    const findingCall = vi.mocked(storage.saveObservation).mock.calls[0]?.[0];
    expect(findingCall).toEqual(expect.objectContaining({ type: 'pattern' }));
  });

  it('maps error-handling category to learning observation type', async () => {
    const result = makeResult([makeFinding({ severity: 'high', category: 'error-handling' })]);
    const storage = createMockStorage();
    await persistReviewObservations(storage, 'owner/repo', 1, result);

    const findingCall = vi.mocked(storage.saveObservation).mock.calls[0]?.[0];
    expect(findingCall).toEqual(expect.objectContaining({ type: 'learning' }));
  });

  it('maps unknown category to learning observation type', async () => {
    const result = makeResult([makeFinding({ severity: 'high', category: 'unknown-cat' })]);
    const storage = createMockStorage();
    await persistReviewObservations(storage, 'owner/repo', 1, result);

    const findingCall = vi.mocked(storage.saveObservation).mock.calls[0]?.[0];
    expect(findingCall).toEqual(expect.objectContaining({ type: 'learning' }));
  });

  // ── Private data stripping ──

  it('strips private data from finding message and suggestion', async () => {
    const result = makeResult([
      makeFinding({
        severity: 'critical',
        message: 'Secret: sk-ant-12345',
        suggestion: 'Remove the key: sk-ant-12345',
      }),
    ]);
    const storage = createMockStorage();

    await persistReviewObservations(storage, 'owner/repo', 1, result);

    expect(mockStripPrivateData).toHaveBeenCalledWith('Secret: sk-ant-12345');
    expect(mockStripPrivateData).toHaveBeenCalledWith('Remove the key: sk-ant-12345');
  });

  it('does not strip suggestion when it is undefined', async () => {
    const result = makeResult([makeFinding({ severity: 'critical', suggestion: undefined })]);
    const storage = createMockStorage();

    await persistReviewObservations(storage, 'owner/repo', 1, result);

    // stripPrivateData called for message and summary, but NOT for suggestion
    const calls = mockStripPrivateData.mock.calls.map((c) => c[0]);
    // Should be called for message, and for summary (in summary observation)
    // but not for undefined suggestion
    expect(calls).not.toContain(undefined);
  });

  // ── Observation content structure ──

  it('builds observation content with severity, category, file, and message', async () => {
    const finding = makeFinding({
      severity: 'critical',
      category: 'security',
      file: 'src/db.ts',
      line: 99,
      message: 'SQL injection detected',
      suggestion: 'Use prepared statements',
    });
    const result = makeResult([finding]);
    const storage = createMockStorage();

    await persistReviewObservations(storage, 'project', 1, result);

    const savedObs = vi.mocked(storage.saveObservation).mock.calls[0]?.[0];
    expect(savedObs.content).toContain('[CRITICAL]');
    expect(savedObs.content).toContain('security');
    expect(savedObs.content).toContain('src/db.ts:99');
    expect(savedObs.content).toContain('[STRIPPED]SQL injection detected');
    expect(savedObs.content).toContain('[STRIPPED]Use prepared statements');
  });

  it('omits line number when finding has no line', async () => {
    const finding = makeFinding({
      severity: 'high',
      file: 'package.json',
      line: undefined,
    });
    const result = makeResult([finding]);
    const storage = createMockStorage();

    await persistReviewObservations(storage, 'project', 1, result);

    const savedObs = vi.mocked(storage.saveObservation).mock.calls[0]?.[0];
    expect(savedObs.content).toContain('File: package.json');
    expect(savedObs.content).not.toContain('package.json:');
  });

  it('saves observation with correct sessionId, project, and filePaths', async () => {
    const finding = makeFinding({ severity: 'high', file: 'src/core.ts' });
    const result = makeResult([finding]);
    const storage = createMockStorage();

    await persistReviewObservations(storage, 'org/repo', 5, result);

    const savedObs = vi.mocked(storage.saveObservation).mock.calls[0]?.[0];
    expect(savedObs.sessionId).toBe(1);
    expect(savedObs.project).toBe('org/repo');
    expect(savedObs.filePaths).toEqual(['src/core.ts']);
  });

  it('truncates title to 80 chars of sanitized message', async () => {
    const longMessage = 'A'.repeat(200);
    const result = makeResult([
      makeFinding({ severity: 'high', category: 'bug', message: longMessage }),
    ]);
    const storage = createMockStorage();

    await persistReviewObservations(storage, 'project', 1, result);

    const savedObs = vi.mocked(storage.saveObservation).mock.calls[0]?.[0];
    // Title format: "category: sanitized_message.slice(0, 80)"
    // The sanitized message is [STRIPPED] + longMessage
    expect(savedObs.title?.length).toBeLessThanOrEqual('bug: '.length + 80);
  });

  // ── Summary observation ──

  it('saves a summary observation when there are significant findings', async () => {
    const result = makeResult(
      [makeFinding({ severity: 'critical' }), makeFinding({ severity: 'high' })],
      { status: 'FAILED', summary: 'Critical issues found in auth.' },
    );
    const storage = createMockStorage();

    await persistReviewObservations(storage, 'org/repo', 10, result);

    // 2 finding observations + 1 summary = 3 calls
    const lastCall = vi.mocked(storage.saveObservation).mock.calls[2]?.[0];
    expect(lastCall.type).toBe('decision');
    expect(lastCall.title).toBe('PR #10 review: FAILED');
    expect(lastCall.topicKey).toBe('pr-10-review');
    expect(lastCall.filePaths).toHaveLength(2);
  });

  it('strips private data from summary content', async () => {
    const result = makeResult([makeFinding({ severity: 'critical' })], {
      summary: 'Found key: sk-test-123',
    });
    const storage = createMockStorage();

    await persistReviewObservations(storage, 'project', 1, result);

    expect(mockStripPrivateData).toHaveBeenCalledWith('Found key: sk-test-123');
  });

  it('does not save summary observation when no significant findings', async () => {
    const result = makeResult([
      makeFinding({ severity: 'low' }),
      makeFinding({ severity: 'info' }),
    ]);
    const storage = createMockStorage();

    await persistReviewObservations(storage, 'project', 1, result);

    expect(storage.createSession).not.toHaveBeenCalled();
    expect(storage.saveObservation).not.toHaveBeenCalled();
  });

  it('does not save summary when findings array is empty', async () => {
    const result = makeResult([]);
    const storage = createMockStorage();

    await persistReviewObservations(storage, 'project', 1, result);

    expect(storage.createSession).not.toHaveBeenCalled();
    expect(storage.saveObservation).not.toHaveBeenCalled();
  });

  // ── Error handling ──

  it('catches errors from createSession and does not throw', async () => {
    const storage = createMockStorage({
      createSession: vi
        .fn<MemoryStorage['createSession']>()
        .mockRejectedValue(new Error('DB connection failed')),
    });

    await expect(
      persistReviewObservations(
        storage,
        'project',
        1,
        makeResult([makeFinding({ severity: 'critical' })]),
      ),
    ).resolves.toBeUndefined();
  });

  it('catches errors from saveObservation and does not throw', async () => {
    const storage = createMockStorage({
      saveObservation: vi
        .fn<MemoryStorage['saveObservation']>()
        .mockRejectedValue(new Error('Write failed')),
    });

    await expect(
      persistReviewObservations(
        storage,
        'project',
        1,
        makeResult([makeFinding({ severity: 'critical' })]),
      ),
    ).resolves.toBeUndefined();
  });

  it('catches errors from endSession and does not throw', async () => {
    const storage = createMockStorage({
      endSession: vi
        .fn<MemoryStorage['endSession']>()
        .mockRejectedValue(new Error('Session end failed')),
    });

    await expect(
      persistReviewObservations(
        storage,
        'project',
        1,
        makeResult([makeFinding({ severity: 'critical' })]),
      ),
    ).resolves.toBeUndefined();
  });

  it('logs a warning when an error occurs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = createMockStorage({
      createSession: vi
        .fn<MemoryStorage['createSession']>()
        .mockRejectedValue(new Error('DB down')),
    });

    await persistReviewObservations(
      storage,
      'project',
      1,
      makeResult([makeFinding({ severity: 'critical' })]),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ghagga]'),
      expect.stringContaining('DB down'),
    );

    warnSpy.mockRestore();
  });

  it('logs string errors correctly', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = createMockStorage({
      createSession: vi.fn<MemoryStorage['createSession']>().mockRejectedValue('string error'),
    });

    await persistReviewObservations(
      storage,
      'project',
      1,
      makeResult([makeFinding({ severity: 'critical' })]),
    );

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[ghagga]'), 'string error');

    warnSpy.mockRestore();
  });
});
