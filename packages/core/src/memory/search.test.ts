import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryObservationRow, MemoryStorage } from '../types.js';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('./context.js', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: mock cast
  formatMemoryContext: vi.fn((obs: any[]) => `Formatted: ${obs.length} observations`),
}));

import { formatMemoryContext } from './context.js';
import {
  buildIssueSearchQuery,
  buildSearchQuery,
  DEDUP_SCORE_THRESHOLD,
  DEFAULT_IGNORED_SEGMENTS,
  findIssueDuplicates,
  ISSUE_TRIAGE_OBSERVATION_TYPE,
  MAX_ISSUE_SEARCH_TERMS,
  MAX_SEARCH_TERMS,
  searchMemoryForContext,
} from './search.js';

// ─── Helpers ────────────────────────────────────────────────────

const mockFormatMemoryContext = vi.mocked(formatMemoryContext);

function makeObservation(overrides: Partial<MemoryObservationRow> = {}): MemoryObservationRow {
  return {
    id: 1,
    type: 'pattern',
    title: 'Test observation',
    content: 'Some content here.',
    filePaths: ['src/auth.ts'],
    ...overrides,
  };
}

function createMockStorage(overrides: Partial<MemoryStorage> = {}): MemoryStorage {
  return {
    searchObservations: vi.fn<MemoryStorage['searchObservations']>().mockResolvedValue([]),
    saveObservation: vi.fn<MemoryStorage['saveObservation']>().mockResolvedValue(makeObservation()),
    createSession: vi.fn<MemoryStorage['createSession']>().mockResolvedValue({ id: 1 }),
    endSession: vi.fn<MemoryStorage['endSession']>().mockResolvedValue(undefined),
    close: vi.fn<MemoryStorage['close']>().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('searchMemoryForContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Null returns for falsy storage ──

  it('returns null when storage is null', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const result = await searchMemoryForContext(null as any, 'owner/repo', ['src/auth.ts']);
    expect(result).toBeNull();
  });

  it('returns null when storage is undefined', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const result = await searchMemoryForContext(undefined as any, 'owner/repo', ['src/auth.ts']);
    expect(result).toBeNull();
  });

  it('returns null when storage is empty string (falsy)', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const result = await searchMemoryForContext('' as any, 'owner/repo', ['src/auth.ts']);
    expect(result).toBeNull();
  });

  // ── Empty/excluded file lists ──

  it('returns null when file list is empty', async () => {
    const storage = createMockStorage();
    const result = await searchMemoryForContext(storage, 'project', []);
    expect(result).toBeNull();
    expect(storage.searchObservations).not.toHaveBeenCalled();
  });

  it('returns null when all files are in excluded directories', async () => {
    const storage = createMockStorage();
    const result = await searchMemoryForContext(storage, 'project', [
      'src/a.ts',
      'lib/b.ts',
      'dist/c.js',
    ]);
    // All segments after split: 'src' (excluded), 'a' (name, but 'a'.length == 1 ≤ 2),
    // 'lib' (excluded), 'b' (too short), 'dist' (excluded), 'c' (too short)
    // → query is empty string → returns null
    expect(result).toBeNull();
  });

  it('returns null when all file names are too short (≤ 2 chars)', async () => {
    const storage = createMockStorage();
    const result = await searchMemoryForContext(
      storage,
      'project',
      ['ab.ts'], // 'ab' has length 2, which is ≤ 2
    );
    expect(result).toBeNull();
  });

  // ── buildSearchQuery logic ──

  it('extracts meaningful path segments as search terms', async () => {
    const storage = createMockStorage({
      searchObservations: vi
        .fn<MemoryStorage['searchObservations']>()
        .mockResolvedValue([makeObservation()]),
    });

    await searchMemoryForContext(storage, 'project', ['src/auth/login.ts', 'lib/db/pool.ts']);

    // 'src' excluded, 'auth' kept, 'login' kept (extension removed)
    // 'lib' excluded, 'db' too short (2), 'pool' kept
    expect(storage.searchObservations).toHaveBeenCalledWith(
      'project',
      expect.stringContaining('auth'),
      { limit: 3 },
    );
    // biome-ignore lint/style/noNonNullAssertion: test assertion on known mock data
    const call = vi.mocked(storage.searchObservations).mock.calls[0]!;
    const query = call[1];
    expect(query).toContain('login');
    expect(query).toContain('pool');
    expect(query).not.toContain('src');
    expect(query).not.toContain('lib');
  });

  it('skips node_modules, test, tests, build directories', async () => {
    const storage = createMockStorage({
      searchObservations: vi
        .fn<MemoryStorage['searchObservations']>()
        .mockResolvedValue([makeObservation()]),
    });

    await searchMemoryForContext(storage, 'project', [
      'node_modules/lodash/debounce.js',
      'test/checker.spec.ts',
      'tests/integration/runner.spec.ts',
      'build/output.js',
    ]);

    // biome-ignore lint/style/noNonNullAssertion: test assertion on known mock data
    const call = vi.mocked(storage.searchObservations).mock.calls[0]!;
    const query = call[1];
    // Verify excluded dirs are not in query as standalone terms
    const terms = query.split(' ');
    expect(terms).not.toContain('node_modules');
    expect(terms).not.toContain('test');
    expect(terms).not.toContain('tests');
    expect(terms).not.toContain('build');
    // But meaningful segments should be kept
    expect(query).toContain('lodash');
    expect(query).toContain('debounce');
  });

  it('removes all file extensions from names (including multi-part)', async () => {
    const storage = createMockStorage({
      searchObservations: vi
        .fn<MemoryStorage['searchObservations']>()
        .mockResolvedValue([makeObservation()]),
    });

    await searchMemoryForContext(storage, 'project', ['src/services/payment.service.ts']);

    // biome-ignore lint/style/noNonNullAssertion: test assertion on known mock data
    const call = vi.mocked(storage.searchObservations).mock.calls[0]!;
    const query = call[1];
    // 'payment.service.ts' → strips all extensions → 'payment'
    expect(query).toContain('services');
    expect(query).toContain('payment');
    expect(query).not.toContain('.ts');
    expect(query).not.toContain('payment.service');
  });

  it('deduplicates terms using a Set', async () => {
    const storage = createMockStorage({
      searchObservations: vi
        .fn<MemoryStorage['searchObservations']>()
        .mockResolvedValue([makeObservation()]),
    });

    await searchMemoryForContext(storage, 'project', ['src/auth/login.ts', 'src/auth/logout.ts']);

    // biome-ignore lint/style/noNonNullAssertion: test assertion on known mock data
    const call = vi.mocked(storage.searchObservations).mock.calls[0]!;
    const query = call[1];
    // 'auth' should appear only once
    const terms = query.split(' ');
    const authCount = terms.filter((t) => t === 'auth').length;
    expect(authCount).toBe(1);
  });

  it('limits search terms to 10', async () => {
    const storage = createMockStorage({
      searchObservations: vi
        .fn<MemoryStorage['searchObservations']>()
        .mockResolvedValue([makeObservation()]),
    });

    const files = Array.from({ length: 15 }, (_, i) => `dir${i}/file${i}.ts`);
    await searchMemoryForContext(storage, 'project', files);

    // biome-ignore lint/style/noNonNullAssertion: test assertion on known mock data
    const call = vi.mocked(storage.searchObservations).mock.calls[0]!;
    const query = call[1];
    const terms = query.split(' ');
    expect(terms.length).toBeLessThanOrEqual(10);
  });

  // ── searchObservations call ──

  it('calls storage.searchObservations with correct project, query, and limit', async () => {
    const storage = createMockStorage({
      searchObservations: vi
        .fn<MemoryStorage['searchObservations']>()
        .mockResolvedValue([makeObservation()]),
    });

    await searchMemoryForContext(storage, 'owner/repo', ['src/services/auth.ts']);

    expect(storage.searchObservations).toHaveBeenCalledWith('owner/repo', expect.any(String), {
      limit: 3,
    });
  });

  // ── No observations found ──

  it('returns null when searchObservations returns empty array', async () => {
    const storage = createMockStorage();

    const result = await searchMemoryForContext(storage, 'project', ['src/services/auth.ts']);
    expect(result).toBeNull();
  });

  it('returns null when searchObservations returns null', async () => {
    const storage = createMockStorage({
      searchObservations: vi
        .fn<MemoryStorage['searchObservations']>()
        // biome-ignore lint/suspicious/noExplicitAny: mock cast
        .mockResolvedValue(null as any),
    });

    const result = await searchMemoryForContext(storage, 'project', ['src/services/auth.ts']);
    expect(result).toBeNull();
  });

  // ── Successful formatting ──

  it('formats observations and returns the context string', async () => {
    const observations = [
      makeObservation({ type: 'pattern', title: 'Auth pattern', content: 'Uses JWT tokens' }),
      makeObservation({ type: 'bugfix', title: 'Race condition', content: 'Fixed async issue' }),
    ];
    const storage = createMockStorage({
      searchObservations: vi
        .fn<MemoryStorage['searchObservations']>()
        .mockResolvedValue(observations),
    });

    const result = await searchMemoryForContext(storage, 'project', ['src/services/auth.ts']);

    expect(mockFormatMemoryContext).toHaveBeenCalledWith([
      { type: 'pattern', title: 'Auth pattern', content: 'Uses JWT tokens' },
      { type: 'bugfix', title: 'Race condition', content: 'Fixed async issue' },
    ]);
    expect(result).toBe('Formatted: 2 observations');
  });

  it('maps observations to type/title/content only (strips filePaths)', async () => {
    const observations = [
      makeObservation({
        type: 'discovery',
        title: 'Test',
        content: 'Content',
        filePaths: ['a.ts', 'b.ts'],
      }),
    ];
    const storage = createMockStorage({
      searchObservations: vi
        .fn<MemoryStorage['searchObservations']>()
        .mockResolvedValue(observations),
    });

    await searchMemoryForContext(storage, 'project', ['src/services/auth.ts']);

    expect(mockFormatMemoryContext).toHaveBeenCalledWith([
      { type: 'discovery', title: 'Test', content: 'Content' },
    ]);
  });

  // ── Error handling ──

  it('returns null when searchObservations throws', async () => {
    const storage = createMockStorage({
      searchObservations: vi
        .fn<MemoryStorage['searchObservations']>()
        .mockRejectedValue(new Error('DB timeout')),
    });

    const result = await searchMemoryForContext(storage, 'project', ['src/auth/login.ts']);
    expect(result).toBeNull();
  });

  it('logs a warning when an error occurs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = createMockStorage({
      searchObservations: vi
        .fn<MemoryStorage['searchObservations']>()
        .mockRejectedValue(new Error('Connection lost')),
    });

    await searchMemoryForContext(storage, 'project', ['src/auth/login.ts']);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ghagga]'),
      expect.stringContaining('Connection lost'),
    );

    warnSpy.mockRestore();
  });

  it('returns null when formatMemoryContext throws', async () => {
    const storage = createMockStorage({
      searchObservations: vi
        .fn<MemoryStorage['searchObservations']>()
        .mockResolvedValue([makeObservation()]),
    });
    mockFormatMemoryContext.mockImplementation(() => {
      throw new Error('Format error');
    });

    const result = await searchMemoryForContext(storage, 'project', ['src/auth/login.ts']);
    expect(result).toBeNull();
  });
});

