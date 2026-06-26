// Starts the local browser onboarding host and waits for the wizard to finish.
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolveGatewayPort, resolveStateDir } from "../config/paths.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  createManagedTaskFlow,
  failFlow,
  findLatestTaskFlowForOwnerKey,
} from "../tasks/task-flow-registry.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import { resolveUserPath } from "../utils.js";
import {
  detectBrowserOpenSupport,
  openUrl,
  randomToken,
  waitForGatewayReachable,
} from "./onboard-helpers.js";
import type { OnboardOptions } from "./onboard-types.js";

const BROWSER_SETUP_STARTUP_TIMEOUT_MS = 20_000;
const BROWSER_SETUP_SESSION_TIMEOUT_MS = 30 * 60_000;
const BROWSER_SETUP_PARENT_ENV = "OPENCLAW_BROWSER_SETUP_PARENT";
const BROWSER_SETUP_FLOW_ENV = "OPENCLAW_BROWSER_SETUP_FLOW_ID";

type BrowserSetupResult = {
  started: boolean;
  terminalOnly?: boolean;
  reason?: string;
  terminalStatus?: "done" | "cancelled" | "error";
};

function filterInspectorArgs(execArgv: readonly string[]): string[] {
  return execArgv.filter(
    (arg) =>
      !arg.startsWith("--inspect") &&
      !arg.startsWith("--debug-port") &&
      !arg.startsWith("--debug-brk"),
  );
}

