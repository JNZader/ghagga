/**
 * Semgrep Microservice Client
 *
 * HTTP client for the Semgrep security scanning microservice.
 * Implements graceful degradation: if the service is unavailable,
 * returns empty findings and logs a warning.
 */

import type { StaticAnalysisFinding } from './types.ts';

/** Request payload for Semgrep scan */
export interface SemgrepScanRequest {
  files: Array<{ path: string; content: string }>;
}

/** Individual finding from Semgrep service */
interface SemgrepFinding {
  rule_id: string;
  path: string;
  line: number;
  message: string;
  severity: string;
  category: string;
}

/** Response from Semgrep scan endpoint */
export interface SemgrepScanResponse {
  findings: SemgrepFinding[];
  duration_ms: number;
  files_scanned: number;
}

/** Map Semgrep severity strings to our severity type */
function mapSeverity(severity: string): StaticAnalysisFinding['severity'] {
  switch (severity.toLowerCase()) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
    default:
      return 'info';
  }
}

/**
 * Scan files using the Semgrep microservice.
 *
 * If the service is unavailable (timeout, network error, HTTP error),
 * returns an empty array and logs a warning. This ensures ghagga
 * continues its review even without security scan results.
 *
 * @param serviceUrl - Base URL of the Semgrep service (e.g., "https://semgrep.railway.app")
 * @param files - Array of file paths and their complete contents
 * @param timeoutMs - Request timeout in milliseconds (default: 10000)
 * @returns Array of static analysis findings, or empty array on failure
 */
export async function scanWithSemgrep(
  serviceUrl: string,
  files: Array<{ path: string; content: string }>,
  timeoutMs: number = 10000
): Promise<{ findings: StaticAnalysisFinding[]; serviceAvailable: boolean }> {
  if (!serviceUrl || files.length === 0) {
    return { findings: [], serviceAvailable: false };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${serviceUrl.replace(/\/$/, '')}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files } satisfies SemgrepScanRequest),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[static-analysis] Semgrep service returned ${response.status}`);
      return { findings: [], serviceAvailable: false };
    }

    const data: SemgrepScanResponse = await response.json();

    const findings: StaticAnalysisFinding[] = data.findings.map((f) => ({
      severity: mapSeverity(f.severity),
      category: f.category || 'security',
      message: f.message,
      file: f.path,
      line: f.line,
      source: 'static-analysis' as const,
      ruleId: f.rule_id,
    }));

    return { findings, serviceAvailable: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('abort')) {
      console.warn(`[static-analysis] Semgrep service timeout (${timeoutMs}ms)`);
    } else {
      console.warn(`[static-analysis] Semgrep service error: ${message}`);
    }
    return { findings: [], serviceAvailable: false };
  } finally {
    clearTimeout(timeout);
  }
}
