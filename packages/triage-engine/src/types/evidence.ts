/**
 * ReproEvidence — the shape of evidence captured by the REPRODUCE stage
 * (implemented in a later PR) and consumed by TRIAGE as an untrusted,
 * explicitly-fenced input (see design.md decision 5).
 *
 * A non-reproduction (`reproduced: false`) is a valid, meaningful result —
 * absence of a repro is signal, not the absence of evidence.
 */

export interface NetworkFailure {
  url: string;
  status: number;
  method: string;
  body?: string;
}

export interface ReproEvidence {
  reproduced: boolean;
  steps: string[];
  consoleErrors: string[];
  netFails: NetworkFailure[];
  uiErrors: string[];
  screenshotRef?: string;
}
