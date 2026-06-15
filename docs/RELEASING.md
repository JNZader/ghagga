# Releasing

This monorepo uses [Changesets](https://github.com/changesets/changesets) for
**lockstep** versioning. The three published packages always share one version:

- `ghagga-core` (`packages/core`)
- `ghagga` (`apps/cli`)
- `ghagga-db` (`packages/db`)

They are declared together in `.changeset/config.json` under `fixed`, so any
bump to one bumps all three to the same version. Private packages
(`@ghagga/server`, `@ghagga/dashboard`, `@ghagga/types`, root) are versioned too
(`privatePackages.version: true`) but are never git-tagged or published
(`privatePackages.tag: false`).

## Workflow

### 1. Record intent per change

After making a change, record what bumped and at which level:

```bash
pnpm changeset
```

Pick the bump (patch / minor / major) and write a summary. This creates a
markdown file under `.changeset/`. Commit it alongside your code change. You can
inspect pending intent at any time with `pnpm changeset status`.

### 2. Apply bumps at release time

When ready to cut a release, apply all pending changesets:

```bash
pnpm changeset version
```

This consumes the `.changeset/*.md` files, bumps `package.json` versions (all
three published packages move together), and writes/updates each `CHANGELOG.md`.

### 3. Commit the version bump

```bash
git add -A
git commit -m "chore(release): vX.Y.Z"
```

### 4. Create the GitHub Release

Create a GitHub Release pointing at the new tag (`vX.Y.Z`). The
`.github/workflows/publish.yml` workflow triggers on `release: published` and
runs `pnpm publish` in order `db → core → cli`.

> We do **not** use the Changesets GitHub Action bot. Publishing is driven
> entirely by the GitHub Release → `publish.yml` flow above.
