/**
 * Tests for Lizard plugin — parse function with fixture data.
 *
 * Validates cyclomatic complexity analysis, severity mapping, and edge cases.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RawToolOutput } from '../../types.js';
import { lizardPlugin, mapComplexitySeverity, parseLizardOutput } from '../lizard.js';

// ─── Fixture Data ───────────────────────────────────────────────

const FIXTURE_PATH = join(import.meta.dirname, 'fixtures', 'lizard-output.json');
const FIXTURE_JSON = readFileSync(FIXTURE_PATH, 'utf8');

function makeRaw(stdout: string, exitCode = 0, timedOut = false): RawToolOutput {
  return { stdout, stderr: '', exitCode, timedOut };
}

// ─── Plugin Metadata ────────────────────────────────────────────

describe('lizardPlugin metadata', () => {
  it('has correct name', () => {
    expect(lizardPlugin.name).toBe('lizard');
  });

  it('has correct category', () => {
    expect(lizardPlugin.category).toBe('complexity');
  });

  it('has correct tier', () => {
    expect(lizardPlugin.tier).toBe('always-on');
  });

  it('has correct version', () => {
    expect(lizardPlugin.version).toBe('1.17.13');
  });

  it('has correct output format', () => {
    expect(lizardPlugin.outputFormat).toBe('json');
  });
});

// ─── Complexity Severity Mapping ────────────────────────────────

describe('mapComplexitySeverity', () => {
  it('returns high for CCN > 20', () => {
    expect(mapComplexitySeverity(21)).toBe('high');
    expect(mapComplexitySeverity(35)).toBe('high');
  });

  it('returns medium for CCN > 15', () => {
    expect(mapComplexitySeverity(16)).toBe('medium');
    expect(mapComplexitySeverity(20)).toBe('medium');
  });

  it('returns low for CCN > 10', () => {
    expect(mapComplexitySeverity(11)).toBe('low');
    expect(mapComplexitySeverity(15)).toBe('low');
  });

  it('returns null for CCN <= 10', () => {
    expect(mapComplexitySeverity(10)).toBeNull();
    expect(mapComplexitySeverity(5)).toBeNull();
    expect(mapComplexitySeverity(0)).toBeNull();
  });
});

// ─── Parse Function ─────────────────────────────────────────────

describe('parseLizardOutput', () => {
  it('parses fixture JSON into findings (only above threshold)', () => {
    const findings = parseLizardOutput(makeRaw(FIXTURE_JSON), '/workspace');
    // parseComplexConfig: CCN=22 (high), validateInput: CCN=16 (medium),
    // simpleHelper: CCN=3 (skip), transformAll: CCN=12 (low), megaFunction: CCN=35 (high)
    expect(findings).toHaveLength(4);
  });

  it('maps CCN > 20 to high severity', () => {
    const findings = parseLizardOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const highFinding = findings.find((f) => f.message.includes('parseComplexConfig'));
    expect(highFinding?.severity).toBe('high');
    expect(highFinding?.message).toContain('22');
  });

  it('maps CCN > 15 to medium severity', () => {
    const findings = parseLizardOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const mediumFinding = findings.find((f) => f.message.includes('validateInput'));
    expect(mediumFinding?.severity).toBe('medium');
    expect(mediumFinding?.message).toContain('16');
  });

  it('maps CCN > 10 to low severity', () => {
    const findings = parseLizardOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const lowFinding = findings.find((f) => f.message.includes('transformAll'));
    expect(lowFinding?.severity).toBe('low');
    expect(lowFinding?.message).toContain('12');
  });

  it('skips functions with CCN <= 10', () => {
    const findings = parseLizardOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const skipFinding = findings.find((f) => f.message.includes('simpleHelper'));
    expect(skipFinding).toBeUndefined();
  });

  it('sets category to complexity', () => {
    const findings = parseLizardOutput(makeRaw(FIXTURE_JSON), '/workspace');
    for (const finding of findings) {
      expect(finding.category).toBe('complexity');
    }
  });

  it('sets source to lizard', () => {
    const findings = parseLizardOutput(makeRaw(FIXTURE_JSON), '/workspace');
    for (const finding of findings) {
      expect(finding.source).toBe('lizard');
    }
  });

  it('strips repoDir prefix from file paths', () => {
    const findings = parseLizardOutput(makeRaw(FIXTURE_JSON), '/workspace');
    for (const finding of findings) {
      expect(finding.file).not.toContain('/workspace/');
    }
    expect(findings[0]?.file).toBe('src/parser.ts');
  });

  it('includes function name and CCN in message', () => {
    const findings = parseLizardOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const finding = findings[0]!;
    expect(finding.message).toContain('parseComplexConfig');
    expect(finding.message).toContain('22');
    expect(finding.message).toContain('threshold');
  });

  it('includes line numbers', () => {
    const findings = parseLizardOutput(makeRaw(FIXTURE_JSON), '/workspace');
    expect(findings[0]?.line).toBe(10);
  });

  it('returns empty findings when all functions are below threshold', () => {
    const json = JSON.stringify([
      {
        filename: '/workspace/src/simple.ts',
        function_list: [
          {
            name: 'foo',
            long_name: 'foo()',
            start_line: 1,
            cyclomatic_complexity: 5,
            nloc: 10,
            token_count: 50,
          },
        ],
      },
    ]);
    expect(parseLizardOutput(makeRaw(json), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings for empty file list', () => {
    expect(parseLizardOutput(makeRaw('[]'), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings for malformed JSON', () => {
    expect(parseLizardOutput(makeRaw('not json {{{'), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings on timeout', () => {
    expect(parseLizardOutput(makeRaw('', 0, true), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings for empty stdout', () => {
    expect(parseLizardOutput(makeRaw(''), '/workspace')).toHaveLength(0);
  });
});
