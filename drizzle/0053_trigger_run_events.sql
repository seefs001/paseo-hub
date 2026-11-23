CREATE TABLE "trigger_run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger_run_id" uuid NOT NULL,
	"step_id" text,
	"agent_execution_id" uuid,
	"kind" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trigger_run_events" ADD CONSTRAINT "trigger_run_events_trigger_run_fk" FOREIGN KEY ("trigger_run_id") REFERENCES "public"."trigger_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trigger_run_events_run_created_idx" ON "trigger_run_events" USING btree ("trigger_run_id","created_at");