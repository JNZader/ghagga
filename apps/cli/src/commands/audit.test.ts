/**
 * Audit command tests — provider resolution.
 *
 * Verifies the legacy-provider handling mirrors "ghagga review":
 * explicit legacy values (--provider flag / env var) are a hard error,
 * while legacy values loaded from stored config are remapped to
 * 'gateway' at read time and the audit proceeds.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  statSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const mockRunAuditReport = vi.fn();
const mockRunTools = vi.fn();

vi.mock('ghagga-core', () => ({
  DEFAULT_MODELS: {
    gateway: 'auto',
    'cli-bridge': 'auto',
    ollama: 'llama3',
  },
  createNodeExecutionContext: vi.fn().mockReturnValue({}),
  formatStaticAnalysisContext: vi.fn().mockReturnValue(''),
  initializeDefaultTools: vi.fn(),
  resolveActivatedTools: vi.fn().mockReturnValue([{ name: 'semgrep' }]),
  runAuditReport: (...args: unknown[]) => mockRunAuditReport(...args),
  runTools: (...args: unknown[]) => mockRunTools(...args),
  toolRegistry: {
    getAll: vi.fn().mockReturnValue([{ name: 'semgrep' }]),
  },
}));

vi.mock('../lib/config.js', () => ({
  getConfigDir: vi.fn().mockReturnValue('/mock-home/.config/ghagga'),
  getStoredToken: vi.fn().mockReturnValue('gho_storedtoken'),
  loadConfig: vi.fn(),
}));

vi.mock('../lib/git.js', () => ({
  resolveProjectId: vi.fn().mockReturnValue('mock/project'),
}));

vi.mock('../ui/tui.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  box: vi.fn().mockReturnValue(''),
  divider: vi.fn().mockReturnValue(''),
  log: {
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
  },
}));

vi.mock('../ui/format.js', () => ({
  formatSeverityLine: vi.fn().mockReturnValue(''),
}));

import { loadConfig } from '../lib/config.js';
import * as tui from '../ui/tui.js';
import { auditCommand } from './audit.js';

const mockLoadConfig = vi.mocked(loadConfig);

// ─── Setup ─────────────────────────────────────────────────────

const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
  throw new Error(`process.exit:${code}`);
});

beforeEach(() => {
  vi.clearAllMocks();

  mockLoadConfig.mockReturnValue({});
  mockRunTools.mockResolvedValue({});
  mockRunAuditReport.mockResolvedValue({
    status: 'completed',
    report: 'All good.',
    timestamp: '2026-06-10T00:00:00.000Z',
  });
});

// ─── Tests ─────────────────────────────────────────────────────

describe('auditCommand provider resolution', () => {
  it('explicit legacy provider (--provider flag / env var) is a hard error', async () => {
    await expect(auditCommand('.', { provider: 'github' })).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(tui.log.error).toHaveBeenCalledWith(
      expect.stringContaining("Provider 'github' is no longer supported directly"),
    );
    expect(mockRunAuditReport).not.toHaveBeenCalled();
  });

  it('stored legacy provider is remapped to gateway and the audit proceeds', async () => {
    mockLoadConfig.mockReturnValue({
      githubToken: 'gho_storedtoken',
      defaultProvider: 'github',
      defaultModel: 'gpt-4o-mini',
    });

    await auditCommand('.', {});

    // Read-time migration warned but did NOT hard-fail
    expect(tui.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Stored provider 'github' is no longer supported"),
    );
    expect(exitSpy).not.toHaveBeenCalled();
    expect(tui.log.error).not.toHaveBeenCalled();

    // The stored model belongs to the legacy provider — gateway default applies
    expect(mockRunAuditReport).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gateway',
        model: 'auto',
      }),
    );
  });

  it('explicit current provider passes through unchanged', async () => {
    await auditCommand('.', { provider: 'gateway' });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRunAuditReport).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gateway', model: 'auto' }),
    );
  });
});
