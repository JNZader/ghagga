-- Add inline workflow tracking columns to repositories.
--
-- workflowInstalledAt: records when ghagga.yml was last pushed into
--   .github/workflows/ of the target repo via the Contents API.
--   NULL means the workflow has never been injected.
--
-- workflowSha: the git blob SHA returned by the Contents API after the
--   last PUT. Used to skip redundant updates when the template hasn't
--   changed (idempotent injection).
--
-- Both columns are nullable — NULL is the valid "not installed" state
-- for existing rows. No backfill needed.

ALTER TABLE "repositories"
  ADD COLUMN IF NOT EXISTS "workflow_installed_at" timestamp;

ALTER TABLE "repositories"
  ADD COLUMN IF NOT EXISTS "workflow_sha" text;
