import { z } from "zod";
import type { JsonValue } from "../config/compiler.js";
import type {
  ConversationChoiceRecord,
  Database,
  ResolveConversationChoiceResult,
} from "../db/types.js";

/** Five fits one Discord action row; Telegram has no lower limit. */
export const MAX_CHOICES = 5;
export const MAX_CHOICE_LABEL_LENGTH = 64;
const CHOICE_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const BUTTON_PREFIX = "pc";

export const choicesToolProperty = {
  type: "array",
  minItems: 1,
  maxItems: MAX_CHOICES,
  description:
    "Buttons to show under this reply. A person's click continues this conversation with the chosen label as their message. Use for a decision you need from them, such as approve or reject.",
  items: {
    type: "object",
    properties: {
      label: { type: "string", minLength: 1, maxLength: MAX_CHOICE_LABEL_LENGTH },
      style: { type: "string", enum: ["primary", "success", "danger"] },
    },
    required: ["label"],
    additionalProperties: false,
  },
} as const satisfies Record<string, JsonValue>;

export const ChoiceOptionsSchema = z
  .array(
    z.object({
      label: z.string().trim().min(1).max(MAX_CHOICE_LABEL_LENGTH),
      style: z.enum(["primary", "success", "danger"]).optional(),
    }),
  )
  .min(1)
  .max(MAX_CHOICES);

export type ChoiceOptions = z.infer<typeof ChoiceOptionsSchema>;

/** Reads the optional `choices` argument of a reply tool call. */
export function readChoiceOptions(args: Record<string, unknown>): ChoiceOptions | undefined {
  return args["choices"] === undefined ? undefined : ChoiceOptionsSchema.parse(args["choices"]);
}

/** `pc:<choice set>:<index>`: 39 bytes, inside Telegram's 64 and Discord's 100. */
export function choiceButtonId(choiceSetId: string, index: number): string {
  return `${BUTTON_PREFIX}:${choiceSetId}:${String(index)}`;
}

export function parseChoiceButtonId(
  value: string,
): { choiceSetId: string; index: number } | undefined {
  const [prefix, choiceSetId, index, ...rest] = value.split(":");
  if (prefix !== BUTTON_PREFIX || rest.length > 0 || index === undefined) return undefined;
  if (!z.uuid().safeParse(choiceSetId).success || !/^\d$/u.test(index)) return undefined;
  return { choiceSetId: choiceSetId!, index: Number(index) };
}

/** The `choice` part of a `<provider>.choice_selected` event. */
export const ChoiceSelectionSchema = z.object({
  choiceSetId: z.uuid(),
  index: z.number().int().nonnegative(),
  label: z.string(),
  triggerName: z.string(),
  projectId: z.string(),
  conversationKey: z.string(),
  user: z.object({ id: z.string(), username: z.string() }),
});

export type ChoiceSelection = z.infer<typeof ChoiceSelectionSchema>;

/**
 * Whether a compiled trigger is the one a choice set came from. The set records the trigger's
 * authored name; a document with several events compiles them to `<name>-event-<n>`.
 */
export function choiceBelongsToTrigger(compiledName: string, choice: ChoiceSelection): boolean {
  return (
    compiledName === choice.triggerName || compiledName.startsWith(`${choice.triggerName}-event-`)
  );
}

interface ChoiceOrigin {
  /** The originating trigger's `from_users`, kept so a click is authorized as a message is. */
  fromUsers: string[];
}

export interface ConversationChoices {
  /** Records a choice set before its message is sent, so the buttons can carry its id. */
  create(input: {
    agentExecutionId: string;
    provider: ConversationChoiceRecord["provider"];
    /** Absent means the one recorded in the triggering event, `<provider>.connection_id`. */
    connectionId?: string | null;
    conversationKey: string;
    options: ChoiceOptions;
  }): Promise<ConversationChoiceRecord>;
  attachMessage(choiceSetId: string, messageLocator: JsonValue): Promise<void>;
  /**
   * Resolves a click. The clicker must pass the originating trigger's `from_users`; only then
   * does the first click win. Unauthorized clicks leave the set open.
   */
  select(input: {
    provider: ConversationChoiceRecord["provider"];
    buttonId: string;
    user: { id: string; username: string };
  }): Promise<ChoiceClick>;
}

export type ChoiceClick =
  | { status: "selected"; choice: ConversationChoiceRecord; selection: ChoiceSelection }
  | { status: "alreadyAnswered"; byName: string }
  | { status: "notAllowed" }
  | { status: "unavailable" };