async function pickEphemeralPort(): Promise<number> {
  const server = net.createServer();
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error("could not allocate a loopback setup port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

function buildGatewayChildArgs(port: number): string[] {
  const entry = process.argv[1]?.trim();
  if (!entry) {
    throw new Error("current CLI entry path is unavailable");
  }
  return [
    ...filterInspectorArgs(process.execArgv),
    path.isAbsolute(entry) ? entry : path.resolve(entry),
    "gateway",
    "run",
    "--allow-unconfigured",
    "--bind",
    "loopback",
    "--port",
    String(port),
    "--auth",
    "token",
  ];
}

function browserSetupOwnerKey(): string {
  return `onboard:browser:${resolveStateDir(process.env)}`;
}

function resolveBrowserSetupFlow(): TaskFlowRecord | null {
  const ownerKey = browserSetupOwnerKey();
  const existing = findLatestTaskFlowForOwnerKey(ownerKey);
  if (
    existing &&
    (existing.status === "queued" ||
      existing.status === "running" ||
      existing.status === "waiting" ||
      existing.status === "blocked")
  ) {
    return existing;
  }
  return createManagedTaskFlow({
    ownerKey,
    controllerId: "core/browser-onboarding",
    status: "running",
    notifyPolicy: "silent",
    goal: "Complete OpenClaw browser onboarding",
    currentStep: "bootstrap",
    stateJson: {
      version: 1,
      phase: "bootstrap",
      model: "gemma-4-E2B-it-web",
    },
  });
}

function resolveUnsupportedBrowserOptions(opts: OnboardOptions): string | undefined {
  const browserSupportedFields = new Set(["browser", "workspace", "nonInteractive", "mode"]);
  if (opts.installDaemon !== undefined) {
    return "--install-daemon/--no-install-daemon";
  }
  if (opts.customImageInput !== undefined) {
    return "--custom-image-input/--custom-text-input";
  }
  for (const [key, value] of Object.entries(opts)) {
    if (
      browserSupportedFields.has(key) ||
      value === undefined ||
      value === false ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    ) {
      continue;
    }
    return `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
  }
  return undefined;
}

function terminateChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 5_000).unref();
}

function attachBrowserSetupParentSignalHandlers(
  child: ChildProcess,
  runtime: RuntimeEnv,
): () => void {
  const handlers: Array<[NodeJS.Signals, () => void]> = [
    [
      "SIGINT",
      () => {
        terminateChild(child);
        runtime.exit(130);
      },
    ],
    [
      "SIGTERM",
      () => {
        terminateChild(child);
        runtime.exit(143);
      },
    ],
    [
      "SIGHUP",
      () => {
        terminateChild(child);
        runtime.exit(129);
      },
    ],
  ];
  for (const [signal, handler] of handlers) {
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
}

function waitForBrowserSetupCompletion(
  child: ChildProcess,
  timeoutMs = BROWSER_SETUP_SESSION_TIMEOUT_MS,
): Promise<{
  status: "done" | "cancelled" | "error";
  error?: string;
}> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("browser onboarding timed out waiting for the setup page"));
    }, timeoutMs);
    timer.unref?.();
    const finish = <T>(callback: (value: T) => void, value: T) => {
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      callback(value);
    };
    const onMessage = (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "openclaw-browser-setup-complete"
      ) {
        const status =
          "status" in message &&
          (message.status === "done" ||
            message.status === "cancelled" ||
            message.status === "error")
            ? message.status
            : "error";
        finish(resolve, {
          status,
          ...("error" in message && typeof message.error === "string"
            ? { error: message.error }
            : {}),
        });
      }
    };
    child.on("message", onMessage);
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGTERM") {
        finish(resolve, { status: "done" });
        return;
      }
      finish(
        reject,
        new Error(`browser setup Gateway exited with code ${code ?? signal ?? "unknown"}`),
      );
    });
  });
}

function browserSetupUrl(
  port: number,
  token: string,
  basePath: string,
  workspace?: string,
): string {
  const url = new URL(`http://127.0.0.1:${port}${basePath}/setup`);
  url.searchParams.set("openclawSetup", "1");
  if (workspace) {
    url.searchParams.set("workspace", resolveUserPath(workspace));
  }
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

async function resolveBrowserSetupBasePath(): Promise<string> {
  const snapshot = await readConfigFileSnapshot();
  return snapshot.valid
    ? normalizeControlUiBasePath(snapshot.config.gateway?.controlUi?.basePath)
    : "";
}

async function resolveBrowserSetupTargetPort(): Promise<number> {
  const snapshot = await readConfigFileSnapshot();
  return resolveGatewayPort(snapshot.valid ? snapshot.config : {});
}

function failBrowserSetupFlow(flow: TaskFlowRecord, reason: string): void {
  failFlow({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
    currentStep: "failed",
    stateJson: {
      version: 1,
      phase: "failed",
      error: reason,
    },
    blockedSummary: reason,
  });
}

/** Launches browser onboarding, returning false when the caller should use terminal setup. */
export async function runBrowserSetup(
  opts: OnboardOptions,
  runtime: RuntimeEnv,
): Promise<BrowserSetupResult> {
  const unsupportedOption = resolveUnsupportedBrowserOptions(opts);
  if (unsupportedOption) {
    return {
      started: false,
      terminalOnly: true,
      reason: `Browser onboarding cannot preserve ${unsupportedOption}; use terminal onboarding for this command.`,
    };
  }
  const browserSupport = await detectBrowserOpenSupport();
  if (!browserSupport.ok) {
    return {
      started: false,
      reason: browserSupport.reason
        ? `Browser launch support is unavailable (${browserSupport.reason}).`
        : "No browser launch command is available.",
    };
  }

  const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
  if (!controlUiAssets.ok) {
    return {
      started: false,
      reason: controlUiAssets.message ?? "Control UI assets could not be built.",
    };
  }

  const port = await pickEphemeralPort();
  const token = randomToken();
  const basePath = await resolveBrowserSetupBasePath();
  const targetPort = await resolveBrowserSetupTargetPort();
  const flow = resolveBrowserSetupFlow();
  if (!flow) {
    return {
      started: false,
      reason: "Could not persist the browser onboarding task flow.",
    };
  }
  const child = spawn(process.execPath, buildGatewayChildArgs(port), {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENCLAW_BROWSER_SETUP_TOKEN: token,
      OPENCLAW_BROWSER_SETUP_REAL_PORT: String(targetPort),
      [BROWSER_SETUP_PARENT_ENV]: "1",
      [BROWSER_SETUP_FLOW_ENV]: flow.flowId,
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const detachParentSignals = attachBrowserSetupParentSignalHandlers(child, runtime);

  try {
    const ready = await waitForGatewayReachable({
      url: `ws://127.0.0.1:${port}`,
      token,
      deadlineMs: BROWSER_SETUP_STARTUP_TIMEOUT_MS,
    });
    if (!ready.ok) {
      throw new Error(ready.detail ?? "temporary setup Gateway did not become reachable");
    }

    const url = browserSetupUrl(port, token, basePath, opts.workspace);
    runtime.log("Opening browser onboarding in your local browser…");
    const opened = await openUrl(url);
    if (!opened) {
      const reason = "Could not open the browser setup page automatically.";
      failBrowserSetupFlow(flow, reason);
      return {
        started: false,
        reason,
      };
    }

    const completion = await waitForBrowserSetupCompletion(child);
    return {
      started: true,
      terminalStatus: completion.status,
      ...(completion.error ? { reason: completion.error } : {}),
    };
  } catch (error) {
    failBrowserSetupFlow(flow, formatErrorMessage(error));
    return {
      started: false,
      reason: `Browser onboarding failed: ${formatErrorMessage(error)}`,
    };
  } finally {
    detachParentSignals();
    terminateChild(child);
  }
}
