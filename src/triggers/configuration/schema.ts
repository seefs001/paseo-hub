import { RecurrenceSchema } from "../schedule/recurrence.js";
import { z } from "zod";
import { ContinuationSchema } from "../continuation.js";
import { eventDefinition, isEditorEvent } from "./events.js";
import { AuthoredGitHubAuthoritySchema } from "../../config/github-authority.js";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const WorktreeTargetSchema = z
  .discriminatedUnion("mode", [
    z.object({
      mode: z.literal("branch-off"),
      newBranch: z.string().min(1),
      base: z.string().min(1).optional(),
    }),
    z.object({ mode: z.literal("checkout-branch"), branch: z.string().min(1) }),
    z.object({ mode: z.literal("checkout-pr"), prNumber: z.number().int().positive() }),
  ])
  .meta({
    description:
      "Optional Paseo worktree for each run. branch-off creates newBranch from base; newBranch may use ${{ paseo.execution.id }} for a branch unique to each run. checkout-branch and checkout-pr reuse an existing branch or pull request.",
  });

/** A trigger or choice name: the document's own alphabet, shared with the form that writes one. */
export const IDENTIFIER = /^[a-z][a-z0-9_-]*$/u;
const EVENT_NAME = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/u;
const CONNECTION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const InputValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const DURATION_DESCRIPTION =
  "A duration: a positive integer followed by ms, s, m, or h, such as 90s or 2h. At most 24h.";

export const TriggerInputSchema = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean().optional(),
    default: InputValueSchema.optional(),
    choices: z
      .array(InputValueSchema)
      .min(1)
      .optional()
      .meta({ description: "The finite values the input accepts." }),
  })
  .strict()
  .meta({
    description:
      "A typed invocation input. The prompt reads it as ${{ paseo.inputs.<name> }}. Manual runs supply it directly; textual triggers can populate it from filters.inputs.",
  });

export const TriggerFilterSchema = z
  .object({
    pattern: z
      .string()
      .optional()
      .meta({ description: "A regular expression the event text must match." }),
    contains: z.string().optional().meta({ description: "Text the event text must contain." }),
    /** GitHub text which makes an event ineligible, such as a command another trigger owns. */
    exclude_contains: z.string().optional(),
    label: z
      .string()
      .min(1)
      .optional()
      .meta({ description: "GitHub: the label added by a label_added event." }),
    labels: z.array(z.string().min(1)).min(1).optional(),
    repo: z
      .string()
      .min(1)
      .optional()
      .meta({ description: "GitHub: the owner/name repository the event must come from." }),
    guild: z.string().min(1).optional().meta({ description: "Discord: the guild ID." }),
    workspace: z.string().min(1).optional().meta({ description: "Slack: the workspace ID." }),
    project: z.string().min(1).optional().meta({ description: "Linear: the project UUID." }),
    states: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .meta({ description: "Linear: the eligible workflow-state IDs." }),
    exclude_labels: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .meta({ description: "Linear: label IDs which make an issue ineligible." }),
    assignees: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .meta({ description: "Linear: user IDs which may be assigned to the issue." }),
    channels: z
      .array(z.string().min(1))
      .optional()
      .meta({ description: "Slack, Discord, or Telegram channel or chat IDs." }),
    /**
     * Discord: unmentioned messages continue a conversation in a thread the bot started.
     * Telegram: unaddressed messages continue a conversation in its topic or reply chain.
     */
    thread_messages: z.boolean().optional(),
    /** Reactions which start a run: a Unicode emoji, or a custom Discord emoji's name or ID. */
    emojis: z.array(z.string().min(1)).min(1).optional(),
    from_users: z.array(z.string().min(1)).optional().meta({
      description:
        'Provider user IDs or logins allowed to start a run. ["*"] allows everyone. An absent or empty list allows nobody, except on manual.run, which defaults to ["*"].',
    }),
    inputs: z
      .record(z.string(), InputValueSchema)
      .optional()
      .meta({ description: "Input values this event supplies to the run." }),
  })
  .strict()
  .meta({ description: "Conditions an event must meet to start a run." });

