import { createFileRoute } from "@tanstack/react-router";
import { triggerJsonSchema } from "../../triggers/configuration/json-schema.js";

export const Route = createFileRoute("/api/trigger-schema.json")({
  server: {
    handlers: {
      GET: () =>
        Response.json(triggerJsonSchema(), {
          headers: { "cache-control": "public, max-age=300" },
        }),
    },
  },
});
