CREATE TABLE "conversation_choices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"trigger_name" text NOT NULL,
	"conversation_key" text NOT NULL,
	"agent_execution_id" uuid NOT NULL,
	"message_locator" jsonb NOT NULL,
	"origin" jsonb NOT NULL,
	"options" jsonb NOT NULL,
	"resolved_index" integer,
	"resolved_by_user_id" text,
	"resolved_by_name" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "conversation_choices_provider_check" CHECK ("conversation_choices"."provider" in ('discord', 'telegram'))
);
--> statement-breakpoint
CREATE TABLE "telegram_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"chat_type" text NOT NULL,
	"chat_title" text NOT NULL,
	"provider_application_id" text,
	"slug" text NOT NULL,
	"connected_by_user_id" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_connections_chat_id_unique" UNIQUE("chat_id"),
	CONSTRAINT "telegram_connections_chat_type_check" CHECK ("telegram_connections"."chat_type" in ('private', 'group', 'supergroup'))
);
--> statement-breakpoint
CREATE TABLE "telegram_messages" (
	"connection_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" bigint NOT NULL,
	"conversation_id" text NOT NULL,
	"topic_id" bigint,
	"reply_to_message_id" bigint,
	"author_id" text NOT NULL,
	"author_username" text NOT NULL,
	"from_bot" boolean NOT NULL,
	"text" text NOT NULL,
	"attachments" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "telegram_messages_chat_id_message_id_pk" PRIMARY KEY("chat_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "attachment_capabilities" DROP CONSTRAINT "attachment_capabilities_provider_check";--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" DROP CONSTRAINT "organization_connection_attempts_provider_check";--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" DROP CONSTRAINT "organization_connection_attempts_phase_check";--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" DROP CONSTRAINT "organization_connection_attempts_shape_check";--> statement-breakpoint
ALTER TABLE "project_trigger_routes" DROP CONSTRAINT "project_trigger_routes_provider_check";--> statement-breakpoint
ALTER TABLE "provider_event_receipts" DROP CONSTRAINT "provider_event_receipts_provider_check";--> statement-breakpoint
ALTER TABLE "runtime_provider_activation" DROP CONSTRAINT "runtime_provider_activation_provider_check";--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" DROP CONSTRAINT "runtime_provider_configuration_provider_check";--> statement-breakpoint
ALTER TABLE "conversation_choices" ADD CONSTRAINT "conversation_choices_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_choices" ADD CONSTRAINT "conversation_choices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_connections" ADD CONSTRAINT "telegram_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_connections" ADD CONSTRAINT "telegram_connections_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_connection_id_telegram_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."telegram_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_choices_expiry_idx" ON "conversation_choices" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_connections_id_organization_unique" ON "telegram_connections" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_connections_organization_slug_unique" ON "telegram_connections" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "telegram_messages_conversation_idx" ON "telegram_messages" USING btree ("chat_id","conversation_id","message_id");--> statement-breakpoint
CREATE INDEX "telegram_messages_created_idx" ON "telegram_messages" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "attachment_capabilities" ADD CONSTRAINT "attachment_capabilities_provider_check" CHECK ("attachment_capabilities"."provider" in ('slack', 'discord', 'telegram'));--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" ADD CONSTRAINT "organization_connection_attempts_provider_check" CHECK ("organization_connection_attempts"."provider" in ('github', 'discord', 'slack', 'linear', 'telegram'));--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" ADD CONSTRAINT "organization_connection_attempts_phase_check" CHECK ("organization_connection_attempts"."phase" in ('github_setup', 'github_user_authorization', 'discord_authorization', 'slack_authorization', 'linear_authorization', 'telegram_authorization'));--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" ADD CONSTRAINT "organization_connection_attempts_shape_check" CHECK (("organization_connection_attempts"."phase" = 'github_setup' and "organization_connection_attempts"."provider" = 'github' and "organization_connection_attempts"."candidate_external_id" is null and "organization_connection_attempts"."pkce_verifier" is null)
        or ("organization_connection_attempts"."phase" = 'github_user_authorization' and "organization_connection_attempts"."provider" = 'github' and "organization_connection_attempts"."candidate_external_id" is not null and ("organization_connection_attempts"."pkce_verifier" is not null or "organization_connection_attempts"."consumed_at" is not null))
        or ("organization_connection_attempts"."phase" = 'discord_authorization' and "organization_connection_attempts"."provider" = 'discord' and "organization_connection_attempts"."candidate_external_id" is null and "organization_connection_attempts"."pkce_verifier" is null)
        or ("organization_connection_attempts"."phase" = 'slack_authorization' and "organization_connection_attempts"."provider" = 'slack' and "organization_connection_attempts"."candidate_external_id" is null and "organization_connection_attempts"."pkce_verifier" is null)
        or ("organization_connection_attempts"."phase" = 'linear_authorization' and "organization_connection_attempts"."provider" = 'linear' and "organization_connection_attempts"."candidate_external_id" is null and "organization_connection_attempts"."pkce_verifier" is null)
        or ("organization_connection_attempts"."phase" = 'telegram_authorization' and "organization_connection_attempts"."provider" = 'telegram' and "organization_connection_attempts"."candidate_external_id" is null and "organization_connection_attempts"."pkce_verifier" is null));--> statement-breakpoint
ALTER TABLE "project_trigger_routes" ADD CONSTRAINT "project_trigger_routes_provider_check" CHECK ("project_trigger_routes"."provider" in ('github', 'slack', 'discord', 'linear', 'telegram'));--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD CONSTRAINT "provider_event_receipts_provider_check" CHECK ("provider_event_receipts"."provider" in ('github', 'slack', 'discord', 'linear', 'telegram', 'manual', 'schedule'));--> statement-breakpoint
ALTER TABLE "runtime_provider_activation" ADD CONSTRAINT "runtime_provider_activation_provider_check" CHECK ("runtime_provider_activation"."provider" in ('github', 'slack', 'discord', 'linear', 'telegram'));--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" ADD CONSTRAINT "runtime_provider_configuration_provider_check" CHECK ("runtime_provider_configuration"."provider" in ('github', 'slack', 'discord', 'linear', 'telegram'));