export function createConversationChoices(options: {
  database: Pick<
    Database,
    | "findAgentExecutionById"
    | "insertConversationChoice"
    | "setConversationChoiceMessage"
    | "findConversationChoice"
    | "resolveConversationChoice"
  >;
  now?: () => Date;
}): ConversationChoices {
  const now = options.now ?? (() => new Date());
  return {
    async create(input) {
      const execution = await options.database.findAgentExecutionById(input.agentExecutionId);
      const intent = execution?.launchIntent;
      if (execution === undefined || intent === undefined || intent === null) {
        throw new Error("choice execution unavailable");
      }
      const origin: ChoiceOrigin = {
        fromUsers: originFromUsers(intent.hubConfig, intent.triggerName, input.provider),
      };
      const connectionId =
        input.connectionId ?? eventConnectionId(execution.triggerContext, input.provider);
      if (connectionId === null) throw new Error("choice connection unavailable");
      return options.database.insertConversationChoice({
        organizationId: execution.organizationId,
        projectId: execution.projectId,
        provider: input.provider,
        connectionId,
        triggerName: intent.triggerName,
        conversationKey: input.conversationKey,
        agentExecutionId: execution.id,
        origin: { fromUsers: origin.fromUsers },
        options: input.options.map((option) =>
          option.style === undefined
            ? { label: option.label }
            : { label: option.label, style: option.style },
        ),
        expiresAt: new Date(now().getTime() + CHOICE_LIFETIME_MS),
      });
    },
    attachMessage(choiceSetId, messageLocator) {
      return options.database.setConversationChoiceMessage(choiceSetId, messageLocator);
    },
    async select(input) {
      const button = parseChoiceButtonId(input.buttonId);
      if (button === undefined) return { status: "unavailable" };
      const stored = await options.database.findConversationChoice(button.choiceSetId);
      if (
        stored === undefined ||
        stored.provider !== input.provider ||
        button.index >= stored.options.length
      ) {
        return { status: "unavailable" };
      }
      if (stored.resolvedIndex !== null) {
        return { status: "alreadyAnswered", byName: stored.resolvedByName ?? "someone" };
      }
      if (!allowed(readOrigin(stored.origin).fromUsers, input.user))
        return { status: "notAllowed" };
      const result: ResolveConversationChoiceResult =
        await options.database.resolveConversationChoice({
          id: stored.id,
          index: button.index,
          userId: input.user.id,
          userName: input.user.username,
          now: now(),
        });
      if (result.status === "unavailable") return result;
      if (result.status === "alreadyResolved") {
        return { status: "alreadyAnswered", byName: result.choice.resolvedByName ?? "someone" };
      }
      const choice = result.choice;
      return {
        status: "selected",
        choice,
        selection: {
          choiceSetId: choice.id,
          index: button.index,
          label: choice.options[button.index]!.label,
          triggerName: choice.triggerName,
          projectId: choice.projectId,
          conversationKey: choice.conversationKey,
          user: input.user,
        },
      };
    },
  };
}

/** The text that replaces the buttons once a choice is made. */
export function choiceResolutionText(choice: ConversationChoiceRecord): string {
  const label =
    choice.resolvedIndex === null ? "" : (choice.options[choice.resolvedIndex]?.label ?? "");
  return `Chosen: ${label} (by ${choice.resolvedByName ?? "someone"})`;
}

export function choiceClickNotice(click: Exclude<ChoiceClick, { status: "selected" }>): string {
  if (click.status === "alreadyAnswered") return `Already answered by ${click.byName}.`;
  if (click.status === "notAllowed") return "This trigger does not accept answers from you.";
  return "This choice is no longer available.";
}

function allowed(fromUsers: readonly string[], user: { id: string; username: string }): boolean {
  return (
    fromUsers.includes("*") || fromUsers.includes(user.id) || fromUsers.includes(user.username)
  );
}

function eventConnectionId(triggerContext: unknown, provider: string): string | null {
  const parsed = z
    .object({
      event: z.record(z.string(), z.object({ connection_id: z.string().nullable() }).loose()),
    })
    .loose()
    .safeParse(triggerContext);
  return parsed.success ? (parsed.data.event[provider]?.connection_id ?? null) : null;
}

function readOrigin(value: JsonValue): ChoiceOrigin {
  const parsed = z.object({ fromUsers: z.array(z.string()) }).safeParse(value);
  return parsed.success ? parsed.data : { fromUsers: [] };
}

function originFromUsers(hubConfig: unknown, triggerName: string, provider: string): string[] {
  const parsed = z
    .object({
      triggers: z.array(
        z
          .object({
            name: z.string(),
            on: z.string(),
            filters: z
              .object({ from_users: z.array(z.string()).optional() })
              .loose()
              .optional(),
          })
          .loose(),
      ),
    })
    .loose()
    .safeParse(hubConfig);
  if (!parsed.success) return [];
  return [
    ...new Set(
      parsed.data.triggers
        .filter(
          (trigger) =>
            (trigger.name === triggerName || trigger.name.startsWith(`${triggerName}-event-`)) &&
            trigger.on.startsWith(`${provider}.`),
        )
        .flatMap((trigger) => trigger.filters?.from_users ?? []),
    ),
  ];
}
