/**
 * Tests for Trivy plugin — parse function with fixture data.
 *
 * Validates:
 * - Vulnerability parsing matches existing behavior
 * - License parsing (new enhancement)
 * - Severity mapping
 * - Edge cases
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RawToolOutput } from '../../types.js';
import { mapTrivySeverity, parseTrivyOutput, trivyPlugin } from '../trivy.js';

// ─── Fixture Data ───────────────────────────────────────────────

const FIXTURE_PATH = join(import.meta.dirname, 'fixtures', 'trivy-output.json');
const FIXTURE_JSON = readFileSync(FIXTURE_PATH, 'utf8');

const LICENSE_FIXTURE_PATH = join(import.meta.dirname, 'fixtures', 'trivy-with-licenses.json');
const LICENSE_FIXTURE_JSON = readFileSync(LICENSE_FIXTURE_PATH, 'utf8');

function makeRaw(stdout: string, exitCode = 0, timedOut = false): RawToolOutput {
  return { stdout, stderr: '', exitCode, timedOut };
}

// ─── Plugin Metadata ────────────────────────────────────────────

describe('trivyPlugin metadata', () => {
  it('has correct name', () => {
    expect(trivyPlugin.name).toBe('trivy');
  });

  it('has correct category', () => {
    expect(trivyPlugin.category).toBe('sca');
  });

  it('has correct tier', () => {
    expect(trivyPlugin.tier).toBe('always-on');
  });

  it('has correct version', () => {
    expect(trivyPlugin.version).toBe('0.69.3');
  });

  it('has correct output format', () => {
    expect(trivyPlugin.outputFormat).toBe('json');
  });
});

// ─── Severity Mapping ───────────────────────────────────────────

describe('mapTrivySeverity', () => {
  it('maps CRITICAL to critical', () => {
    expect(mapTrivySeverity('CRITICAL')).toBe('critical');
  });

  it('maps HIGH to high', () => {
    expect(mapTrivySeverity('HIGH')).toBe('high');
  });

  it('maps MEDIUM to medium', () => {
    expect(mapTrivySeverity('MEDIUM')).toBe('medium');
  });

  it('maps LOW to low', () => {
    expect(mapTrivySeverity('LOW')).toBe('low');
  });

  it('maps unknown to info', () => {
    expect(mapTrivySeverity('UNKNOWN')).toBe('info');
  });

  it('is case-insensitive', () => {
    expect(mapTrivySeverity('critical')).toBe('critical');
    expect(mapTrivySeverity('high')).toBe('high');
  });
});

// ─── Parse Function: Vulnerabilities ────────────────────────────

describe('parseTrivyOutput (vulnerabilities)', () => {
  it('parses fixture JSON into 4 vulnerability findings', () => {
    const findings = parseTrivyOutput(makeRaw(FIXTURE_JSON), '/workspace');
    expect(findings).toHaveLength(4);
  });

  it('maps CRITICAL severity correctly', () => {
    const findings = parseTrivyOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const critical = findings.find((f) => f.message.includes('CVE-2024-48930'));
    expect(critical?.severity).toBe('critical');
  });

  it('maps HIGH severity correctly', () => {
    const findings = parseTrivyOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const high = findings.find((f) => f.message.includes('CVE-2023-26136'));
    expect(high?.severity).toBe('high');
  });

  it('maps MEDIUM severity correctly', () => {
    const findings = parseTrivyOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const medium = findings.find((f) => f.message.includes('CVE-2024-29415'));
    expect(medium?.severity).toBe('medium');
  });

  it('constructs message with CVE, package, version, and fix info', () => {
    const findings = parseTrivyOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const finding = findings[0]!;
    expect(finding.message).toContain('CVE-2024-48930');
    expect(finding.message).toContain('express@4.18.2');
    expect(finding.message).toContain('upgrade to 4.21.2');
  });

  it('shows "no fix available" when no FixedVersion', () => {
    const findings = parseTrivyOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const noFix = findings.find((f) => f.message.includes('CVE-2024-29415'));
    expect(noFix?.message).toContain('no fix available');
  });

  it('sets category to dependency-vulnerability', () => {
    const findings = parseTrivyOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const vulnFindings = findings.filter((f) => f.category === 'dependency-vulnerability');
    expect(vulnFindings.length).toBe(4);
  });

  it('sets source to trivy', () => {
    const findings = parseTrivyOutput(makeRaw(FIXTURE_JSON), '/workspace');
    for (const finding of findings) {
      expect(finding.source).toBe('trivy');
    }
  });

  it('uses Description when Title is not available', () => {
    const json = JSON.stringify({
      Results: [
        {
          Target: 'pom.xml',
          Vulnerabilities: [
            {
              VulnerabilityID: 'CVE-DESC',
              PkgName: 'spring',
              InstalledVersion: '5.0.0',
              FixedVersion: '5.0.1',
              Severity: 'MEDIUM',
              Description: 'HTTP/2 vulnerability',
            },
          ],
        },
      ],
    });
    const findings = parseTrivyOutput(makeRaw(json), '/workspace');
    expect(findings[0]?.message).toContain('HTTP/2 vulnerability');
  });

  it('uses "Known vulnerability" when neither Title nor Description', () => {
    const json = JSON.stringify({
      Results: [
        {
          Target: 'pom.xml',
          Vulnerabilities: [
            {
              VulnerabilityID: 'CVE-BARE',
              PkgName: 'spring',
              InstalledVersion: '5.0.0',
              Severity: 'HIGH',
            },
          ],
        },
      ],
    });
    const findings = parseTrivyOutput(makeRaw(json), '/workspace');
    expect(findings[0]?.message).toContain('Known vulnerability');
  });

  it('handles multiple targets', () => {
    const findings = parseTrivyOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const files = findings.map((f) => f.file);
    expect(files).toContain('package-lock.json');
    expect(files).toContain('Dockerfile');
  });
});

// ─── Parse Function: Licenses (new enhancement) ────────────────

describe('parseTrivyOutput (licenses)', () => {
  it('parses license findings alongside vulnerabilities', () => {
    const findings = parseTrivyOutput(makeRaw(LICENSE_FIXTURE_JSON), '/workspace');
    const licenseFindings = findings.filter((f) => f.category === 'license');
    expect(licenseFindings.length).toBe(2);
  });

  it('license findings have info severity', () => {
    const findings = parseTrivyOutput(makeRaw(LICENSE_FIXTURE_JSON), '/workspace');
    const licenseFindings = findings.filter((f) => f.category === 'license');
    for (const finding of licenseFindings) {
      expect(finding.severity).toBe('info');
    }
  });

  it('license finding includes package name and license type', () => {
    const findings = parseTrivyOutput(makeRaw(LICENSE_FIXTURE_JSON), '/workspace');
    const gpl = findings.find((f) => f.message.includes('GPL-3.0'));
    expect(gpl).toBeDefined();
    expect(gpl?.message).toContain('copyleft-lib');
    expect(gpl?.message).toContain('GPL-3.0');
    expect(gpl?.message).toContain('restricted');
  });

  it('license findings have source trivy', () => {
    const findings = parseTrivyOutput(makeRaw(LICENSE_FIXTURE_JSON), '/workspace');
    const licenseFindings = findings.filter((f) => f.category === 'license');
    for (const finding of licenseFindings) {
      expect(finding.source).toBe('trivy');
    }
  });

  it('total findings include both vulns and licenses', () => {
    const findings = parseTrivyOutput(makeRaw(LICENSE_FIXTURE_JSON), '/workspace');
    // 1 vulnerability + 2 licenses = 3
    expect(findings).toHaveLength(3);
  });

  it('returns zero license findings when none present', () => {
    // Regular fixture has no licenses
    const findings = parseTrivyOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const licenseFindings = findings.filter((f) => f.category === 'license');
    expect(licenseFindings).toHaveLength(0);
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────

describe('parseTrivyOutput (edge cases)', () => {
  it('returns empty findings for empty Results', () => {
    const raw = makeRaw(JSON.stringify({ Results: [] }));
    expect(parseTrivyOutput(raw, '/workspace')).toHaveLength(0);
  });

  it('returns empty findings for missing Results', () => {
    const raw = makeRaw(JSON.stringify({}));
    expect(parseTrivyOutput(raw, '/workspace')).toHaveLength(0);
  });

  it('handles null Vulnerabilities', () => {
    const raw = makeRaw(
      JSON.stringify({
        Results: [{ Target: 'file.json', Vulnerabilities: null }],
      }),
    );
    expect(parseTrivyOutput(raw, '/workspace')).toHaveLength(0);
  });

  it('returns empty findings for malformed JSON', () => {
    expect(parseTrivyOutput(makeRaw('not json {{{'), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings on timeout', () => {
    expect(parseTrivyOutput(makeRaw('', 0, true), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings for empty stdout', () => {
    expect(parseTrivyOutput(makeRaw(''), '/workspace')).toHaveLength(0);
  });
});
