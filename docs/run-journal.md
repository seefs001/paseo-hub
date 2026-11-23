# Run journal

Status: implemented for outputs, dispatches, and agent finish claims.

A trigger run's status says where the run is now. The run journal records how it got there, and it
separates what Hub observed from what an agent said.

## Sources

- **Run and step rows** (`trigger_runs`, `workflow_step_runs`): acceptance, rejection, step
  start, skip, and finish. The journal derives these entries from the rows instead of storing them
  twice.
- **`trigger_run_events`** (append-only): facts that no status column keeps.
  - `step_dispatch_requested`, `step_dispatch_recovered`: Hub is about to hand a step to a
    daemon. A recovered dispatch means the earlier handoff never reached a daemon.
  - `agent_finish_claimed`: the agent called `finish_execution`. This records only the claim. The
    step's status shows whether Hub accepted it.
  - `output_succeeded`, `output_failed`, `output_unknown`: the outcome of one output delivery
    attempt, such as a Slack reply.

Journal writes are best-effort. A failed journal write is reported and never fails the work it
describes.

## Unknown output outcomes

An output delivery can end without proof either way: a timeout, a dropped connection, a provider
5xx response, or a Hub crash while delivering. Hub records such an attempt as `unknown`, not
`failed`, because the provider may already have posted the message.

- An `unknown` attempt still counts toward the output's `max`, so a retry cannot double-post.
- A required output with an `unknown` attempt, or with a `pending` attempt whose lease expired, no
  longer blocks `finish_execution`.
- The agent is told not to resend and to report the uncertainty instead.
- If a later attempt of the same output succeeds, the uncertainty is cleared.

Hub treats provider 4xx responses, validation errors, and missing connections as definite failures,
and the agent may retry them.

## Reading a journal

`POST /api/v1/runs/journal` with `{ "triggerRunId": "..." }` and the `projects:read` scope returns
the ordered entries. It also returns `state`, which is one of the following:

- the run status, or
- `uncertain`, when the run ended and at least one output is still unconfirmed. Check the listed
  `unconfirmedOutputs` with the provider before acting again.

## Not covered

- Tool calls inside an agent. The agent's own harness owns them.
- Exactly-once delivery to providers. Hub refuses to guess, but it cannot make provider APIs
  idempotent.
