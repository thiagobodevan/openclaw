// Wizard gateway methods manage interactive setup wizard sessions and route
// start/next/status/cancel RPCs through the wizard runtime.
import { randomUUID } from "node:crypto";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateWizardCancelParams,
  validateWizardNextParams,
  validateWizardStartParams,
  validateWizardStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { defaultRuntime } from "../../runtime.js";
import { WizardSession } from "../../wizard/session.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const BROWSER_SETUP_IDLE_TIMEOUT_MS = 60_000;
const browserSetupIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function readWizardStatus(session: WizardSession) {
  return {
    status: session.getStatus(),
    error: session.getError(),
  };
}

function notifyBrowserSetupComplete(params: {
  status: "done" | "cancelled" | "error";
  error?: string;
}): void {
  if (process.env.OPENCLAW_BROWSER_SETUP_PARENT !== "1" || typeof process.send !== "function") {
    return;
  }
  try {
    process.send({
      type: "openclaw-browser-setup-complete",
      status: params.status,
      ...(params.error ? { error: params.error } : {}),
    });
  } catch {
    // Browser setup tracking is best-effort; never turn a completed wizard into
    // a failed setup just because the parent CLI already closed its IPC channel.
  }
}

function clearBrowserSetupIdleTimer(sessionId: string): void {
  const timer = browserSetupIdleTimers.get(sessionId);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  browserSetupIdleTimers.delete(sessionId);
}

function touchBrowserSetupIdleTimer(sessionId: string, context: GatewayRequestContext): void {
  if (process.env.OPENCLAW_BROWSER_SETUP_PARENT !== "1") {
    return;
  }
  clearBrowserSetupIdleTimer(sessionId);
  const timer = setTimeout(() => {
    browserSetupIdleTimers.delete(sessionId);
    const session = context.wizardSessions.get(sessionId);
    if (!session || session.getStatus() !== "running") {
      return;
    }
    session.cancel();
    context.wizardSessions.delete(sessionId);
    void persistBrowserSetupCheckpoint({
      done: true,
      status: "cancelled",
      error: "browser setup page disconnected",
    });
    notifyBrowserSetupComplete({
      status: "cancelled",
      error: "browser setup page disconnected",
    });
  }, BROWSER_SETUP_IDLE_TIMEOUT_MS);
  timer.unref?.();
  browserSetupIdleTimers.set(sessionId, timer);
}

async function persistBrowserSetupCheckpoint(result: {
  done: boolean;
  status?: "running" | "done" | "cancelled" | "error";
  step?: { id: string; type: string };
  error?: string;
}): Promise<void> {
  try {
    const flowId = process.env.OPENCLAW_BROWSER_SETUP_FLOW_ID?.trim();
    if (!flowId) {
      return;
    }
    const { failFlow, finishFlow, getTaskFlowById, setFlowWaiting } =
      await import("../../tasks/task-flow-runtime-internal.js");
    const flow = getTaskFlowById(flowId);
    if (!flow) {
      return;
    }
    const stateJson = {
      version: 1,
      phase: result.done ? (result.status === "done" ? "done" : "failed") : "waiting",
      ...(result.step ? { stepType: result.step.type } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
    if (result.done && result.status === "done") {
      finishFlow({
        flowId,
        expectedRevision: flow.revision,
        currentStep: "complete",
        stateJson,
      });
      return;
    }
    if (result.done) {
      failFlow({
        flowId,
        expectedRevision: flow.revision,
        currentStep: "failed",
        stateJson,
        blockedSummary: result.error,
      });
      return;
    }
    setFlowWaiting({
      flowId,
      expectedRevision: flow.revision,
      currentStep: result.step?.id ?? "wizard",
      stateJson,
      waitJson: {
        kind: "wizard-input",
        ...(result.step ? { stepId: result.step.id } : {}),
      },
    });
  } catch {
    // Task Flow is an activity ledger; it must not become a dependency of the
    // setup wizard's config, credential, or plugin execution path.
  }
}

/** Resolves a live wizard session or sends the public not-found error. */
function findWizardSessionOrRespond(params: {
  context: GatewayRequestContext;
  respond: RespondFn;
  sessionId: string;
}): WizardSession | null {
  const session = params.context.wizardSessions.get(params.sessionId);
  if (!session) {
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "wizard not found"));
    return null;
  }
  return session;
}

/** Gateway handlers for the interactive setup wizard session lifecycle. */
export const wizardHandlers: GatewayRequestHandlers = {
  "wizard.start": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateWizardStartParams, "wizard.start", respond)) {
      return;
    }
    const running = context.findRunningWizard();
    if (running) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "wizard already running"));
      return;
    }
    const sessionId = randomUUID();
    const opts = {
      mode: params.mode,
      workspace: readStringValue(params.workspace),
    };
    const session = new WizardSession((prompter) =>
      context.wizardRunner(opts, defaultRuntime, prompter),
    );
    context.wizardSessions.set(sessionId, session);
    touchBrowserSetupIdleTimer(sessionId, context);
    const result = await session.next();
    await persistBrowserSetupCheckpoint(result);
    if (result.done) {
      // Completed sessions cannot accept later answers; purge immediately so
      // clients get a clean not-found response for stale session ids.
      context.purgeWizardSession(sessionId);
      clearBrowserSetupIdleTimer(sessionId);
      notifyBrowserSetupComplete({
        status:
          result.status === "done" ? "done" : result.status === "cancelled" ? "cancelled" : "error",
        ...(result.error ? { error: result.error } : {}),
      });
    }
    respond(true, { sessionId, ...result }, undefined);
  },
  "wizard.next": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateWizardNextParams, "wizard.next", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = findWizardSessionOrRespond({ context, respond, sessionId });
    if (!session) {
      return;
    }
    touchBrowserSetupIdleTimer(sessionId, context);
    const answer = params.answer as { stepId?: string; value?: unknown } | undefined;
    if (answer) {
      if (session.getStatus() !== "running") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "wizard not running"));
        return;
      }
      try {
        await session.answer(answer.stepId ?? "", answer.value);
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
        return;
      }
    }
    const result = await session.next();
    await persistBrowserSetupCheckpoint(result);
    if (result.done) {
      // The final step may be reached after an answer, so cleanup mirrors
      // wizard.start's immediate-completion path.
      context.purgeWizardSession(sessionId);
      clearBrowserSetupIdleTimer(sessionId);
      notifyBrowserSetupComplete({
        status:
          result.status === "done" ? "done" : result.status === "cancelled" ? "cancelled" : "error",
        ...(result.error ? { error: result.error } : {}),
      });
    }
    respond(true, result, undefined);
  },
  "wizard.cancel": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateWizardCancelParams, "wizard.cancel", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = findWizardSessionOrRespond({ context, respond, sessionId });
    if (!session) {
      return;
    }
    session.cancel();
    const status = readWizardStatus(session);
    context.wizardSessions.delete(sessionId);
    clearBrowserSetupIdleTimer(sessionId);
    await persistBrowserSetupCheckpoint({
      done: true,
      status: "cancelled",
      error: status.error,
    });
    notifyBrowserSetupComplete({ status: "cancelled", error: status.error });
    respond(true, status, undefined);
  },
  "wizard.status": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateWizardStatusParams, "wizard.status", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = findWizardSessionOrRespond({ context, respond, sessionId });
    if (!session) {
      return;
    }
    touchBrowserSetupIdleTimer(sessionId, context);
    const status = readWizardStatus(session);
    if (status.status !== "running") {
      context.wizardSessions.delete(sessionId);
      clearBrowserSetupIdleTimer(sessionId);
    }
    respond(true, status, undefined);
  },
};
