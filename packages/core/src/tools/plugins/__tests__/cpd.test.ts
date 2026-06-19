/**
 * Tests for CPD plugin — parse function with fixture data.
 *
 * Validates that the adapted plugin produces identical output
 * to the existing hardcoded implementation.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RawToolOutput } from '../../types.js';
import { cpdPlugin, parseCpdOutput } from '../cpd.js';

// ─── Fixture Data ───────────────────────────────────────────────

const FIXTURE_PATH = join(import.meta.dirname, 'fixtures', 'cpd-output.xml');
const FIXTURE_XML = readFileSync(FIXTURE_PATH, 'utf8');

function makeRaw(stdout: string, exitCode = 0, timedOut = false): RawToolOutput {
  return { stdout, stderr: '', exitCode, timedOut };
}

// ─── Plugin Metadata ────────────────────────────────────────────

describe('cpdPlugin metadata', () => {
  it('has correct name', () => {
    expect(cpdPlugin.name).toBe('cpd');
  });

  it('has correct category', () => {
    expect(cpdPlugin.category).toBe('duplication');
  });

  it('has correct tier', () => {
    expect(cpdPlugin.tier).toBe('always-on');
  });

  it('has correct version', () => {
    expect(cpdPlugin.version).toBe('7.8.0');
  });

  it('has correct output format', () => {
    expect(cpdPlugin.outputFormat).toBe('xml');
  });

  it('has successExitCodes including 4', () => {
    expect(cpdPlugin.successExitCodes).toContain(4);
  });
});

// ─── Parse Function ─────────────────────────────────────────────

describe('parseCpdOutput', () => {
  it('parses fixture XML into 2 findings', () => {
    const findings = parseCpdOutput(makeRaw(FIXTURE_XML), '/workspace');
    expect(findings).toHaveLength(2);
  });

  it('sets severity to medium for all findings', () => {
    const findings = parseCpdOutput(makeRaw(FIXTURE_XML), '/workspace');
    for (const finding of findings) {
      expect(finding.severity).toBe('medium');
    }
  });

  it('sets category to duplication', () => {
    const findings = parseCpdOutput(makeRaw(FIXTURE_XML), '/workspace');
    for (const finding of findings) {
      expect(finding.category).toBe('duplication');
    }
  });

  it('sets source to cpd', () => {
    const findings = parseCpdOutput(makeRaw(FIXTURE_XML), '/workspace');
    for (const finding of findings) {
      expect(finding.source).toBe('cpd');
    }
  });

  it('strips repoDir prefix from file paths', () => {
    const findings = parseCpdOutput(makeRaw(FIXTURE_XML), '/workspace');
    for (const finding of findings) {
      expect(finding.file).not.toContain('/workspace/');
    }
    expect(findings[0]?.file).toBe('src/utils/validate.ts');
  });

  it('includes line numbers', () => {
    const findings = parseCpdOutput(makeRaw(FIXTURE_XML), '/workspace');
    expect(findings[0]?.line).toBe(10);
  });

  it('includes line and token counts in message', () => {
    const findings = parseCpdOutput(makeRaw(FIXTURE_XML), '/workspace');
    expect(findings[0]?.message).toContain('15 lines');
    expect(findings[0]?.message).toContain('87 tokens');
  });

  it('includes all duplicate locations in message', () => {
    const findings = parseCpdOutput(makeRaw(FIXTURE_XML), '/workspace');
    expect(findings[0]?.message).toContain('src/utils/validate.ts:10');
    expect(findings[0]?.message).toContain('src/utils/check.ts:25');
  });

  it('handles duplication with more than 2 files', () => {
    const findings = parseCpdOutput(makeRaw(FIXTURE_XML), '/workspace');
    const second = findings[1]!;
    expect(second.message).toContain('src/api/users.ts:45');
    expect(second.message).toContain('src/api/teams.ts:30');
    expect(second.message).toContain('src/api/projects.ts:60');
  });

  it('separates locations with comma-space in message', () => {
    const findings = parseCpdOutput(makeRaw(FIXTURE_XML), '/workspace');
    expect(findings[0]?.message).toContain('src/utils/validate.ts:10, src/utils/check.ts:25');
  });

  it('returns empty findings for empty pmd-cpd tag', () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<pmd-cpd>\n</pmd-cpd>';
    expect(parseCpdOutput(makeRaw(xml), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings for self-closing pmd-cpd tag', () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<pmd-cpd/>';
    expect(parseCpdOutput(makeRaw(xml), '/workspace')).toHaveLength(0);
  });

  it('ignores duplication blocks with fewer than 2 files', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<pmd-cpd>
  <duplication lines="10" tokens="50">
    <file path="/workspace/src/lonely.ts" line="5" endline="15"/>
    <codefragment><![CDATA[some code]]></codefragment>
  </duplication>
</pmd-cpd>`;
    expect(parseCpdOutput(makeRaw(xml), '/workspace')).toHaveLength(0);
  });

  it('handles exit code 4 (duplications found)', () => {
    const findings = parseCpdOutput(makeRaw(FIXTURE_XML, 4), '/workspace');
    expect(findings).toHaveLength(2);
  });

  it('returns empty findings for malformed XML', () => {
    expect(parseCpdOutput(makeRaw('not xml at all <<<>>>'), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings on timeout', () => {
    expect(parseCpdOutput(makeRaw('', 0, true), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings for empty stdout', () => {
    expect(parseCpdOutput(makeRaw(''), '/workspace')).toHaveLength(0);
  });
});
