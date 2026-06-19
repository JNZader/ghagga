import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryObservationRow, MemoryStorage } from '../types.js';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('./context.js', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: mock cast
  formatMemoryContext: vi.fn((obs: any[]) => `Formatted: ${obs.length} observations`),
}));

import { formatMemoryContext } from './context.js';
import {
  buildSearchQuery,
  DEFAULT_IGNORED_SEGMENTS,
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