// ─── buildSearchQuery unit tests ────────────────────────────────

describe('buildSearchQuery', () => {
  it('returns empty string for empty file list', () => {
    expect(buildSearchQuery([])).toBe('');
  });

  it('extracts directory and file names as terms', () => {
    const result = buildSearchQuery(['src/auth/login.ts']);
    expect(result).toContain('auth');
    expect(result).toContain('login');
    expect(result).not.toContain('src');
  });

  it('strips multi-part extensions like .test.ts', () => {
    const result = buildSearchQuery(['src/auth/login.test.ts']);
    expect(result).toContain('login');
    expect(result).not.toContain('test');
    expect(result).not.toContain('.ts');
  });

  it('strips multi-part extensions like .spec.tsx', () => {
    const result = buildSearchQuery(['components/button.spec.tsx']);
    expect(result).toContain('components');
    expect(result).toContain('button');
    expect(result).not.toContain('spec');
    expect(result).not.toContain('.tsx');
  });

  it('strips .d.ts type declaration extensions', () => {
    const result = buildSearchQuery(['types/config.d.ts']);
    expect(result).toContain('types');
    expect(result).toContain('config');
    expect(result).not.toContain('.d');
  });

  it('ignores all DEFAULT_IGNORED_SEGMENTS', () => {
    const ignoredDirs = [...DEFAULT_IGNORED_SEGMENTS];
    const files = ignoredDirs.map((dir) => `${dir}/meaningful.ts`);
    const result = buildSearchQuery(files);
    const terms = result.split(' ');
    for (const dir of ignoredDirs) {
      expect(terms).not.toContain(dir);
    }
    // 'meaningful' should be present (it's long enough and repeated → just once via Set)
    expect(result).toContain('meaningful');
  });

  it('ignores __tests__, __mocks__, __fixtures__, __snapshots__', () => {
    const result = buildSearchQuery([
      '__tests__/utils/helpers.ts',
      '__mocks__/service.ts',
      '__fixtures__/data.json',
      '__snapshots__/component.snap',
    ]);
    const terms = result.split(' ');
    expect(terms).not.toContain('__tests__');
    expect(terms).not.toContain('__mocks__');
    expect(terms).not.toContain('__fixtures__');
    expect(terms).not.toContain('__snapshots__');
  });

  it('ignores coverage, vendor, out, tmp, temp directories', () => {
    const result = buildSearchQuery([
      'coverage/lcov/report.html',
      'vendor/pkg/module.go',
      'out/bundle.js',
      'tmp/cache.bin',
      'temp/upload.dat',
    ]);
    const terms = result.split(' ');
    expect(terms).not.toContain('coverage');
    expect(terms).not.toContain('vendor');
    expect(terms).not.toContain('out');
    expect(terms).not.toContain('tmp');
    expect(terms).not.toContain('temp');
  });

  it('accepts custom ignored segments set', () => {
    const custom = new Set(['custom', 'ignored']);
    const result = buildSearchQuery(['custom/important/file.ts', 'ignored/other.ts'], custom);
    expect(result).toContain('important');
    expect(result).toContain('file');
    expect(result).toContain('other');
    expect(result).not.toContain('custom');
    expect(result).not.toContain('ignored');
    // 'src' is NOT in the custom set, so it should be kept
    const result2 = buildSearchQuery(['src/file.ts'], custom);
    expect(result2).toContain('src');
  });

  it('filters out terms shorter than 3 characters', () => {
    const result = buildSearchQuery(['a/bb/ccc/dddd.ts']);
    expect(result).not.toContain('a');
    expect(result).not.toContain('bb');
    expect(result).toContain('ccc');
    expect(result).toContain('dddd');
  });

  it('deduplicates terms', () => {
    const result = buildSearchQuery(['pkg/auth/login.ts', 'pkg/auth/logout.ts']);
    const terms = result.split(' ');
    const authCount = terms.filter((t) => t === 'auth').length;
    expect(authCount).toBe(1);
  });

  it(`limits output to MAX_SEARCH_TERMS (${MAX_SEARCH_TERMS}) terms`, () => {
    const files = Array.from({ length: 20 }, (_, i) => `unique${i}/file${i}.ts`);
    const result = buildSearchQuery(files);
    const terms = result.split(' ');
    expect(terms.length).toBeLessThanOrEqual(MAX_SEARCH_TERMS);
  });

  it('handles paths with no directory (bare filenames)', () => {
    const result = buildSearchQuery(['standalone.ts']);
    expect(result).toBe('standalone');
  });

  it('handles deeply nested paths', () => {
    const result = buildSearchQuery(['src/packages/core/agents/consensus/handler.ts']);
    expect(result).toContain('packages');
    expect(result).toContain('core');
    expect(result).toContain('agents');
    expect(result).toContain('consensus');
    expect(result).toContain('handler');
  });

  it('exports MAX_SEARCH_TERMS as a named constant', () => {
    expect(typeof MAX_SEARCH_TERMS).toBe('number');
    expect(MAX_SEARCH_TERMS).toBeGreaterThan(0);
  });

  it('exports DEFAULT_IGNORED_SEGMENTS as a Set', () => {
    expect(DEFAULT_IGNORED_SEGMENTS).toBeInstanceOf(Set);
    expect(DEFAULT_IGNORED_SEGMENTS.size).toBeGreaterThan(0);
    expect(DEFAULT_IGNORED_SEGMENTS.has('src')).toBe(true);
    expect(DEFAULT_IGNORED_SEGMENTS.has('node_modules')).toBe(true);
  });
});

