-- Add Delegated CI support: policy column on repositories + dedicated runs table.
--
-- delegated_ci_policy is a JSONB column storing the per-repo policy config
-- (enabled, profile, branch/file patterns, label triggers, cooldown).
-- It is nullable — NULL means the feature is not configured for the repo.
--
-- delegated_ci_runs tracks each delegated CI execution lifecycle
-- (approved → dispatched → running → completed/failed/timed_out).

-- 1. Add delegated_ci_policy column to repositories
ALTER TABLE "repositories"
  ADD COLUMN IF NOT EXISTS "delegated_ci_policy" jsonb;

-- 2. Create delegated_ci_runs table
CREATE TABLE IF NOT EXISTS "delegated_ci_runs" (
  "id" serial PRIMARY KEY,
  "repository_id" integer NOT NULL
    REFERENCES "public"."repositories"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  "pr_number" integer,
  "job_key" varchar(100) NOT NULL,
  "classification" varchar(30) NOT NULL,
  "state" varchar(20) NOT NULL,
  "reason_code" varchar(50),
  "reason_detail" text,
  "callback_id" varchar(100),
  "workflow_run_id" varchar(50),
  "profile" varchar(50) NOT NULL,
  "summary" text,
  "result_summary" jsonb,
  "started_at" timestamp,
  "completed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- 3. Create indexes for common query patterns
CREATE INDEX IF NOT EXISTS "idx_delegated_ci_runs_repository"
  ON "delegated_ci_runs" ("repository_id");

CREATE INDEX IF NOT EXISTS "idx_delegated_ci_runs_state"
  ON "delegated_ci_runs" ("state");

CREATE INDEX IF NOT EXISTS "idx_delegated_ci_runs_created_at"
  ON "delegated_ci_runs" ("created_at");

CREATE INDEX IF NOT EXISTS "idx_delegated_ci_runs_callback_id"
  ON "delegated_ci_runs" ("callback_id");
