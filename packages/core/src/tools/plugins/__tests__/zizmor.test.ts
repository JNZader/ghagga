/**
 * Tests for Zizmor plugin — parse function with fixture data.
 *
 * Validates GitHub Actions security analysis, SARIF parsing,
 * severity mapping with critical elevation, detect function, and edge cases.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RawToolOutput } from '../../types.js';
import { mapZizmorSeverity, parseZizmorOutput, zizmorPlugin } from '../zizmor.js';

// ─── Fixture Data ───────────────────────────────────────────────

const FIXTURE_PATH = join(import.meta.dirname, 'fixtures', 'zizmor-output.json');
const FIXTURE_JSON = readFileSync(FIXTURE_PATH, 'utf8');

function makeRaw(stdout: string, exitCode = 0, timedOut = false): RawToolOutput {
  return { stdout, stderr: '', exitCode, timedOut };
}

// ─── Plugin Metadata ────────────────────────────────────────────

describe('zizmorPlugin metadata', () => {
  it('has correct name', () => {
    expect(zizmorPlugin.name).toBe('zizmor');
  });

  it('has correct display name', () => {
    expect(zizmorPlugin.displayName).toBe('Zizmor');
  });

  it('has correct category', () => {
    expect(zizmorPlugin.category).toBe('security');
  });

  it('has correct tier', () => {
    expect(zizmorPlugin.tier).toBe('auto-detect');
  });

  it('has correct version', () => {
    expect(zizmorPlugin.version).toBe('1.23.1');
  });

  it('has correct output format', () => {
    expect(zizmorPlugin.outputFormat).toBe('sarif');
  });
});

// ─── Detect Function ────────────────────────────────────────────

describe('zizmorPlugin detect', () => {
  it('detects .github/workflows/ci.yml', () => {
    expect(zizmorPlugin.detect?.(['.github/workflows/ci.yml', 'README.md'])).toBe(true);
  });

  it('detects .github/workflows/deploy.yaml', () => {
    expect(zizmorPlugin.detect?.(['.github/workflows/deploy.yaml'])).toBe(true);
  });

  it('detects monorepo nested workflow files', () => {
    expect(zizmorPlugin.detect?.(['apps/web/.github/workflows/test.yml'])).toBe(true);
  });

  it('does not detect .github/dependabot.yml', () => {
    expect(zizmorPlugin.detect?.(['.github/dependabot.yml'])).toBe(false);
  });

  it('does not detect action definition files', () => {
    expect(zizmorPlugin.detect?.(['.github/actions/my-action/action.yml'])).toBe(false);
  });

  it('does not detect non-workflow YAML files', () => {
    expect(zizmorPlugin.detect?.(['docker-compose.yml', 'config.yaml'])).toBe(false);
  });

  it('does not detect on empty file list', () => {
    expect(zizmorPlugin.detect?.([])).toBe(false);
  });
});

// ─── Severity Mapping ───────────────────────────────────────────

describe('mapZizmorSeverity', () => {
  it('maps error to high', () => {
    expect(mapZizmorSeverity('error')).toBe('high');
  });

  it('maps warning to medium', () => {
    expect(mapZizmorSeverity('warning')).toBe('medium');
  });

  it('maps note to info', () => {
    expect(mapZizmorSeverity('note')).toBe('info');
  });

  it('maps none to low', () => {
    expect(mapZizmorSeverity('none')).toBe('low');
  });

  it('maps unknown level to low', () => {
    expect(mapZizmorSeverity('unknown')).toBe('low');
  });

  it('elevates template-injection to critical regardless of level', () => {
    expect(mapZizmorSeverity('error', 'template-injection')).toBe('critical');
    expect(mapZizmorSeverity('warning', 'template-injection')).toBe('critical');
    expect(mapZizmorSeverity('note', 'template-injection')).toBe('critical');
  });

  it('does not elevate non-critical rules', () => {
    expect(mapZizmorSeverity('warning', 'unpinned-uses')).toBe('medium');
    expect(mapZizmorSeverity('warning', 'excessive-permissions')).toBe('medium');
    expect(mapZizmorSeverity('note', 'artipacked')).toBe('info');
  });
});

// ─── Parse Function (happy path) ────────────────────────────────

describe('parseZizmorOutput', () => {
  it('parses fixture SARIF into 4 findings', () => {
    const findings = parseZizmorOutput(makeRaw(FIXTURE_JSON), '/workspace');
    expect(findings).toHaveLength(4);
  });

  it('maps template-injection to critical severity', () => {
    const findings = parseZizmorOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const injection = findings.find((f) => f.message.includes('template-injection'));
    expect(injection?.severity).toBe('critical');
  });

  it('maps unpinned-uses warning to medium severity', () => {
    const findings = parseZizmorOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const unpinned = findings.find((f) => f.message.includes('unpinned-uses'));
    expect(unpinned?.severity).toBe('medium');
  });

  it('maps excessive-permissions warning to medium severity', () => {
    const findings = parseZizmorOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const perms = findings.find((f) => f.message.includes('excessive-permissions'));
    expect(perms?.severity).toBe('medium');
  });

  it('maps artipacked note to info severity', () => {
    const findings = parseZizmorOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const arti = findings.find((f) => f.message.includes('artipacked'));
    expect(arti?.severity).toBe('info');
  });

  it('sets category to security for all findings', () => {
    const findings = parseZizmorOutput(makeRaw(FIXTURE_JSON), '/workspace');
    for (const finding of findings) {
      expect(finding.category).toBe('security');
    }
  });

  it('sets source to zizmor for all findings', () => {
    const findings = parseZizmorOutput(makeRaw(FIXTURE_JSON), '/workspace');
    for (const finding of findings) {
      expect(finding.source).toBe('zizmor');
    }
  });

  it('strips repoDir prefix from file paths', () => {
    const findings = parseZizmorOutput(makeRaw(FIXTURE_JSON), '/workspace');
    for (const finding of findings) {
      expect(finding.file).not.toContain('/workspace/');
    }
    expect(findings[0]?.file).toBe('.github/workflows/ci.yml');
  });

  it('includes line numbers', () => {
    const findings = parseZizmorOutput(makeRaw(FIXTURE_JSON), '/workspace');
    expect(findings[0]?.line).toBe(25);
    expect(findings[1]?.line).toBe(12);
    expect(findings[2]?.line).toBe(3);
    expect(findings[3]?.line).toBe(45);
  });

  it('formats message as ruleId: text', () => {
    const findings = parseZizmorOutput(makeRaw(FIXTURE_JSON), '/workspace');
    expect(findings[0]?.message).toBe(
      'template-injection: code injection via template expansion of `github.event.issue.body` in `run:` block',
    );
  });

  it('handles multiple workflow files', () => {
    const findings = parseZizmorOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const files = new Set(findings.map((f) => f.file));
    expect(files.size).toBe(2);
    expect(files).toContain('.github/workflows/ci.yml');
    expect(files).toContain('.github/workflows/deploy.yaml');
  });
});

// ─── Parse Function (edge cases) ────────────────────────────────

describe('parseZizmorOutput edge cases', () => {
  it('returns empty findings for empty SARIF object', () => {
    expect(parseZizmorOutput(makeRaw('{}'), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings for empty results array', () => {
    const sarif = JSON.stringify({ runs: [{ results: [] }] });
    expect(parseZizmorOutput(makeRaw(sarif), '/workspace')).toHaveLength(0);
  });

  it('handles result with missing locations gracefully', () => {
    const sarif = JSON.stringify({
      runs: [
        {
          results: [
            {
              ruleId: 'test-rule',
              level: 'warning',
              message: { text: 'test message' },
            },
          ],
        },
      ],
    });
    const findings = parseZizmorOutput(makeRaw(sarif), '/workspace');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe('unknown');
    expect(findings[0]?.line).toBeUndefined();
  });

  it('handles result with missing message gracefully', () => {
    const sarif = JSON.stringify({
      runs: [
        {
          results: [
            {
              ruleId: 'test-rule',
              level: 'warning',
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: '.github/workflows/ci.yml' },
                    region: { startLine: 10 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const findings = parseZizmorOutput(makeRaw(sarif), '/workspace');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('Security issue detected');
  });

  it('returns empty findings for malformed JSON', () => {
    expect(parseZizmorOutput(makeRaw('not json {{{'), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings on timeout', () => {
    expect(parseZizmorOutput(makeRaw('', 0, true), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings for empty stdout', () => {
    expect(parseZizmorOutput(makeRaw(''), '/workspace')).toHaveLength(0);
  });
});
