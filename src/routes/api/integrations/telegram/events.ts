import { createFileRoute } from "@tanstack/react-router";
import { handleProviderRequest } from "../../../../server/runtime.js";

export const Route = createFileRoute("/api/integrations/telegram/events")({
  server: {
    handlers: { POST: ({ request }) => handleProviderRequest("telegram.events", request) },
  },
});
