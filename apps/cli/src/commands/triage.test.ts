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

describe('ghagga triage command', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockResolveConfigPath.mockReturnValue('/tmp/repo/.ghagga/triage.config.json');
    mockLoadConfig.mockReturnValue(BASE_CONFIG);
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

  it('dispatches "triage --new" to triageNew', async () => {
    mockTriageNew.mockResolvedValue([]);
    const triageCommand = await loadCommand();

    await triageCommand.parseAsync(['triage', '--new'], { from: 'user' });

    expect(mockTriageNew).toHaveBeenCalledTimes(1);
    expect(mockTriageIssue).not.toHaveBeenCalled();
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
