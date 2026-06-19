/**
 * Parsing integration tests — validate fixture files against real tool output formats.
 *
 * These tests read actual fixture files from disk (no mocks) and verify that:
 * 1. Each fixture is valid and parseable
 * 2. The parsed structures match what the tool modules expect
 * 3. Field values, counts, and types are correct
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- Semgrep fixture ----------

describe('Semgrep fixture parsing', () => {
  const raw = readFileSync(resolve(__dirname, 'semgrep-output.json'), 'utf-8');
  const data = JSON.parse(raw);

  it('has a results array', () => {
    expect(Array.isArray(data.results)).toBe(true);
  });

  it('contains 3 findings', () => {
    expect(data.results).toHaveLength(3);
  });

  it('each result has the required fields (path, start.line, extra.severity, extra.message)', () => {
    for (const r of data.results) {
      expect(r).toHaveProperty('path');
      expect(r).toHaveProperty('start.line');
      expect(r).toHaveProperty('extra.severity');
      expect(r).toHaveProperty('extra.message');
      expect(typeof r.path).toBe('string');
      expect(typeof r.start.line).toBe('number');
      expect(typeof r.extra.severity).toBe('string');
      expect(typeof r.extra.message).toBe('string');
    }
  });

  it('contains all expected severities', () => {
    const severities = data.results.map((r: { extra: { severity: string } }) => r.extra.severity);
    expect(severities).toContain('ERROR');
    expect(severities).toContain('WARNING');
    expect(severities).toContain('INFO');
  });

  it('produces correct ReviewFinding fields when parsed like executeSemgrep', () => {
    const repoDir = '/workspace';
    const findings = data.results.map(
      (r: {
        path: string;
        start: { line: number };
        extra: { severity: string; message: string };
      }) => ({
        file: r.path.replace(`${repoDir}/`, ''),
        line: r.start.line,
        severity: r.extra.severity,
        message: r.extra.message,
      }),
    );

    expect(findings[0].file).toBe('src/auth/login.ts');
    expect(findings[0].line).toBe(42);
    expect(findings[1].file).toBe('src/api/render.ts');
    expect(findings[2].file).toBe('src/utils/helpers.ts');
  });
});

// ---------- Trivy fixture ----------

describe('Trivy fixture parsing', () => {
  const raw = readFileSync(resolve(__dirname, 'trivy-output.json'), 'utf-8');
  const data = JSON.parse(raw);

  it('has a Results array', () => {
    expect(Array.isArray(data.Results)).toBe(true);
  });

  it('contains 2 targets', () => {
    expect(data.Results).toHaveLength(2);
  });

  it('first target has 3 vulnerabilities', () => {
    expect(data.Results[0].Vulnerabilities).toHaveLength(3);
  });

  it('each vulnerability has required fields', () => {
    for (const target of data.Results) {
      for (const vuln of target.Vulnerabilities ?? []) {
        expect(vuln).toHaveProperty('VulnerabilityID');
        expect(vuln).toHaveProperty('PkgName');
        expect(vuln).toHaveProperty('InstalledVersion');
        expect(vuln).toHaveProperty('Severity');
        expect(typeof vuln.VulnerabilityID).toBe('string');
        expect(typeof vuln.PkgName).toBe('string');
      }
    }
  });

  it('contains all expected severities', () => {
    const severities = data.Results.flatMap(
      (t: { Vulnerabilities?: Array<{ Severity: string }> }) =>
        (t.Vulnerabilities ?? []).map((v) => v.Severity),
    );
    expect(severities).toContain('CRITICAL');
    expect(severities).toContain('HIGH');
    expect(severities).toContain('MEDIUM');
  });

  it('one vulnerability has no FixedVersion (no fix available)', () => {
    const allVulns = data.Results.flatMap(
      (t: { Vulnerabilities?: Array<{ FixedVersion?: string }> }) => t.Vulnerabilities ?? [],
    );
    const noFix = allVulns.filter((v: { FixedVersion?: string }) => !v.FixedVersion);
    expect(noFix.length).toBeGreaterThanOrEqual(1);
  });

  it('produces correct message format when parsed like executeTrivy', () => {
    const vuln = data.Results[0].Vulnerabilities[0];
    const fixInfo = vuln.FixedVersion
      ? ` (fix: upgrade to ${vuln.FixedVersion})`
      : ' (no fix available)';
    const message = `${vuln.VulnerabilityID}: ${vuln.PkgName}@${vuln.InstalledVersion} - ${vuln.Title ?? vuln.Description ?? 'Known vulnerability'}${fixInfo}`;

    expect(message).toContain('CVE-2024-48930');
    expect(message).toContain('express@4.18.2');
    expect(message).toContain('fix: upgrade to 4.21.2');
  });
});

// ---------- CPD fixture ----------

describe('CPD fixture parsing', () => {
  const raw = readFileSync(resolve(__dirname, 'cpd-output.xml'), 'utf-8');

  it('is valid XML with pmd-cpd root', () => {
    expect(raw).toContain('<pmd-cpd>');
    expect(raw).toContain('</pmd-cpd>');
  });

  it('parses duplications with the same regex the code uses', () => {
    const dupRegex = /<duplication lines="(\d+)" tokens="(\d+)">([\s\S]*?)<\/duplication>/g;
    const fileRegex = /<file\s+path="([^"]+)"\s+line="(\d+)"/g;

    const duplications: Array<{
      lines: number;
      tokens: number;
      files: Array<{ path: string; line: number }>;
    }> = [];

    let dupMatch: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration pattern
    while ((dupMatch = dupRegex.exec(raw)) !== null) {
      const lines = parseInt(dupMatch[1]!, 10);
      const tokens = parseInt(dupMatch[2]!, 10);
      const inner = dupMatch[3]!;

      const files: Array<{ path: string; line: number }> = [];
      let fileMatch: RegExpExecArray | null;
      fileRegex.lastIndex = 0;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration pattern
      while ((fileMatch = fileRegex.exec(inner)) !== null) {
        files.push({
          path: fileMatch[1]!,
          line: parseInt(fileMatch[2]!, 10),
        });
      }
      duplications.push({ lines, tokens, files });
    }

    expect(duplications).toHaveLength(2);
  });

  it('first duplication has 2 files, 15 lines, 87 tokens', () => {
    const dupRegex = /<duplication lines="(\d+)" tokens="(\d+)">([\s\S]*?)<\/duplication>/g;
    const fileRegex = /<file\s+path="([^"]+)"\s+line="(\d+)"/g;

    const dupMatch = dupRegex.exec(raw)!;
    expect(parseInt(dupMatch[1]!, 10)).toBe(15);
    expect(parseInt(dupMatch[2]!, 10)).toBe(87);

    const files: string[] = [];
    let fileMatch: RegExpExecArray | null;
    fileRegex.lastIndex = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration pattern
    while ((fileMatch = fileRegex.exec(dupMatch[3]!)) !== null) {
      files.push(fileMatch[1]!);
    }
    expect(files).toHaveLength(2);
    expect(files[0]).toContain('validate.ts');
    expect(files[1]).toContain('check.ts');
  });

  it('second duplication has 3 files (multi-location)', () => {
    const dupRegex = /<duplication lines="(\d+)" tokens="(\d+)">([\s\S]*?)<\/duplication>/g;
    const fileRegex = /<file\s+path="([^"]+)"\s+line="(\d+)"/g;

    // Skip first match
    dupRegex.exec(raw);
    const dupMatch = dupRegex.exec(raw)!;

    const files: string[] = [];
    let fileMatch: RegExpExecArray | null;
    fileRegex.lastIndex = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration pattern
    while ((fileMatch = fileRegex.exec(dupMatch[3]!)) !== null) {
      files.push(fileMatch[1]!);
    }
    expect(files).toHaveLength(3);
    expect(files).toContain('/workspace/src/api/users.ts');
    expect(files).toContain('/workspace/src/api/teams.ts');
    expect(files).toContain('/workspace/src/api/projects.ts');
  });

  it('produces correct ReviewFinding fields with path stripping', () => {
    const basePath = '/workspace';
    const dupRegex = /<duplication lines="(\d+)" tokens="(\d+)">([\s\S]*?)<\/duplication>/g;
    const fileRegex = /<file\s+path="([^"]+)"\s+line="(\d+)"/g;

    const dupMatch = dupRegex.exec(raw)!;
    const lines = parseInt(dupMatch[1]!, 10);
    const tokens = parseInt(dupMatch[2]!, 10);
    const inner = dupMatch[3]!;

    const files: Array<{ path: string; line: number }> = [];
    let fileMatch: RegExpExecArray | null;
    fileRegex.lastIndex = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration pattern
    while ((fileMatch = fileRegex.exec(inner)) !== null) {
      files.push({
        path: fileMatch[1]?.replace(`${basePath}/`, ''),
        line: parseInt(fileMatch[2]!, 10),
      });
    }

    const locations = files.map((f) => `${f.path}:${f.line}`).join(', ');
    const message = `Duplicated code block (${lines} lines, ${tokens} tokens) found in: ${locations}`;

    expect(files[0]?.path).toBe('src/utils/validate.ts');
    expect(files[0]?.line).toBe(10);
    expect(message).toContain('15 lines');
    expect(message).toContain('87 tokens');
    expect(message).toContain('src/utils/validate.ts:10');
    expect(message).toContain('src/utils/check.ts:25');
  });
});
