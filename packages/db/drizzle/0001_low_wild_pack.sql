CREATE TABLE "issue_drafts" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_id" integer NOT NULL,
	"issue_number" integer NOT NULL,
	"issue_title" varchar(500) NOT NULL,
	"status" varchar(20) NOT NULL,
	"draft_kind" varchar(20) NOT NULL,
	"body" text NOT NULL,
	"sources" jsonb,
	"dedup_matches" jsonb,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"posted_comment_id" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_issue_drafts_status" CHECK ("issue_drafts"."status" IN ('DRAFT', 'APPROVED', 'REJECTED', 'POSTED')),
	CONSTRAINT "chk_issue_drafts_draft_kind" CHECK ("issue_drafts"."draft_kind" IN ('ANALYSIS', 'DUPLICATE', 'NEEDS_INFO'))
);
--> statement-breakpoint
ALTER TABLE "issue_drafts" ADD CONSTRAINT "issue_drafts_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_issue_drafts_repository" ON "issue_drafts" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "idx_issue_drafts_status" ON "issue_drafts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_issue_drafts_open_draft" ON "issue_drafts" USING btree ("repository_id","issue_number") WHERE "issue_drafts"."status" = 'DRAFT';