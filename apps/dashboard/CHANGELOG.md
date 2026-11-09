# @ghagga/dashboard

## 3.1.5

### Patch Changes

- @ghagga/types@3.0.9

## 3.1.4

### Patch Changes

- @ghagga/types@3.0.8

## 3.1.3

### Patch Changes

- @ghagga/types@3.0.7

## 3.1.2

### Patch Changes

- Opt in to `/ghagga explain` from repository and installation settings (`explanationsEnabled`), and publish progress replies on their own channel (#445).
- a5863a9: Add a first-visit tour for the PR explanations switch on repository and installation settings (#450).
- Updated dependencies
  - @ghagga/types@3.0.6

## 3.1.1

### Patch Changes

- @ghagga/types@3.0.5

## 3.1.0

### Minor Changes

- d9f5389: Add the Issue Triage approval page to the dashboard.

  Maintainers can now review, edit, approve, or reject AI-drafted issue-triage
  replies from the dashboard before any comment is posted to GitHub. The page
  lists pending drafts, shows the (editable) draft body, dedup matches, and
  sources, and drives the PR2 approval API (`/api/issue-drafts`). Untrusted issue
  text is always rendered as plain text — never as HTML — and the transient
  `APPROVED` posting lock surfaces as "POSTING…" rather than an actionable draft.

### Patch Changes

- @ghagga/types@3.0.4

## 3.0.3

### Patch Changes

- @ghagga/types@3.0.3

## 3.0.2

### Patch Changes

- @ghagga/types@3.0.2

## 3.0.1

### Patch Changes

- @ghagga/types@3.0.1

## 2.8.2

### Patch Changes

- @ghagga/types@2.8.2