export const TriggerEventSchema = z
  .object({
    recurrence: RecurrenceSchema.optional().meta({
      description:
        "Required for schedule.tick and accepted only there. timezone is an IANA name, start is a local YYYY-MM-DDTHH:MM:SS, and rule is an RFC 5545 RRULE such as FREQ=DAILY;BYHOUR=9;BYMINUTE=0.",
    }),
    connection: z.string().regex(CONNECTION_SLUG).optional().meta({
      description:
        "The slug of the provider connection that receives the event. GET /api/v1/configuration-resources lists them.",
    }),
    filters: TriggerFilterSchema.optional(),
  })
  .strict();

export const TriggerAgentSchema = z
  .object({
    provider: z
      .string()
      .min(1)
      .meta({ description: "The Paseo agent provider ID on the daemon, such as claude or codex." }),
    model: z.string().min(1).optional(),
    mode: z.string().min(1).optional().meta({
      description:
        "The provider's native permission or sandbox mode. New triggers must set it explicitly.",
    }),
    thinkingOptionId: z.string().min(1).optional(),
    options: z
      .record(z.string(), z.custom<JsonValue>())
      .optional()
      .meta({ description: "Provider-native options, passed through unchanged." }),
  })
  .strict();

export const TriggerAgentSelectionSchema = z
  .union([
    TriggerAgentSchema,
    z
      .object({
        select: z.string().min(1).meta({
          description:
            "A template, such as ${{ paseo.inputs.agent }}, that must resolve from finite input choices to a key of choices.",
        }),
        choices: z.record(z.string().regex(IDENTIFIER), TriggerAgentSchema),
      })
      .strict(),
  ])
  .meta({ description: "One agent, or a finite choice of named agents selected by an input." });

export const TriggerTargetSchema = z
  .object({
    daemon: z.string().min(1).meta({
      description:
        "The daemon slug. GET /api/v1/configuration-resources lists them. The daemon must grant hub.execute.",
    }),
    cwd: z.string().min(1).meta({ description: "The absolute working directory on the daemon." }),
    worktree: WorktreeTargetSchema.optional(),
  })
  .strict();

export const TriggerOutputSchema = z
  .object({
    max: z.number().int().positive().optional(),
    required: z.boolean().optional(),
    /** Discord and Telegram replies: the agent may attach buttons; a click continues the run. */
    choices: z.boolean().optional(),
  })
  .strict()
  .meta({
    description:
      "A grant for one output tool. Conversational events already receive an unlimited <provider>.reply.",
  });

