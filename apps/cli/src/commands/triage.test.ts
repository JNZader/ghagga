/**
 * `ghagga triage` command tests — arg parsing dispatches to the right
 * engine function. The engine and config-loading modules are mocked; this
 * file verifies WIRING only (the engine itself is tested in
 * packages/triage-engine).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────

const mockTriageIssue = vi.fn();
const mockTriageNew = vi.fn();
const mockListQueue = vi.fn();
const mockShowDraft = vi.fn();
const mockEditDraft = vi.fn();
const mockApproveIssue = vi.fn();
const mockRejectIssue = vi.fn();
const mockStartTriageServer = vi.fn();
const mockLoadConfig = vi.fn();
const mockResolveConfigPath = vi.fn();
const mockMemoryCreate = vi.fn();

vi.mock('ghagga-triage-engine', () => ({
  triageIssue: (...args: unknown[]) => mockTriageIssue(...args),
  triageNew: (...args: unknown[]) => mockTriageNew(...args),
  listQueue: (...args: unknown[]) => mockListQueue(...args),
  showDraft: (...args: unknown[]) => mockShowDraft(...args),
  editDraft: (...args: unknown[]) => mockEditDraft(...args),
  approveIssue: (...args: unknown[]) => mockApproveIssue(...args),
  rejectIssue: (...args: unknown[]) => mockRejectIssue(...args),
  startTriageServer: (...args: unknown[]) => mockStartTriageServer(...args),
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  resolveConfigPath: (...args: unknown[]) => mockResolveConfigPath(...args),
}));

vi.mock('ghagga-core', () => ({
  createCLIBridgeGenerateFn: vi.fn(() => vi.fn()),
  SqliteMemoryStorage: { create: (...args: unknown[]) => mockMemoryCreate(...args) },
}));

vi.mock('../lib/embedding.js', () => ({
  resolveCliEmbeddingProvider: () => ({ config: {}, provider: undefined }),
}));

vi.mock('../ui/tui.js', () => ({
  log: {
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
  },
}));

const BASE_CONFIG = {
  forge: 'gitlab' as const,
  repo: 'acme/widgets',
  codeRoot: '/tmp/repo',
  language: 'go' as const,
  graphExpand: false,
  models: { rerank: 'r-model', analysis: 'a-model' },
};

/** Restore a saved env var: re-set it if it had a value, else remove it. */
function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = prev;
  }
}

