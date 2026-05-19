CREATE TABLE "github_user_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_user_id" integer NOT NULL,
	"github_login" varchar(255) NOT NULL,
	"installation_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_user_installation" UNIQUE("github_user_id","installation_id")
);
--> statement-breakpoint
CREATE TABLE "installation_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"installation_id" integer NOT NULL,
	"provider_chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_review_enabled" boolean DEFAULT true NOT NULL,
	"review_mode" varchar(20) DEFAULT 'simple' NOT NULL,
	"settings" jsonb DEFAULT '{"enableSemgrep":true,"enableTrivy":true,"enableCpd":true,"enableMemory":true,"customRules":[],"ignorePatterns":["*.md","*.txt",".gitignore","LICENSE","*.lock"],"reviewLevel":"normal","disabledTools":[]}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "installation_settings_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_installation_id" integer NOT NULL,
	"account_login" varchar(255) NOT NULL,
	"account_type" varchar(20) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "installations_github_installation_id_unique" UNIQUE("github_installation_id")
);
--> statement-breakpoint
CREATE TABLE "memory_observations" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer,
	"project" varchar(255) NOT NULL,
	"type" varchar(30) NOT NULL,
	"title" varchar(500) NOT NULL,
	"content" text NOT NULL,
	"severity" varchar(10),
	"topic_key" varchar(255),
	"file_paths" jsonb DEFAULT '[]'::jsonb,
	"content_hash" varchar(64),
	"revision_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp DEFAULT now() NOT NULL,
	"embedding" double precision[]
);
--> statement-breakpoint
CREATE TABLE "memory_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"project" varchar(255) NOT NULL,
	"pr_number" integer,
	"summary" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_repo_id" integer NOT NULL,
	"installation_id" integer NOT NULL,
	"full_name" varchar(255) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"settings" jsonb DEFAULT '{"enableSemgrep":true,"enableTrivy":true,"enableCpd":true,"enableMemory":true,"customRules":[],"ignorePatterns":["*.md","*.txt",".gitignore","LICENSE","*.lock"],"reviewLevel":"normal","disabledTools":[]}'::jsonb NOT NULL,
	"review_mode" varchar(20) DEFAULT 'simple' NOT NULL,
	"use_global_settings" boolean DEFAULT true NOT NULL,
	"provider_chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_review_enabled" boolean DEFAULT true NOT NULL,
	"encrypted_api_key" text,
	"llm_provider" varchar(50) DEFAULT 'gateway' NOT NULL,
	"llm_model" varchar(100),
	"workflow_installed_at" timestamp,
	"workflow_sha" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_github_repo_id_unique" UNIQUE("github_repo_id")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_id" integer NOT NULL,
	"pr_number" integer NOT NULL,
	"status" varchar(30) NOT NULL,
	"mode" varchar(20) NOT NULL,
	"summary" text,
	"findings" jsonb,
	"tokens_used" integer DEFAULT 0,
	"execution_time_ms" integer,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_user_mappings" ADD CONSTRAINT "github_user_mappings_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installation_settings" ADD CONSTRAINT "installation_settings_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_observations" ADD CONSTRAINT "memory_observations_session_id_memory_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."memory_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_mappings_github_user" ON "github_user_mappings" USING btree ("github_user_id");--> statement-breakpoint
CREATE INDEX "idx_observations_project" ON "memory_observations" USING btree ("project");--> statement-breakpoint
CREATE INDEX "idx_observations_topic_key" ON "memory_observations" USING btree ("topic_key");--> statement-breakpoint
CREATE INDEX "idx_observations_type" ON "memory_observations" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_observations_content_hash" ON "memory_observations" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "idx_observations_created_at" ON "memory_observations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_observations_last_accessed_at" ON "memory_observations" USING btree ("last_accessed_at");--> statement-breakpoint
CREATE INDEX "idx_memory_sessions_project" ON "memory_sessions" USING btree ("project");--> statement-breakpoint
CREATE INDEX "idx_repositories_installation" ON "repositories" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "idx_repositories_full_name" ON "repositories" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "idx_reviews_repository" ON "reviews" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "idx_reviews_created_at" ON "reviews" USING btree ("created_at");