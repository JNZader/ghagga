/**
 * Dialog-aware snapshot scoping (design.md decision 7, PoC design-risk #4).
 * Modals in real component libraries (Mantine and friends) portal OUTSIDE
 * `<main>`, so a plain `main`-scoped snapshot never sees the fields of an
 * open dialog. Prefer the open `dialog`, then fall back to `main`, then
 * `body` — direct generalization of the PoC's snapshot block
 * (biogas-repro.mts).
 */

export interface SnapshotLocator {
  count(): Promise<number>;
  first(): SnapshotLocator;
  ariaSnapshot(): Promise<string>;
}

export interface SnapshotPage {
  getByRole(role: string): SnapshotLocator;
  locator(selector: string): SnapshotLocator;
}

const DEFAULT_MAX_LENGTH = 3500;

/**
 * Captures the accessibility snapshot of the most relevant scope of `page`:
 * an open dialog (if any) > `<main>` > `<body>`. Truncated to `maxLength`.
 */
export async function captureScopedSnapshot(
  page: SnapshotPage,
  maxLength = DEFAULT_MAX_LENGTH,
): Promise<string> {
  let snapshot: string;
  try {
    const dialog = page.getByRole('dialog');
    const count = await dialog.count();
    if (count > 0) {
      snapshot = `DIÁLOGO ABIERTO:\n${await dialog.first().ariaSnapshot()}`;
    } else {
      snapshot = await page.getByRole('main').ariaSnapshot();
    }
  } catch {
    snapshot = await page.locator('body').ariaSnapshot();
  }
  return snapshot.slice(0, maxLength);
}