describe('ghagga triage command', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockResolveConfigPath.mockReturnValue('/tmp/repo/.ghagga/triage.config.json');
    mockLoadConfig.mockReturnValue(BASE_CONFIG);
    // Default: memory store opens fine (in-memory WASM store faked with close()).
    mockMemoryCreate.mockResolvedValue({ close: vi.fn() });
  });

  async function loadCommand() {
    const mod = await import('./triage.js');
    return mod.triageCommand;
  }

  it('dispatches "triage <iid>" to triageIssue with the resolved config', async () => {
    mockTriageIssue.mockResolvedValue({ issueIid: '42', status: 'PENDING_APPROVAL' });
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['triage', '42'], { from: 'user' });

    expect(mockTriageIssue).toHaveBeenCalledTimes(1);
    const [options, iid] = mockTriageIssue.mock.calls[0] as [{ config: unknown }, string];
    expect(iid).toBe('42');
    expect(options.config).toEqual(BASE_CONFIG);
  });

  it('degrades to running WITHOUT dedup when triage memory fails to open (does not crash)', async () => {
    // A corrupt/unopenable memory.db must NOT crash triage — dedup is an
    // enhancement, so the command runs with memory disabled (RES-001).
    mockMemoryCreate.mockRejectedValueOnce(new Error('corrupt memory.db'));
    mockTriageIssue.mockResolvedValue({
      issueIid: '42',
      status: 'PENDING_APPROVAL',
      kind: 'ANALYSIS',
    });
    const triageCommand = await loadCommand();

    // Must resolve (no throw).
    await triageCommand.parseAsync(['triage', '42'], { from: 'user' });

    // Triage still ran, but with NO memory wired (dedup disabled).
    expect(mockTriageIssue).toHaveBeenCalledTimes(1);
    const [options] = mockTriageIssue.mock.calls[0] as [{ memory?: unknown }];
    expect(options.memory).toBeUndefined();

    const tui = await import('../ui/tui.js');
    expect(tui.log.warn).toHaveBeenCalledWith(expect.stringContaining('dedup disabled'));
  });

  it('builds the generate fns with preferredCLI from config.cli when set (codex)', async () => {
    mockLoadConfig.mockReturnValue({ ...BASE_CONFIG, cli: 'codex' });
    mockTriageIssue.mockResolvedValue({ issueIid: '42', status: 'PENDING_APPROVAL' });
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['triage', '42'], { from: 'user' });

    const { createCLIBridgeGenerateFn } = await import('ghagga-core');
    expect(createCLIBridgeGenerateFn).toHaveBeenCalledWith(
      expect.objectContaining({ preferredCLI: 'codex', cliModel: 'r-model' }),
    );
    expect(createCLIBridgeGenerateFn).toHaveBeenCalledWith(
      expect.objectContaining({ preferredCLI: 'codex', cliModel: 'a-model' }),
    );
  });

  it('defaults preferredCLI to opencode when config.cli is absent', async () => {
    mockTriageIssue.mockResolvedValue({ issueIid: '42', status: 'PENDING_APPROVAL' });
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['triage', '42'], { from: 'user' });

    const { createCLIBridgeGenerateFn } = await import('ghagga-core');
    expect(createCLIBridgeGenerateFn).toHaveBeenCalledWith(
      expect.objectContaining({ preferredCLI: 'opencode' }),
    );
  });

  it('dispatches "triage --new" to triageNew', async () => {
    mockTriageNew.mockResolvedValue([]);
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['triage', '--new'], { from: 'user' });

    expect(mockTriageNew).toHaveBeenCalledTimes(1);
    expect(mockTriageIssue).not.toHaveBeenCalled();
  });

  it('"triage <iid>" without --reproduce does NOT add reproduceGenerateFn to EngineOptions', async () => {
    mockTriageIssue.mockResolvedValue({ issueIid: '42', status: 'PENDING_APPROVAL' });
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['triage', '42'], { from: 'user' });

    const [options] = mockTriageIssue.mock.calls[0] as [{ reproduceGenerateFn?: unknown }];
    expect(options.reproduceGenerateFn).toBeUndefined();
  });

  it('"triage <iid> --reproduce" adds a reproduceGenerateFn to EngineOptions', async () => {
    mockTriageIssue.mockResolvedValue({ issueIid: '42', status: 'PENDING_APPROVAL' });
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['triage', '42', '--reproduce'], { from: 'user' });

    const [options] = mockTriageIssue.mock.calls[0] as [{ reproduceGenerateFn?: unknown }];
    expect(options.reproduceGenerateFn).toBeTypeOf('function');
  });

  it('"triage <iid> --reproduce" uses config.models.reproduce as cliModel when set', async () => {
    mockLoadConfig.mockReturnValue({
      ...BASE_CONFIG,
      models: { ...BASE_CONFIG.models, reproduce: 'configured/reproduce-model' },
    });
    mockTriageIssue.mockResolvedValue({ issueIid: '42', status: 'PENDING_APPROVAL' });
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['triage', '42', '--reproduce'], { from: 'user' });

    const { createCLIBridgeGenerateFn } = await import('ghagga-core');
    expect(createCLIBridgeGenerateFn).toHaveBeenCalledWith(
      expect.objectContaining({ cliModel: 'configured/reproduce-model' }),
    );
  });

  it('"triage <iid> --reproduce" falls back to the default model when config.models.reproduce is absent', async () => {
    mockTriageIssue.mockResolvedValue({ issueIid: '42', status: 'PENDING_APPROVAL' });
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['triage', '42', '--reproduce'], { from: 'user' });

    const { createCLIBridgeGenerateFn } = await import('ghagga-core');
    expect(createCLIBridgeGenerateFn).toHaveBeenCalledWith(
      expect.objectContaining({ cliModel: 'opencode-go/kimi-k2.7-code' }),
    );
  });

  it('"triage <iid> --reproduce" threads login credentials from env into reproduceOptions.credentials', async () => {
    const prevEmail = process.env.GHAGGA_TRIAGE_LOGIN_EMAIL;
    const prevPassword = process.env.GHAGGA_TRIAGE_LOGIN_PASSWORD;
    process.env.GHAGGA_TRIAGE_LOGIN_EMAIL = 'admin@x.test';
    process.env.GHAGGA_TRIAGE_LOGIN_PASSWORD = 's3cret';
    try {
      mockTriageIssue.mockResolvedValue({ issueIid: '42', status: 'PENDING_APPROVAL' });
      const triageCommand = await loadCommand();

      await triageCommand.parseAsync(['triage', '42', '--reproduce'], { from: 'user' });

      const [options] = mockTriageIssue.mock.calls[0] as [
        { reproduceOptions?: { credentials?: { email?: string; password?: string } } },
      ];
      expect(options.reproduceOptions?.credentials).toEqual({
        email: 'admin@x.test',
        password: 's3cret',
      });
    } finally {
      restoreEnv('GHAGGA_TRIAGE_LOGIN_EMAIL', prevEmail);
      restoreEnv('GHAGGA_TRIAGE_LOGIN_PASSWORD', prevPassword);
    }
  });

  it('"triage <iid> --reproduce" omits credentials when no login env vars are set', async () => {
    const prevEmail = process.env.GHAGGA_TRIAGE_LOGIN_EMAIL;
    const prevPassword = process.env.GHAGGA_TRIAGE_LOGIN_PASSWORD;
    delete process.env.GHAGGA_TRIAGE_LOGIN_EMAIL;
    delete process.env.GHAGGA_TRIAGE_LOGIN_PASSWORD;
    try {
      mockTriageIssue.mockResolvedValue({ issueIid: '42', status: 'PENDING_APPROVAL' });
      const triageCommand = await loadCommand();

      await triageCommand.parseAsync(['triage', '42', '--reproduce'], { from: 'user' });

      const [options] = mockTriageIssue.mock.calls[0] as [{ reproduceOptions?: unknown }];
      expect(options.reproduceOptions).toBeUndefined();
    } finally {
      restoreEnv('GHAGGA_TRIAGE_LOGIN_EMAIL', prevEmail);
      restoreEnv('GHAGGA_TRIAGE_LOGIN_PASSWORD', prevPassword);
    }
  });

  it('"triage --new --reproduce" ignores --reproduce (too slow/costly across many issues) and warns', async () => {
    mockTriageNew.mockResolvedValue([]);
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['triage', '--new', '--reproduce'], { from: 'user' });

    expect(mockTriageNew).toHaveBeenCalledTimes(1);
    const [options] = mockTriageNew.mock.calls[0] as [{ reproduceGenerateFn?: unknown }];
    expect(options.reproduceGenerateFn).toBeUndefined();

    const tui = await import('../ui/tui.js');
    expect(tui.log.warn).toHaveBeenCalledWith(expect.stringContaining('--reproduce'));
  });

  it('dispatches "list" to listQueue', async () => {
    mockListQueue.mockReturnValue({});
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['list'], { from: 'user' });

    expect(mockListQueue).toHaveBeenCalledTimes(1);
  });

  it('dispatches "show <iid>" to showDraft', async () => {
    mockShowDraft.mockReturnValue({
      issueIid: '42',
      status: 'PENDING_APPROVAL',
      report: 'r',
      clientReply: 'c',
    });
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['show', '42'], { from: 'user' });

    expect(mockShowDraft).toHaveBeenCalledWith(expect.anything(), '42');
  });

  it('dispatches "edit <iid> --reply <text>" to editDraft with the given text', async () => {
    mockEditDraft.mockReturnValue({ issueIid: '42', clientReply: 'new text' });
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['edit', '42', '--reply', 'new text'], { from: 'user' });

    expect(mockEditDraft).toHaveBeenCalledWith(expect.anything(), '42', 'new text');
  });

  it('dispatches "approve <iid>" to approveIssue and NEVER calls reject/triageIssue', async () => {
    mockApproveIssue.mockResolvedValue({ posted: true, draft: { status: 'POSTED' }, queue: {} });
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['approve', '42'], { from: 'user' });

    expect(mockApproveIssue).toHaveBeenCalledWith(expect.anything(), '42', undefined);
    expect(mockRejectIssue).not.toHaveBeenCalled();
    expect(mockTriageIssue).not.toHaveBeenCalled();
  });

  it('"approve <iid> --reply <text>" forwards the edited reply', async () => {
    mockApproveIssue.mockResolvedValue({ posted: true, draft: { status: 'POSTED' }, queue: {} });
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['approve', '42', '--reply', 'final text'], { from: 'user' });

    expect(mockApproveIssue).toHaveBeenCalledWith(expect.anything(), '42', 'final text');
  });

  it('dispatches "reject <iid>" to rejectIssue and NEVER calls approveIssue', async () => {
    mockRejectIssue.mockReturnValue({ issueIid: '42', status: 'REJECTED' });
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['reject', '42'], { from: 'user' });

    expect(mockRejectIssue).toHaveBeenCalledWith(expect.anything(), '42');
    expect(mockApproveIssue).not.toHaveBeenCalled();
  });

  it('dispatches "serve [port]" to startTriageServer with the parsed port', async () => {
    mockStartTriageServer.mockReturnValue({ close: vi.fn() });
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['serve', '5000'], { from: 'user' });

    expect(mockStartTriageServer).toHaveBeenCalledWith(expect.anything(), 5000);
  });

  it('serve with no port arg lets startTriageServer use its own default', async () => {
    mockStartTriageServer.mockReturnValue({ close: vi.fn() });
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['serve'], { from: 'user' });

    expect(mockStartTriageServer).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('resolves the config path from --config on the parent command', async () => {
    mockListQueue.mockReturnValue({});
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['--config', '/custom/path.json', 'list'], { from: 'user' });

    expect(mockResolveConfigPath).toHaveBeenCalledWith({ explicitPath: '/custom/path.json' });
    expect(mockLoadConfig).toHaveBeenCalledWith('/tmp/repo/.ghagga/triage.config.json');
  });
});
