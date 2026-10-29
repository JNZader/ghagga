# Releasing

This monorepo uses [Changesets](https://github.com/changesets/changesets).
Four published packages share one version:
- `ghagga-core` (`packages/core`)
- `ghagga` (`apps/cli`)
- `ghagga-db` (`packages/db`)
- `ghagga-forge` (`packages/forge`)

They are the `fixed` group in `.changeset/config.json`. A bump to any one of
them bumps all four to the same version. `ghagga-triage-engine`
(`packages/triage-engine`) is not in that group and versions on its own.

Private packages (`@ghagga/server`, `@ghagga/dashboard`, `@ghagga/types`, the
root package) are versioned (`privatePackages.version: true`) and are never
published or git-tagged (`privatePackages.tag: false`).

## Record a change

After a change that should ship, record the bump:

```bash
pnpm changeset
```

Commit the new file under `.changeset/` with the code change. `pnpm changeset status`
shows what is waiting.

Do not run `pnpm changeset version` by hand for a normal release. The Release
workflow does that on `main`.

## What runs on push to main

`.github/workflows/release.yml` runs [changesets/action](https://github.com/changesets/action)
on every push to `main`.
1. **Pending changesets.** The action opens or updates a pull request titled
   **Version Packages** from `changeset-release/main`. The PR applies
   `changeset version` (versions, changelogs, and a lockfile refresh). Merging
   it is the release.
2. **No pending changesets.** That is the push created by merging Version
   Packages. The workflow publishes any public package version that is not
   already on npm, in dependency order: `ghagga-db`, `ghagga-core`,
   `ghagga-forge`, `ghagga`, then `ghagga-triage-engine`. It then creates git
   tag `vX.Y.Z`, a GitHub Release whose body is the changelog entries, and
   moves the floating major tag `vN` to that commit.

Publishing uses the existing npm credential and provenance setup:
`secrets.NPM_TOKEN` as `NODE_AUTH_TOKEN`, `NPM_CONFIG_PROVENANCE`,
`pnpm publish --access public --no-git-checks --provenance`, and
`id-token: write` for the OIDC provenance token. No new npm secret is
required.

`vX.Y.Z` follows the fixed group (`ghagga`'s version). A run that publishes
only `ghagga-triage-engine` publishes that package to npm and does not move
`vN`.

### CI on the Version Packages pull request

The pull request is opened with the workflow's `GITHUB_TOKEN`. GitHub does
not start `pull_request` workflows for that token the way it does for a
person. It queues them until someone with write access chooses **Approve
workflows to run** on the PR. After that approval, CI runs and the required
**CI Gate** check can pass. No extra secret is required for this.

The repository setting **Settings → Actions → General → Workflow
permissions → Allow GitHub Actions to create and approve pull requests**
must be enabled. Without it, the action cannot open the Version Packages PR.

A personal access token is optional. Create one only if the approval click
should be skipped:
1. GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token.
2. Resource owner: the account that owns `JNZader/ghagga`. Repository
   access: only `JNZader/ghagga`.
3. Permissions: Contents **Read and write**, Pull requests **Read and
   write**.
4. Add the token as the Actions secret `RELEASE_GITHUB_TOKEN`
   (Settings → Secrets and variables → Actions → New repository secret).
5. In `.github/workflows/release.yml`, pass it only to the changesets
   action: `github-token: ${{ secrets.RELEASE_GITHUB_TOKEN }}`.
   Leave the checkout `persist-credentials: true` and the release step's
   `GH_TOKEN: ${{ github.token }}` as they are. The tag push and the
   GitHub Release stay on the workflow token. That token cannot wake
   `major-tag.yml`, which is why the Release job moves `vN` itself.

Until that secret exists, leave the workflow on the default `GITHUB_TOKEN`
and approve the Version Packages workflows by hand.

### Why the major tag moves inside the Release workflow

`GITHUB_TOKEN` releases do not trigger other workflows, so
`.github/workflows/major-tag.yml` does not run for a release this action
creates. `scripts/ensure-github-release.sh` moves `vN` in the same job,
using the commit of tag `vX.Y.Z` (not whatever happens to be the tip of
`main` later).

`major-tag.yml` still runs when a person publishes a GitHub Release, which
is a real `release` event. It accepts `vX.Y.Z` and `X.Y.Z` and always moves
`vN`. Re-running an old workflow run does not help if that run's event
payload still has the unprefixed tag and the old script: use **Run
workflow** on Update major version tag and pass `vX.Y.Z` or `X.Y.Z`.

## Publish to npm does not run on release

`.github/workflows/publish.yml` is manual (`workflow_dispatch`) only. It
calls the same `scripts/publish-npm.sh` helper. Use it to republish a
version that is in the checkout but missing on npm.

The helper asks the registry before publishing. A version that is already
there is skipped, and the log says so. A `pnpm publish` that exits 0 is not
enough: the job polls the registry for up to eight minutes and **fails** if
the version never appears. The 3.7.0 publish was green at 21:42 UTC while
`npm view` still returned 3.6.0; the new versions became readable a few
minutes later.

Creating the GitHub Release must not publish again, so `publish.yml` no
longer listens for `release`.

## Recovery

- **Missing npm version for the commit already on main:** Actions →
  Publish to npm → Run workflow → branch `main`. Wait until the job
  finishes (it stays running until the registry shows the version) and
  confirm with `npm view <name>@<version>`. A green run from before this
  check is not proof the version is readable yet.
- **Missing `vN` for an existing `vX.Y.Z` tag:** Actions → Update major
  version tag → Run workflow → tag `vX.Y.Z` (or `X.Y.Z`). The next push to
  `main` also repairs `vN` when the fixed-group version is already on npm
  and the `vX.Y.Z` tag exists.
