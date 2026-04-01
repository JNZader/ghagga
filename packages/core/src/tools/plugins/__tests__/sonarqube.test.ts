/**
 * Tests for SonarQube MCP plugin — parse function with fixture data.
 *
 * Validates MCP-based static analysis, severity mapping, category mapping,
 * detect function (mcpAvailable flag), and edge cases.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RawToolOutput } from '../../types.js';
import {
  isSonarQubeMcpAvailable,
  mapSonarQubeCategory,
  mapSonarQubeSeverity,
  parseSonarQubeOutput,
  setSonarQubeMcpAvailable,
  sonarqubePlugin,
} from '../sonarqube.js';

// ─── Fixture Data ───────────────────────────────────────────────

const FIXTURE_PATH = join(import.meta.dirname, 'fixtures', 'sonarqube-output.json');
const FIXTURE_JSON = readFileSync(FIXTURE_PATH, 'utf8');

function makeRaw(stdout: string, exitCode = 0, timedOut = false): RawToolOutput {
  return { stdout, stderr: '', exitCode, timedOut };
}

// ─── Plugin Metadata ────────────────────────────────────────────

describe('sonarqubePlugin metadata', () => {
  it('has correct name', () => {
    expect(sonarqubePlugin.name).toBe('sonarqube');
  });

  it('has correct display name', () => {
    expect(sonarqubePlugin.displayName).toBe('SonarQube (MCP)');
  });

  it('has correct category', () => {
    expect(sonarqubePlugin.category).toBe('quality');
  });

  it('has correct tier', () => {
    expect(sonarqubePlugin.tier).toBe('auto-detect');
  });

  it('has correct version', () => {
    expect(sonarqubePlugin.version).toBe('mcp');
  });

  it('has correct output format', () => {
    expect(sonarqubePlugin.outputFormat).toBe('json');
  });
});

// ─── Detect Function ────────────────────────────────────────────

describe('sonarqubePlugin detect', () => {
  afterEach(() => {
    setSonarQubeMcpAvailable(false);
  });

  it('does not detect when MCP is not available', () => {
    setSonarQubeMcpAvailable(false);
    expect(sonarqubePlugin.detect?.(['src/main.ts', 'README.md'])).toBe(false);
  });

  it('detects when MCP is available and files are present', () => {
    setSonarQubeMcpAvailable(true);
    expect(sonarqubePlugin.detect?.(['src/main.ts', 'README.md'])).toBe(true);
  });

  it('does not detect when MCP is available but no files', () => {
    setSonarQubeMcpAvailable(true);
    expect(sonarqubePlugin.detect?.([])).toBe(false);
  });
});

// ─── MCP Availability Flag ─────────────────────────────────────

describe('setSonarQubeMcpAvailable', () => {
  afterEach(() => {
    setSonarQubeMcpAvailable(false);
  });

  it('defaults to false', () => {
    expect(isSonarQubeMcpAvailable()).toBe(false);
  });

  it('can be set to true', () => {
    setSonarQubeMcpAvailable(true);
    expect(isSonarQubeMcpAvailable()).toBe(true);
  });

  it('can be toggled back to false', () => {
    setSonarQubeMcpAvailable(true);
    setSonarQubeMcpAvailable(false);
    expect(isSonarQubeMcpAvailable()).toBe(false);
  });
});

// ─── Severity Mapping ───────────────────────────────────────────

describe('mapSonarQubeSeverity', () => {
  it('maps BLOCKER to critical', () => {
    expect(mapSonarQubeSeverity('BLOCKER')).toBe('critical');
  });

  it('maps CRITICAL to critical', () => {
    expect(mapSonarQubeSeverity('CRITICAL')).toBe('critical');
  });

  it('maps MAJOR to high', () => {
    expect(mapSonarQubeSeverity('MAJOR')).toBe('high');
  });

  it('maps MINOR to medium', () => {
    expect(mapSonarQubeSeverity('MINOR')).toBe('medium');
  });

  it('maps INFO to low', () => {
    expect(mapSonarQubeSeverity('INFO')).toBe('low');
  });

  it('maps unknown severity to low', () => {
    expect(mapSonarQubeSeverity('UNKNOWN')).toBe('low');
  });

  it('is case-insensitive', () => {
    expect(mapSonarQubeSeverity('major')).toBe('high');
    expect(mapSonarQubeSeverity('blocker')).toBe('critical');
  });
});

// ─── Category Mapping ───────────────────────────────────────────

describe('mapSonarQubeCategory', () => {
  it('maps VULNERABILITY to security', () => {
    expect(mapSonarQubeCategory('VULNERABILITY')).toBe('security');
  });

  it('maps SECURITY_HOTSPOT to security', () => {
    expect(mapSonarQubeCategory('SECURITY_HOTSPOT')).toBe('security');
  });

  it('maps BUG to bug', () => {
    expect(mapSonarQubeCategory('BUG')).toBe('bug');
  });

  it('maps CODE_SMELL to quality', () => {
    expect(mapSonarQubeCategory('CODE_SMELL')).toBe('quality');
  });

  it('maps unknown type to quality', () => {
    expect(mapSonarQubeCategory('UNKNOWN')).toBe('quality');
  });

  it('is case-insensitive', () => {
    expect(mapSonarQubeCategory('vulnerability')).toBe('security');
    expect(mapSonarQubeCategory('bug')).toBe('bug');
  });
});

// ─── Parse Function (happy path) ────────────────────────────────

describe('parseSonarQubeOutput', () => {
  it('parses fixture JSON into 5 findings', () => {
    const findings = parseSonarQubeOutput(makeRaw(FIXTURE_JSON), '/workspace');
    expect(findings).toHaveLength(5);
  });

  it('maps BLOCKER severity to critical', () => {
    const findings = parseSonarQubeOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const blocker = findings.find((f) => f.message.includes('S3649'));
    expect(blocker?.severity).toBe('critical');
  });

  it('maps CRITICAL severity to critical', () => {
    const findings = parseSonarQubeOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const critical = findings.find((f) => f.message.includes('S5527'));
    expect(critical?.severity).toBe('critical');
  });

  it('maps MAJOR severity to high', () => {
    const findings = parseSonarQubeOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const major = findings.find((f) => f.message.includes('S1192'));
    expect(major?.severity).toBe('high');
  });

  it('maps MINOR severity to medium', () => {
    const findings = parseSonarQubeOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const minor = findings.find((f) => f.message.includes('S1854'));
    expect(minor?.severity).toBe('medium');
  });

  it('maps INFO severity to low', () => {
    const findings = parseSonarQubeOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const info = findings.find((f) => f.message.includes('S1135'));
    expect(info?.severity).toBe('low');
  });

  it('maps VULNERABILITY type to security category', () => {
    const findings = parseSonarQubeOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const vuln = findings.find((f) => f.message.includes('S3649'));
    expect(vuln?.category).toBe('security');
  });

  it('maps CODE_SMELL type to quality category', () => {
    const findings = parseSonarQubeOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const smell = findings.find((f) => f.message.includes('S1192'));
    expect(smell?.category).toBe('quality');
  });

  it('sets source to sonarqube for all findings', () => {
    const findings = parseSonarQubeOutput(makeRaw(FIXTURE_JSON), '/workspace');
    for (const finding of findings) {
      expect(finding.source).toBe('sonarqube');
    }
  });

  it('uses component as file path', () => {
    const findings = parseSonarQubeOutput(makeRaw(FIXTURE_JSON), '/workspace');
    expect(findings[0]?.file).toBe('src/main/java/com/example/App.java');
  });

  it('includes line numbers when present', () => {
    const findings = parseSonarQubeOutput(makeRaw(FIXTURE_JSON), '/workspace');
    expect(findings[0]?.line).toBe(42);
    expect(findings[1]?.line).toBe(78);
    expect(findings[2]?.line).toBe(15);
  });

  it('handles missing line numbers', () => {
    const findings = parseSonarQubeOutput(makeRaw(FIXTURE_JSON), '/workspace');
    const noLine = findings.find((f) => f.message.includes('S1135'));
    expect(noLine?.line).toBeUndefined();
  });

  it('formats message as rule: text', () => {
    const findings = parseSonarQubeOutput(makeRaw(FIXTURE_JSON), '/workspace');
    expect(findings[0]?.message).toBe(
      'java:S1192: Define a constant instead of duplicating this literal "SELECT * FROM users" 3 times.',
    );
  });
});

// ─── Parse Function (edge cases) ────────────────────────────────

describe('parseSonarQubeOutput edge cases', () => {
  it('returns empty findings for empty issues array', () => {
    const data = JSON.stringify({ issues: [] });
    expect(parseSonarQubeOutput(makeRaw(data), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings for missing issues key', () => {
    const data = JSON.stringify({ paging: { total: 0 } });
    expect(parseSonarQubeOutput(makeRaw(data), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings for malformed JSON', () => {
    expect(parseSonarQubeOutput(makeRaw('not json {{{'), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings on timeout', () => {
    expect(parseSonarQubeOutput(makeRaw('', 0, true), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings for empty stdout', () => {
    expect(parseSonarQubeOutput(makeRaw(''), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings for whitespace-only stdout', () => {
    expect(parseSonarQubeOutput(makeRaw('   '), '/workspace')).toHaveLength(0);
  });
});
