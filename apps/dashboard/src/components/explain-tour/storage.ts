/**
 * Per-browser memory for the /ghagga explain tour.
 *
 * This is not a repository or installation setting. Those records are shared
 * across maintainers and can be copied to global. There is no user-preferences
 * API, so a local flag keeps `explanationsEnabled` untouched.
 * An in-memory mirror covers browsers (and jsdom stubs) where localStorage
 * throws or does not persist.
 */

export const EXPLAIN_TOUR_SEEN_KEY = 'ghagga.tour.pr-explanations.seen';
export const EXPLAIN_TOUR_BANNER_KEY = 'ghagga.tour.pr-explanations.banner-dismissed';

let memorySeen = false;
let memoryBannerDismissed = false;

function readFlag(key: string, memory: boolean): boolean {
  try {
    if (window.localStorage.getItem(key) === '1') return true;
  } catch {
    return memory;
  }
  return memory;
}

function writeFlag(key: string, remember: () => void): void {
  remember();
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // The in-memory mirror already recorded the flag.
  }
}

export function readExplainTourSeen(): boolean {
  const seen = readFlag(EXPLAIN_TOUR_SEEN_KEY, memorySeen);
  if (seen) memorySeen = true;
  return seen;
}

export function writeExplainTourSeen(): void {
  writeFlag(EXPLAIN_TOUR_SEEN_KEY, () => {
    memorySeen = true;
  });
}

export function readExplainTourBannerDismissed(): boolean {
  const dismissed = readFlag(EXPLAIN_TOUR_BANNER_KEY, memoryBannerDismissed);
  if (dismissed) memoryBannerDismissed = true;
  return dismissed;
}

export function writeExplainTourBannerDismissed(): void {
  writeFlag(EXPLAIN_TOUR_BANNER_KEY, () => {
    memoryBannerDismissed = true;
  });
}

/** Test-only reset. Production code never clears a dismissal on its own. */
export function resetExplainTourStorageForTests(): void {
  memorySeen = false;
  memoryBannerDismissed = false;
  try {
    window.localStorage.removeItem(EXPLAIN_TOUR_SEEN_KEY);
    window.localStorage.removeItem(EXPLAIN_TOUR_BANNER_KEY);
  } catch {
    // The in-memory mirror is already clear.
  }
}
