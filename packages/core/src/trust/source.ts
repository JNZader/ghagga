/**
 * Which git refs GHAGGA may treat as the project's own instructions.
 *
 * A pull request head can change config, lenses, and the dependency graph.
 * Those inputs are read only from the default branch or a protected branch.
 * A fork, or an author without write permission, never contributes them,
 * even when the ref would otherwise look trusted.
 */

export interface HeadTrustInput {
  /** The change was opened from a fork of the repository. */
  isFork: boolean;
  /** The pull request author can push to the base repository. */
  authorHasWrite: boolean;
  /** The ref being read is the repository default branch. */
  refIsDefaultBranch: boolean;
  /** The ref being read is a protected branch. */
  refIsProtected: boolean;
}

/**
 * True when config, lenses, or a graph at this ref may be used.
 * A fork or an author without write is refused even if the ref is
 * the default branch of that fork.
 */
export function mayUseRepoSource(input: HeadTrustInput): boolean {
  if (input.isFork || !input.authorHasWrite) return false;
  return input.refIsDefaultBranch || input.refIsProtected;
}

export interface GraphRefInput {
  /** Default branch name from the repository, when the API returned one. */
  defaultBranch: string | undefined;
  /** `.ghagga/graph.json` exists on the default branch. */
  defaultBranchHasGraph: boolean;
  /**
   * `protected` on the `ghagga/graph` branch.
   * `null` means the branch is missing or the protection bit could not be read.
   */
  graphBranchProtected: boolean | null;
}

/**
 * Ref to read `.ghagga/graph.json` from, or null when no trusted ref has it.
 *
 * The default branch wins. The `ghagga/graph` orphan branch is used only
 * when it is protected. An unprotected orphan branch is not a trusted source:
 * anyone who can push a branch can replace the graph the review prompt reads.
 */
export function chooseGraphRef(input: GraphRefInput): string | null {
  if (input.defaultBranch && input.defaultBranchHasGraph) return input.defaultBranch;
  if (input.graphBranchProtected === true) return 'ghagga/graph';
  return null;
}