// ─── Issue dedup: query builder ─────────────────────────────────

describe('buildIssueSearchQuery', () => {
  it('builds a keyword query from a realistic title + body', () => {
    const title = 'Login button throws TypeError on Safari';
    const body = 'When I click the login button on Safari the console shows a TypeError.';
    const query = buildIssueSearchQuery(title, body);

    // Meaningful terms survive, lowercased.
    expect(query).toContain('login');
    expect(query).toContain('button');
    expect(query).toContain('typeerror');
    expect(query).toContain('safari');
    // Whole query is lowercase.
    expect(query).toBe(query.toLowerCase());
  });

  it('strips markdown code fences and inline code so noise does not become terms', () => {
    const title = 'Crash in parser';
    const body = [
      'The parser crashes. Repro:',
      '```ts',
      'const sideEffectToken = doSomethingWeird();',
      '```',
      'Inline `anotherNoiseToken` here.',
    ].join('\n');
    const query = buildIssueSearchQuery(title, body);

    expect(query).toContain('parser');
    expect(query).toContain('crash');
    // Code-fenced and inline-code identifiers must NOT leak into the query.
    expect(query).not.toContain('sideeffecttoken');
    expect(query).not.toContain('anothernoisetoken');
  });

  it('strips multi-backtick / nested code fences without leaking inner tokens', () => {
    const title = 'Renderer breaks';
    // A 4-backtick fence wrapping a nested triple fence — the greedy `{3,}
    // pattern must consume the WHOLE outer block, not stop at the inner ```.
    const body = [
      'The renderer breaks. Example:',
      '````md',
      '```js',
      'const leakedInnerToken = compute();',
      '```',
      '````',
      'trailing keyword',
    ].join('\n');
    const query = buildIssueSearchQuery(title, body);

    expect(query).toContain('renderer');
    expect(query).toContain('breaks');
    // Nothing from inside the (malformed/nested) fence may survive.
    expect(query).not.toContain('leakedinnertoken');
    expect(query).not.toContain('compute');
    // Text OUTSIDE the fence (after it fully closes) must remain.
    expect(query).toContain('trailing');
    expect(query).toContain('keyword');
  });

  it('drops the added stopwords "using" and "via"', () => {
    const query = buildIssueSearchQuery('Crash using handler', 'reproduced via webhook');
    const terms = query.split(' ').filter(Boolean);
    expect(terms).not.toContain('using');
    expect(terms).not.toContain('via');
    expect(query).toContain('crash');
    expect(query).toContain('handler');
    expect(query).toContain('webhook');
  });

  it('drops stopwords and short tokens', () => {
    const query = buildIssueSearchQuery('The and of to is a', 'it be on at in');
    // Pure stopwords/short tokens → empty query.
    expect(query).toBe('');
  });

  it('dedupes repeated terms', () => {
    const query = buildIssueSearchQuery('cache cache cache', 'cache invalidation cache');
    const terms = query.split(' ').filter(Boolean);
    const cacheCount = terms.filter((t) => t === 'cache').length;
    expect(cacheCount).toBe(1);
    expect(terms).toContain('invalidation');
  });

  it('caps the number of terms at MAX_ISSUE_SEARCH_TERMS', () => {
    // Build a body with many distinct long words.
    const words = Array.from({ length: 40 }, (_, i) => `distinctword${i}`).join(' ');
    const query = buildIssueSearchQuery('header', words);
    const terms = query.split(' ').filter(Boolean);
    expect(terms.length).toBeLessThanOrEqual(MAX_ISSUE_SEARCH_TERMS);
  });

  it('returns empty string for empty/degenerate issue text', () => {
    expect(buildIssueSearchQuery('', '')).toBe('');
    expect(buildIssueSearchQuery('   ', '\n\t  ')).toBe('');
    expect(buildIssueSearchQuery('!!! ??? ...', '--- ###')).toBe('');
  });

  it('strips punctuation from terms', () => {
    const query = buildIssueSearchQuery('Webhook(timeout)!', 'retry... handler;');
    expect(query).toContain('webhook');
    expect(query).toContain('timeout');
    expect(query).toContain('retry');
    expect(query).toContain('handler');
    expect(query).not.toMatch(/[(),.;!?]/);
  });

  it('exports MAX_ISSUE_SEARCH_TERMS as a positive number', () => {
    expect(typeof MAX_ISSUE_SEARCH_TERMS).toBe('number');
    expect(MAX_ISSUE_SEARCH_TERMS).toBeGreaterThan(0);
  });
});

