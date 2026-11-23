import type { JsonValue } from "../config/compiler.js";
import type {
  Database,
  TriggerRunEventInput,
  TriggerRunEventKind,
  TriggerRunEventRecord,
  TriggerRunRecord,
  WorkflowStepRunRecord,
} from "../db/types.js";

/**
 * The run journal: what Hub can prove happened in a trigger run, in order.
 *
 * Run and step transitions come from their durable rows. Dispatches, recoveries, agent finish
 * claims, and output outcomes come from `trigger_run_events`. An agent's own account of its work
 * is never a journal fact; `agent_finish_claimed` records only that the agent said it finished.
 */
export type RunJournalEntryKind =
  | "run_accepted"
  | "run_rejected"
  | "step_started"
  | "step_skipped"
  | "step_finished"
  | "run_finished"
  | TriggerRunEventKind;

export interface RunJournalEntry {
  readonly at: string;
  readonly kind: RunJournalEntryKind;
  readonly stepId: string | null;
  readonly agentExecutionId: string | null;
  readonly data: Readonly<Record<string, JsonValue>>;
}

/**
 * The state a person needs to act on. `uncertain` means Hub finished but could not confirm at
 * least one external effect, so a human should check the provider before acting again.
 */
export type RunJournalState =
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "rejected"
  | "uncertain";

export interface RunJournal {
  readonly triggerRunId: string;
  readonly configuredTriggerName: string;
  readonly state: RunJournalState;
  readonly status: TriggerRunRecord["status"];
  /** Outputs whose delivery outcome is unknown. Check them before resending. */
  readonly unconfirmedOutputs: readonly { stepId: string | null; outputType: string }[];
  readonly entries: readonly RunJournalEntry[];
}

/** Records a journal fact without letting a journal write fail the work it describes. */
export async function recordRunEvent(
  database: Pick<Database, "appendTriggerRunEvent">,
  input: TriggerRunEventInput,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    await database.appendTriggerRunEvent(input);
  } catch (error) {
    onError(error);
  }
}

export async function readRunJournal(
  database: Pick<
    Database,
    "findTriggerRunById" | "listWorkflowStepRunsForTriggerRun" | "listTriggerRunEvents"
  >,
  organizationId: string,
  triggerRunId: string,
): Promise<RunJournal | undefined> {
  const run = await database.findTriggerRunById(triggerRunId);
  if (run === undefined || run.organizationId !== organizationId) return undefined;
  const [steps, events] = await Promise.all([
    database.listWorkflowStepRunsForTriggerRun(run.id),
    database.listTriggerRunEvents(run.id),
  ]);
  return buildRunJournal(run, steps, events);
}

export function buildRunJournal(
  run: TriggerRunRecord,
  steps: readonly WorkflowStepRunRecord[],
  events: readonly TriggerRunEventRecord[],
): RunJournal {
  const entries: (RunJournalEntry & { order: number })[] = [];
  const add = (
    at: Date,
    kind: RunJournalEntryKind,
    fields: Partial<Pick<RunJournalEntry, "stepId" | "agentExecutionId" | "data">> = {},
  ) => {
    entries.push({
      at: at.toISOString(),
      kind,
      stepId: fields.stepId ?? null,
      agentExecutionId: fields.agentExecutionId ?? null,
      data: fields.data ?? {},
      order: entries.length,
    });
  };

  if (run.outcome === "rejected") {
    add(run.createdAt, "run_rejected", { data: { code: run.rejection.code } });
  } else {
    add(run.createdAt, "run_accepted");
  }
  for (const step of steps) {
    const execution =
      step.agentExecutionId === null ? {} : { agentExecutionId: step.agentExecutionId };
    if (step.status === "skipped") {
      add(step.completedAt ?? run.createdAt, "step_skipped", {
        stepId: step.stepId,
        data: step.failureReason === null ? {} : { reason: step.failureReason },
      });
      continue;
    }
    if (step.startedAt !== null)
      add(step.startedAt, "step_started", { stepId: step.stepId, ...execution });
    if (step.completedAt !== null) {
      add(step.completedAt, "step_finished", {
        stepId: step.stepId,
        ...execution,
        data: {
          status: step.status,
          ...(step.failureReason === null ? {} : { reason: step.failureReason }),
        },
      });
    }
  }
  for (const event of events) {
    add(event.createdAt, event.kind, {
      stepId: event.stepId,
      ...(event.agentExecutionId === null ? {} : { agentExecutionId: event.agentExecutionId }),
      data: event.data,
    });
  }
  if (run.outcome === "accepted" && run.status !== "running") {
    add(run.completedAt ?? run.createdAt, "run_finished", {
      data: {
        status: run.status,
        ...(run.failureReason === null ? {} : { reason: run.failureReason }),
      },
    });
  }
  entries.sort((left, right) => left.at.localeCompare(right.at) || left.order - right.order);

  const unconfirmedOutputs = unconfirmed(events);
  return {
    triggerRunId: run.id,
    configuredTriggerName: run.configuredTriggerName,
    status: run.status,
    state:
      run.status !== "running" && run.status !== "rejected" && unconfirmedOutputs.length > 0
        ? "uncertain"
        : run.status,
    unconfirmedOutputs,
    entries: entries.map(({ order: _order, ...entry }) => entry),
  };
}

/** Unknown outcomes stay unconfirmed until a later attempt of the same output succeeds. */
function unconfirmed(
  events: readonly TriggerRunEventRecord[],
): { stepId: string | null; outputType: string }[] {
  const open = new Map<string, { stepId: string | null; outputType: string }>();
  for (const event of events) {
    const outputType = event.data["outputType"];
    if (typeof outputType !== "string") continue;
    const key = `${event.agentExecutionId ?? ""}\u0000${outputType}`;
    if (event.kind === "output_unknown") open.set(key, { stepId: event.stepId, outputType });
    if (event.kind === "output_succeeded") open.delete(key);
  }
  return [...open.values()];
}