export const TriggerRunSchema = z
  .object({
    target: TriggerTargetSchema,
    agent: TriggerAgentSelectionSchema,
    continuation: ContinuationSchema.default({ mode: "conversation" }).meta({
      description:
        "Which events continue an existing agent. conversation (default) continues per provider conversation, key continues per rendered key template, and new always starts a new agent.",
    }),
    /** Workspace title template: literal text plus `${{ paseo.execution.id }}`. */
    title: z.string().min(1).optional(),
    /** Paseo workspace labels to assign to the run's workspace. */
    labels: z.array(z.string().trim().min(1)).min(1).optional(),
    prompt: z.string().min(1).meta({
      description:
        "The prompt Hub sends unchanged after rendering. Expressions: ${{ paseo.prompt }} (the complete trigger text), ${{ paseo.context }} (opt-in provider context), ${{ paseo.inputs.<name> }}, and ${{ paseo.execution.id }}.",
    }),
    max_runtime: z
      .string()
      .min(1)
      .default("2h")
      .meta({ description: `The run deadline. ${DURATION_DESCRIPTION}` }),
    idle_timeout: z
      .string()
      .min(1)
      .default("10m")
      .meta({ description: `How long the agent may stay idle. ${DURATION_DESCRIPTION}` }),
    startup_timeout: z
      .string()
      .min(1)
      .optional()
      .meta({ description: `How long the agent may take to start. ${DURATION_DESCRIPTION}` }),
    env: z
      .record(z.string().min(1), z.string())
      .optional()
      .meta({ description: "Environment variables for the agent." }),
    github: AuthoredGitHubAuthoritySchema.optional().meta({
      description:
        "A short-lived GitHub App token for the agent. connection is the GitHub connection slug; permissions maps GitHub App permission names to read, write, or admin; duration is at most 1h.",
    }),
    output: z
      .object({ schema: z.record(z.string(), z.unknown()) })
      .strict()
      .optional()
      .meta({
        description:
          "A JSON Schema for a structured result, which the agent submits as finish_execution.output.",
      }),
    outputs: z
      .record(z.string().regex(EVENT_NAME), TriggerOutputSchema)
      .optional()
      .meta({ description: "Output tool grants, keyed by output type." }),
    auto_archive: z
      .boolean()
      .default(true)
      .meta({ description: "When the run ends, archive the agent instead of interrupting it." }),
    background: z.boolean().default(false),
  })
  .strict()
  .meta({ description: "What one run executes: where, with which agent, and with which prompt." });

export const TriggerDocumentSchema = z
  .object({
    name: z.string().regex(IDENTIFIER).meta({
      description:
        "The trigger name, unique in the organization. Installing a document with an existing name replaces that trigger with a new revision.",
    }),
    enabled: z
      .boolean()
      .default(true)
      .meta({ description: "When false, the trigger is stored but receives no events." }),
    on: z.record(z.string().regex(EVENT_NAME), TriggerEventSchema).meta({
      description:
        "The events that start a run, keyed by <provider>.<event>. At least one is required.",
    }),
    inputs: z.record(z.string().regex(IDENTIFIER), TriggerInputSchema).optional(),
    /** A distinct whole-trigger deadline; new one-run triggers normally omit it. */
    max_runtime: z
      .string()
      .min(1)
      .optional()
      .meta({
        description: `A whole-trigger deadline, distinct from run.max_runtime. New triggers normally omit it. ${DURATION_DESCRIPTION}`,
      }),
    run: TriggerRunSchema,
  })
  .strict()
  .superRefine((trigger, context) => {
    for (const [event, definition] of Object.entries(trigger.on)) {
      if (event === "schedule.tick") {
        if (
          definition.recurrence === undefined ||
          definition.connection !== undefined ||
          definition.filters !== undefined
        ) {
          context.addIssue({
            code: "custom",
            path: ["on", event],
            message: "Schedule requires recurrence and does not accept connection or filters.",
          });
        }
        // A tick supplies no inputs; it runs with the declared defaults.
        for (const [name, input] of Object.entries(trigger.inputs ?? {})) {
          if (input.required !== true) continue;
          context.addIssue({
            code: "custom",
            path: ["inputs", name],
            message: "A trigger with a schedule cannot require an input; give it a default.",
          });
        }
      } else if (definition.recurrence !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["on", event, "recurrence"],
          message: "Recurrence is only supported for schedule.tick.",
        });
      }
      if (!isEditorEvent(event)) continue;
      for (const qualifier of eventDefinition(event).qualifiers) {
        const value = definition.filters?.[qualifier.key];
        if (qualifier.required && (value === undefined || value.trim().length === 0)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["on", event, "filters", qualifier.key],
            message: `${qualifier.label} is required.`,
          });
        }
      }
    }
    if (Object.keys(trigger.on).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["on"],
        message: "at least one event is required",
      });
    }
    if ("choices" in trigger.run.agent && Object.keys(trigger.run.agent.choices).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["run", "agent", "choices"],
        message: "at least one agent choice is required",
      });
    }
  });

export type TriggerDocument = z.infer<typeof TriggerDocumentSchema>;
