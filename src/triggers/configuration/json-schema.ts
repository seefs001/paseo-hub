import { z } from "zod";
import { EDITOR_EVENTS, eventDefinition } from "./events.js";
import { TriggerDocumentSchema } from "./schema.js";

const EVENT_DEFINITION = "event";

/**
 * The trigger YAML contract as JSON Schema, for editors and agents that author triggers.
 * It covers document shape only; daemon, connection, and expression checks stay in validation.
 */
export function triggerJsonSchema(): Record<string, unknown> {
  const { properties, $defs, ...schema } = z.toJSONSchema(TriggerDocumentSchema, {
    io: "input",
    unrepresentable: "any",
  });
  const on = properties?.["on"];
  if (on === undefined || typeof on === "boolean" || on.additionalProperties === undefined) {
    throw new Error("trigger JSON Schema has no event map");
  }
  const reference = { $ref: `#/$defs/${EVENT_DEFINITION}` };
  const events = Object.fromEntries(
    EDITOR_EVENTS.map((event) => {
      const definition = eventDefinition(event);
      const notes = definition.qualifiers
        .filter((qualifier) => qualifier.required)
        .map((qualifier) => `Requires filters.${qualifier.key}: ${qualifier.description}`);
      return [event, { ...reference, description: [definition.label, ...notes].join(". ") }];
    }),
  );
  return {
    ...schema,
    title: "Paseo Hub trigger",
    description:
      "One self-contained Paseo Hub trigger YAML document. Validate it with POST /api/v1/triggers/validate and install it with POST /api/v1/triggers/install.",
    properties: {
      ...properties,
      on: { ...on, properties: events, additionalProperties: reference },
    },
    $defs: { ...$defs, [EVENT_DEFINITION]: on.additionalProperties },
  };
}
