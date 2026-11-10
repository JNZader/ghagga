CREATE TABLE "digests" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_id" integer NOT NULL,
	"run_at" timestamp DEFAULT now() NOT NULL,
	"status" varchar(20) NOT NULL,
	"issue_number" integer,
	"issue_open" boolean DEFAULT false NOT NULL,
	"watermark" timestamp,
	"findings_count" integer DEFAULT 0 NOT NULL,
	"score" integer,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_digests_status" CHECK ("digests"."status" IN ('POSTED', 'SKIPPED', 'FAILED'))
);
--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_digests_repository" ON "digests" USING btree ("repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_digests_open_issue" ON "digests" USING btree ("repository_id") WHERE "digests"."issue_open" = true;