// ─── Issue dedup: match + threshold ─────────────────────────────

describe('findIssueDuplicates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeRow(overrides: Partial<MemoryObservationRow> = {}): MemoryObservationRow {
    return {
      id: 42,
      type: ISSUE_TRIAGE_OBSERVATION_TYPE,
      title: 'Prior login crash',
      content: 'We fixed the login crash before.',
      filePaths: null,
      severity: null,
      ...overrides,
    };
  }

  it('exports a conservative DEDUP_SCORE_THRESHOLD in (0,1]', () => {
    expect(typeof DEDUP_SCORE_THRESHOLD).toBe('number');
    expect(DEDUP_SCORE_THRESHOLD).toBeGreaterThan(0);
    expect(DEDUP_SCORE_THRESHOLD).toBeLessThanOrEqual(1);
  });

  it('exports ISSUE_TRIAGE_OBSERVATION_TYPE as a non-empty string', () => {
    expect(typeof ISSUE_TRIAGE_OBSERVATION_TYPE).toBe('string');
    expect(ISSUE_TRIAGE_OBSERVATION_TYPE.length).toBeGreaterThan(0);
  });

  it('passes the keyword query AND the issue-triage type filter, with limit 5', async () => {
    const storage = createMockStorage();
    await findIssueDuplicates(storage, 'owner/repo', 'Login button crash', 'crashes on click');

    expect(storage.searchObservations).toHaveBeenCalledTimes(1);
    const [project, query, options] = vi.mocked(storage.searchObservations).mock.calls[0];
    expect(project).toBe('owner/repo');
    expect(query).toContain('login');
    expect(query).toContain('crash');
    // MEDIUM fix: dedup is scoped by observation type, not all memory.
    expect(options).toEqual({ limit: 5, type: ISSUE_TRIAGE_OBSERVATION_TYPE });
  });

  it('flags a STRONG keyword-overlap match (≥ threshold) as a duplicate', async () => {
    // Issue query terms: login, button, throws, typeerror, safari. The candidate
    // echoes ALL of them → overlap 1.0 ≥ threshold → duplicate.
    const storage = createMockStorage({
      searchObservations: vi.fn<MemoryStorage['searchObservations']>().mockResolvedValue([
        makeRow({
          id: 7,
          title: 'Login button throws TypeError on Safari',
          content: 'The login button throws a TypeError on Safari.',
        }),
      ]),
    });

    const result = await findIssueDuplicates(
      storage,
      'owner/repo',
      'Login button throws TypeError on Safari',
      '',
    );

    expect(result.isDuplicate).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].observationId).toBe(7);
    expect(result.matches[0].score).toBeGreaterThanOrEqual(DEDUP_SCORE_THRESHOLD);
  });

  it('REGRESSION: a WEAKLY-RELATED but recent observation is NOT flagged', async () => {
    // This is the exact false-positive the OLD code produced: it gated on decay
    // `strength` (pure recency), so a RECENT but unrelated observation (strength
    // ~1.0) was wrongly flagged a duplicate. Here the candidate is recent
    // (strength 1.0) AND has a high adapter relevanceScore, but shares only ONE
    // of the issue's many distinctive keywords → low overlap → must NOT block.
    const storage = createMockStorage({
      searchObservations: vi.fn<MemoryStorage['searchObservations']>().mockResolvedValue([
        makeRow({
          id: 8,
          title: 'Database migration timeout on deploy',
          content: 'The login link is mentioned once but this is about migrations.',
          strength: 1.0, // recently accessed — old code would have flagged this
          relevanceScore: 0.99, // even a high native score must not gate
        }),
      ]),
    });

    const result = await findIssueDuplicates(
      storage,
      'owner/repo',
      'Login button throws TypeError on Safari rendering pipeline',
      '',
    );

    expect(result.isDuplicate).toBe(false);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].score).toBeLessThan(DEDUP_SCORE_THRESHOLD);
    // relevanceScore is surfaced for observability but does NOT drive the gate.
    expect(result.matches[0].relevanceScore).toBe(0.99);
  });

  it('boundary: an overlap EXACTLY at the threshold counts as a duplicate', async () => {
    // Query has 5 distinct terms; candidate shares exactly 3 → 0.6 == threshold.
    // (alpha bravo charlie delta echo) ∩ (alpha bravo charlie) = 3/5 = 0.6.
    const storage = createMockStorage({
      searchObservations: vi.fn<MemoryStorage['searchObservations']>().mockResolvedValue([
        makeRow({
          id: 11,
          title: 'alpha bravo charlie',
          content: 'alpha bravo charlie only',
        }),
      ]),
    });

    const result = await findIssueDuplicates(
      storage,
      'owner/repo',
      'alpha bravo charlie delta echo',
      '',
    );

    expect(result.matches[0].score).toBeCloseTo(DEDUP_SCORE_THRESHOLD, 10);
    expect(result.isDuplicate).toBe(true); // gate is `>= threshold`
  });

  it('returns no matches and no duplicate when storage finds nothing', async () => {
    const storage = createMockStorage();
    const result = await findIssueDuplicates(
      storage,
      'owner/repo',
      'Brand new issue',
      'never seen',
    );

    expect(result.matches).toEqual([]);
    expect(result.isDuplicate).toBe(false);
  });

  it('surfaces the adapter relevanceScore but never gates on it', async () => {
    const storage = createMockStorage({
      searchObservations: vi.fn<MemoryStorage['searchObservations']>().mockResolvedValue([
        makeRow({
          id: 12,
          title: 'cache invalidation bug',
          content: 'cache invalidation race',
          relevanceScore: 0.42,
        }),
      ]),
    });

    const result = await findIssueDuplicates(
      storage,
      'owner/repo',
      'cache invalidation race condition',
      '',
    );

    expect(result.matches[0].relevanceScore).toBe(0.42);
  });

  it('skips the search and returns empty when issue text is degenerate', async () => {
    const storage = createMockStorage();
    const result = await findIssueDuplicates(storage, 'owner/repo', '!!!', '   ');

    expect(storage.searchObservations).not.toHaveBeenCalled();
    expect(result.query).toBe('');
    expect(result.matches).toEqual([]);
    expect(result.isDuplicate).toBe(false);
  });

  it('returns null storage gracefully (no throw, no duplicate)', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const result = await findIssueDuplicates(null as any, 'owner/repo', 'Login crash', 'crashes');
    expect(result.matches).toEqual([]);
    expect(result.isDuplicate).toBe(false);
  });

  it('degrades gracefully when searchObservations throws', async () => {
    const storage = createMockStorage({
      searchObservations: vi
        .fn<MemoryStorage['searchObservations']>()
        .mockRejectedValue(new Error('db down')),
    });

    const result = await findIssueDuplicates(storage, 'owner/repo', 'Login crash', 'crashes');
    expect(result.matches).toEqual([]);
    expect(result.isDuplicate).toBe(false);
  });

  it('handles a candidate with empty text gracefully (overlap 0, never a dup)', async () => {
    const storage = createMockStorage({
      searchObservations: vi
        .fn<MemoryStorage['searchObservations']>()
        .mockResolvedValue([makeRow({ id: 13, title: '', content: '' })]),
    });

    const result = await findIssueDuplicates(storage, 'owner/repo', 'Login crash bug', 'crashes');

    expect(result.matches[0].score).toBe(0);
    expect(result.isDuplicate).toBe(false);
  });

  it('orders matches by keyword overlap descending and flags the strong TOP', async () => {
    // Issue terms: login, crash, rendering, pipeline.
    const storage = createMockStorage({
      searchObservations: vi.fn<MemoryStorage['searchObservations']>().mockResolvedValue([
        // shares 1/4 → 0.25 (weak)
        makeRow({ id: 1, title: 'weak', content: 'login only mentioned here' }),
        // shares 4/4 → 1.0 (strong)
        makeRow({
          id: 2,
          title: 'login crash in rendering pipeline',
          content: 'login crash rendering pipeline',
        }),
      ]),
    });

    const result = await findIssueDuplicates(
      storage,
      'owner/repo',
      'login crash rendering pipeline',
      '',
    );

    expect(result.matches.map((m) => m.observationId)).toEqual([2, 1]);
    expect(result.isDuplicate).toBe(true);
  });
});
