// Sessions tool tests cover list/send helpers, transcript path reporting,
// announce-target resolution, and assistant-visible text sanitization.
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelMessagingAdapter } from "../../channels/plugins/types.js";
import { resolveStorePath, saveSessionStore } from "../../config/sessions.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { addSubagentRunForTests, resetSubagentRegistryForTests } from "../subagent-registry.js";
import { extractAssistantText, sanitizeTextContent } from "./chat-history-text.js";

const callGatewayMock = vi.fn();
const embeddedRunMocks = vi.hoisted(() => ({
  queue: vi.fn(),
  resolveActiveSessionId: vi.fn(),
}));
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));
vi.mock("../embedded-agent-runner/runs.js", async () => {
  const actual = await vi.importActual<typeof import("../embedded-agent-runner/runs.js")>(
    "../embedded-agent-runner/runs.js",
  );
  return {
    ...actual,
    queueEmbeddedAgentMessageWithOutcomeAsync: embeddedRunMocks.queue,
    resolveActiveEmbeddedRunSessionId: embeddedRunMocks.resolveActiveSessionId,
  };
});

type SessionsToolTestConfig = {
  agents?: { list: Array<{ id: string; default?: boolean }> };
  bindings?: Array<{
    agentId: string;
    match: {
      channel: string;
      accountId?: string;
      peer?: { kind: "direct" | "group" | "channel"; id: string };
    };
  }>;
  session: { scope: "per-sender"; mainKey: string; agentToAgent?: { maxPingPongTurns: number } };
  tools: {
    agentToAgent: { enabled: boolean };
    sessions?: { visibility: "self" | "tree" | "agent" | "all" };
  };
};

const loadConfigMock = vi.fn<() => SessionsToolTestConfig>(() => ({
  session: { scope: "per-sender", mainKey: "main" },
  tools: { agentToAgent: { enabled: false } },
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => loadConfigMock() as never,
  };
});
vi.mock("./sessions-send-tool.a2a.js", () => ({
  runSessionsSendA2AFlow: vi.fn(),
}));

let createSessionsListTool: typeof import("./sessions-list-tool.js").createSessionsListTool;
let createSessionsSendTool: typeof import("./sessions-send-tool.js").createSessionsSendTool;
let resolveAnnounceTarget: (typeof import("./sessions-announce-target.js"))["resolveAnnounceTarget"];
let setActivePluginRegistry: (typeof import("../../plugins/runtime.js"))["setActivePluginRegistry"];
const MAIN_AGENT_SESSION_KEY = "agent:main:main";
const MAIN_AGENT_CHANNEL = "whatsapp";
const resolveSessionConversationStub: NonNullable<
  ChannelMessagingAdapter["resolveSessionConversation"]
> = ({ rawId }) => ({
  id: rawId,
});
const resolveSessionTargetStub: NonNullable<ChannelMessagingAdapter["resolveSessionTarget"]> = ({
  kind,
  id,
  threadId,
}) => (threadId ? `${kind}:${id}:thread:${threadId}` : `${kind}:${id}`);

type SessionsListResult = Awaited<
  ReturnType<ReturnType<typeof import("./sessions-list-tool.js").createSessionsListTool>["execute"]>
>;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireDetails(result: { details?: unknown }, label = "result details") {
  return requireRecord(result.details, label);
}

function requireSessions(details: Record<string, unknown>) {
  const sessions = details.sessions;
  if (!Array.isArray(sessions)) {
    throw new Error("expected details.sessions");
  }
  return sessions.map((session, index) => requireRecord(session, `session ${index}`));
}

function requireGatewayRequest(index = 0) {
  return requireRecord(callGatewayMock.mock.calls[index]?.[0], `gateway request ${index}`);
}

beforeAll(async () => {
  ({ createSessionsListTool } = await import("./sessions-list-tool.js"));
  ({ createSessionsSendTool } = await import("./sessions-send-tool.js"));
  ({ resolveAnnounceTarget } = await import("./sessions-announce-target.js"));
  ({ setActivePluginRegistry } = await import("../../plugins/runtime.js"));
});

const installRegistry = async () => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: {
          id: "discord",
          meta: {
            id: "discord",
            label: "Discord",
            selectionLabel: "Discord",
            docsPath: "/channels/discord",
            blurb: "Discord test stub.",
          },
          capabilities: { chatTypes: ["direct", "channel", "thread"] },
          messaging: {
            resolveSessionTarget: resolveSessionTargetStub,
          },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
      {
        pluginId: "feishu",
        source: "test",
        plugin: {
          id: "feishu",
          meta: {
            id: "feishu",
            label: "Feishu",
            selectionLabel: "Feishu",
            docsPath: "/channels/feishu",
            blurb: "Feishu test stub.",
            preferSessionLookupForAnnounceTarget: true,
          },
          capabilities: { chatTypes: ["direct", "group"] },
          messaging: {
            resolveSessionConversation: resolveSessionConversationStub,
            resolveSessionTarget: resolveSessionTargetStub,
          },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
      {
        pluginId: "whatsapp",
        source: "test",
        plugin: {
          id: "whatsapp",
          meta: {
            id: "whatsapp",
            label: "WhatsApp",
            selectionLabel: "WhatsApp",
            docsPath: "/channels/whatsapp",
            blurb: "WhatsApp test stub.",
            preferSessionLookupForAnnounceTarget: true,
          },
          capabilities: { chatTypes: ["direct", "group"] },
          messaging: {
            resolveSessionConversation: resolveSessionConversationStub,
            resolveSessionTarget: resolveSessionTargetStub,
          },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          id: "slack",
          meta: {
            id: "slack",
            label: "Slack",
            selectionLabel: "Slack",
            docsPath: "/channels/slack",
            blurb: "Slack test stub.",
            preferSessionLookupForAnnounceTarget: true,
          },
          capabilities: { chatTypes: ["direct", "channel", "thread"] },
          messaging: {
            resolveSessionConversation: resolveSessionConversationStub,
            resolveSessionTarget: resolveSessionTargetStub,
          },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
    ]),
  );
};

function createMainSessionsListTool() {
  return createSessionsListTool({ agentSessionKey: MAIN_AGENT_SESSION_KEY });
}

async function executeMainSessionsList() {
  return createMainSessionsListTool().execute("call1", {});
}

function createMainSessionsSendTool() {
  return createSessionsSendTool({
    agentSessionKey: MAIN_AGENT_SESSION_KEY,
    agentChannel: MAIN_AGENT_CHANNEL,
  });
}

async function executeFireAndForgetA2AFrom(requesterSessionKey: string) {
  const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
  vi.mocked(runSessionsSendA2AFlow).mockClear();
  const targetSessionKey = "agent:other:discord:group:ops";
  loadConfigMock.mockReturnValue({
    agents: { list: [{ id: "main", default: true }, { id: "other" }] },
    bindings: [
      {
        agentId: "other",
        match: {
          channel: "discord",
          accountId: "default",
          peer: { kind: "group", id: "ops" },
        },
      },
    ],
    session: { scope: "per-sender", mainKey: "main", agentToAgent: { maxPingPongTurns: 5 } },
    tools: {
      agentToAgent: { enabled: true },
      sessions: { visibility: "all" },
    },
  });
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string };
    if (request.method === "sessions.list") {
      return {
        path: "/tmp/sessions.json",
        sessions: [{ key: targetSessionKey, kind: "group" }],
      };
    }
    if (request.method === "chat.history") {
      return { messages: [] };
    }
    if (request.method === "agent") {
      return { runId: "run-fire-and-forget", acceptedAt: 123 };
    }
    return {};
  });
  const tool = createSessionsSendTool({
    agentSessionKey: requesterSessionKey,
    agentChannel: "telegram",
  });

  const result = await tool.execute("call-fire-and-forget", {
    sessionKey: targetSessionKey,
    message: "ping",
    timeoutSeconds: 0,
  });

  expect(requireDetails(result).status).toBe("accepted");
  const flowParams = vi.mocked(runSessionsSendA2AFlow).mock.calls[0]?.[0];
  if (!flowParams) {
    throw new Error("expected A2A flow");
  }
  return flowParams;
}

function getFirstListedSession(result: SessionsListResult) {
  const details = result.details as
    | { sessions?: Array<{ key?: string; transcriptPath?: string }> }
    | undefined;
  return details?.sessions?.[0];
}

function expectWorkerTranscriptPath(
  result: SessionsListResult,
  params: { containsPath: string; sessionId: string },
) {
  const session = getFirstListedSession(result);
  expect(session?.key).toBe("agent:worker:main");
  const transcriptPath = session?.transcriptPath ?? "";
  expect(path.normalize(transcriptPath)).toContain(path.normalize(params.containsPath));
  expect(transcriptPath).toMatch(new RegExp(`${params.sessionId}\\.jsonl$`));
}

async function withStubbedStateDir<T>(
  name: string,
  run: (stateDir: string) => Promise<T>,
): Promise<T> {
  const stateDir = path.join(os.tmpdir(), name);
  return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => await run(stateDir));
}

describe("sanitizeTextContent", () => {
  it("strips minimax tool call XML and downgraded markers", () => {
    // Session recall should not replay provider/tool markup as assistant text.
    const input =
      'Hello <invoke name="tool">payload</invoke></minimax:tool_call> ' +
      "[Tool Call: foo (ID: 1)] world";
    const result = sanitizeTextContent(input).trim();
    expect(result).toBe("Hello  world");
    expect(result).not.toContain("invoke");
    expect(result).not.toContain("Tool Call");
  });

  it("strips tool_result XML via the shared assistant-visible sanitizer", () => {
    const input = 'Prefix\n<tool_result>{"output":"hidden"}</tool_result>\nSuffix';
    const result = sanitizeTextContent(input).trim();
    expect(result).toBe("Prefix\n\nSuffix");
    expect(result).not.toContain("tool_result");
  });

  it("strips thinking tags", () => {
    const input = "Before <think>secret</think> after";
    const result = sanitizeTextContent(input).trim();
    expect(result).toBe("Before  after");
  });
});

beforeEach(() => {
  loadConfigMock.mockReset();
  loadConfigMock.mockReturnValue({
    session: { scope: "per-sender", mainKey: "main" },
    tools: { agentToAgent: { enabled: false } },
  });
  setActivePluginRegistry(createTestRegistry([]));
});

describe("extractAssistantText", () => {
  it("sanitizes blocks without injecting newlines", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "Hi " },
        { type: "text", text: "<think>secret</think>there" },
      ],
    };
    expect(extractAssistantText(message)).toBe("Hi there");
  });

  it("rewrites error-ish assistant text only when the transcript marks it as an error", () => {
    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "500 Internal Server Error",
      content: [{ type: "text", text: "500 Internal Server Error" }],
    };
    expect(extractAssistantText(message)).toBe("HTTP 500: Internal Server Error");
  });

  it("keeps normal status text that mentions billing", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Firebase downgraded us to the free Spark plan. Check whether billing should be re-enabled.",
        },
      ],
    };
    expect(extractAssistantText(message)).toBe(
      "Firebase downgraded us to the free Spark plan. Check whether billing should be re-enabled.",
    );
  });

  it("preserves successful turns with stale background errorMessage", () => {
    const message = {
      role: "assistant",
      stopReason: "end_turn",
      errorMessage: "insufficient credits for embedding model",
      content: [{ type: "text", text: "Handle payment required errors in your API." }],
    };
    expect(extractAssistantText(message)).toBe("Handle payment required errors in your API.");
  });

  it("prefers final_answer text when phased assistant history is present", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "internal reasoning",
          textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ],
    };
    expect(extractAssistantText(message)).toBe("Done.");
  });
});

describe("resolveAnnounceTarget", () => {
  beforeEach(async () => {
    callGatewayMock.mockClear();
    await installRegistry();
  });

  it("derives non-WhatsApp announce targets from the session key", async () => {
    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
    });
    expect(target).toEqual({ channel: "discord", to: "group:dev" });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("hydrates WhatsApp accountId from sessions.list when available", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:whatsapp:group:123@g.us",
          deliveryContext: {
            channel: "whatsapp",
            to: "123@g.us",
            accountId: "work",
            threadId: 99,
          },
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      displayKey: "agent:main:whatsapp:group:123@g.us",
    });
    expect(target).toEqual({
      channel: "whatsapp",
      to: "123@g.us",
      accountId: "work",
      threadId: "99",
    });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(requireGatewayRequest().method).toBe("sessions.list");
  });

  it("falls back to origin provider and accountId from sessions.list when legacy route fields are absent", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:whatsapp:group:123@g.us",
          origin: {
            provider: "whatsapp",
            accountId: "work",
          },
          lastTo: "123@g.us",
          lastThreadId: 271,
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      displayKey: "agent:main:whatsapp:group:123@g.us",
    });
    expect(target).toEqual({
      channel: "whatsapp",
      to: "123@g.us",
      accountId: "work",
      threadId: "271",
    });
  });

  it("keeps threadId from sessions.list delivery context for announce delivery", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:whatsapp:group:123@g.us",
          deliveryContext: {
            channel: "whatsapp",
            to: "123@g.us",
            accountId: "work",
            threadId: "thread-77",
          },
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      displayKey: "agent:main:whatsapp:group:123@g.us",
    });
    expect(target).toEqual({
      channel: "whatsapp",
      to: "123@g.us",
      accountId: "work",
      threadId: "thread-77",
    });
  });

  it("hydrates announce delivery from explicit external context over stale webchat session fields", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:feishu:direct:ou_user",
          channel: "webchat",
          lastChannel: "webchat",
          lastTo: "session:dashboard",
          route: {
            channel: "webchat",
            target: { to: "session:dashboard" },
          },
          deliveryContext: {
            channel: "feishu",
            to: "user:ou_user",
          },
          origin: {
            provider: "feishu",
            accountId: "work",
            threadId: "thread-77",
          },
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:feishu:direct:ou_user",
      displayKey: "agent:main:feishu:direct:ou_user",
    });
    expect(target).toEqual({
      channel: "feishu",
      to: "user:ou_user",
      accountId: "work",
      threadId: "thread-77",
    });
  });

  it("preserves threaded Slack session keys when sessions.list lacks stored thread metadata", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:slack:channel:C123:thread:1710000000.000100",
          deliveryContext: {
            channel: "slack",
            to: "channel:C123",
            accountId: "workspace",
          },
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:slack:channel:C123:thread:1710000000.000100",
      displayKey: "agent:main:slack:channel:C123:thread:1710000000.000100",
    });
    expect(target).toEqual({
      channel: "slack",
      to: "channel:C123",
      accountId: "workspace",
      threadId: "1710000000.000100",
    });
  });
});

describe("sessions_list gating", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    callGatewayMock.mockImplementation(
      (request: { method?: string; params?: { spawnedBy?: string } }) => {
        if (request.method === "sessions.list" && request.params?.spawnedBy) {
          return Promise.resolve({ path: "/tmp/sessions.json", sessions: [] });
        }
        return Promise.resolve({
          path: "/tmp/sessions.json",
          sessions: [
            { key: "agent:main:main", kind: "direct" },
            { key: "agent:other:main", kind: "direct" },
          ],
        });
      },
    );
  });

  it("filters out other agents when tools.agentToAgent.enabled is false", async () => {
    const tool = createMainSessionsListTool();
    const result = await tool.execute("call1", {});
    const details = requireDetails(result);
    expect(details.count).toBe(1);
    expect(requireSessions(details)[0]?.key).toBe(MAIN_AGENT_SESSION_KEY);
  });

  it("keeps requester-owned cross-agent rows with tree visibility without a spawned lookup", async () => {
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: false },
        sessions: { visibility: "tree" },
      },
    });
    callGatewayMock.mockResolvedValueOnce({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:codex:acp:child-1",
          kind: "direct",
          spawnedBy: MAIN_AGENT_SESSION_KEY,
        },
      ],
    });

    const result = await createMainSessionsListTool().execute("call1", {});

    const details = requireDetails(result);
    expect(details.count).toBe(1);
    const session = requireSessions(details)[0];
    expect(session?.key).toBe("agent:codex:acp:child-1");
    expect(session?.spawnedBy).toBe(MAIN_AGENT_SESSION_KEY);
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("keeps requester-owned cross-agent rows with all visibility when a2a is disabled", async () => {
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: false },
        sessions: { visibility: "all" },
      },
    });
    callGatewayMock.mockResolvedValueOnce({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:codex:acp:child-1",
          kind: "direct",
          parentSessionKey: MAIN_AGENT_SESSION_KEY,
        },
      ],
    });

    const result = await createMainSessionsListTool().execute("call1", {});

    const details = requireDetails(result);
    expect(details.count).toBe(1);
    expect(details.visibility).toBeUndefined();
    const session = requireSessions(details)[0];
    expect(session?.key).toBe("agent:codex:acp:child-1");
    expect(session?.parentSessionKey).toBe(MAIN_AGENT_SESSION_KEY);
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("includes visibility metadata when session visibility is restricted", async () => {
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: true },
        sessions: { visibility: "tree" },
      },
    });

    const result = await createMainSessionsListTool().execute("call1", {});

    const details = requireDetails(result);
    expect(details.count).toBe(1);
    expect(details.visibility).toMatchObject({
      mode: "tree",
      restricted: true,
      warning:
        "Session visibility is restricted (effective tools.sessions.visibility=tree). Results may omit sessions outside the current scope. The count field reflects only sessions within the current scope.",
    });
  });

  it("keeps literal current keys for message previews", async () => {
    callGatewayMock.mockReset();
    callGatewayMock
      .mockResolvedValueOnce({
        path: "/tmp/sessions.json",
        sessions: [{ key: "current", kind: "direct" }],
      })
      .mockResolvedValueOnce({ messages: [{ role: "assistant", content: [] }] });

    await createMainSessionsListTool().execute("call1", { messageLimit: 1 });

    expect(callGatewayMock).toHaveBeenLastCalledWith({
      method: "chat.history",
      params: { sessionKey: "current", limit: 1 },
    });
  });
});

describe("sessions_list transcriptPath resolution", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: true },
        sessions: { visibility: "all" },
      },
    });
  });

  it("resolves cross-agent transcript paths from agent defaults when gateway store path is relative", async () => {
    await withStubbedStateDir("openclaw-state-relative", async () => {
      callGatewayMock.mockResolvedValueOnce({
        path: "agents/main/sessions/sessions.json",
        sessions: [
          {
            key: "agent:worker:main",
            kind: "direct",
            sessionId: "sess-worker",
          },
        ],
      });
      const result = await executeMainSessionsList();
      expectWorkerTranscriptPath(result, {
        containsPath: path.join("agents", "worker", "sessions"),
        sessionId: "sess-worker",
      });
    });
  });

  it("resolves transcriptPath even when sessions.list does not return a store path", async () => {
    await withStubbedStateDir("openclaw-state-no-path", async () => {
      callGatewayMock.mockResolvedValueOnce({
        sessions: [
          {
            key: "agent:worker:main",
            kind: "direct",
            sessionId: "sess-worker-no-path",
          },
        ],
      });
      const result = await executeMainSessionsList();
      expectWorkerTranscriptPath(result, {
        containsPath: path.join("agents", "worker", "sessions"),
        sessionId: "sess-worker-no-path",
      });
    });
  });

  it("falls back to agent defaults when gateway path is non-string", async () => {
    await withStubbedStateDir("openclaw-state-non-string-path", async () => {
      callGatewayMock.mockResolvedValueOnce({
        path: { raw: "agents/main/sessions/sessions.json" },
        sessions: [
          {
            key: "agent:worker:main",
            kind: "direct",
            sessionId: "sess-worker-shape",
          },
        ],
      });
      const result = await executeMainSessionsList();
      expectWorkerTranscriptPath(result, {
        containsPath: path.join("agents", "worker", "sessions"),
        sessionId: "sess-worker-shape",
      });
    });
  });

  it("falls back to agent defaults when gateway path is '(multiple)'", async () => {
    await withStubbedStateDir("openclaw-state-multiple", async (stateDir) => {
      callGatewayMock.mockResolvedValueOnce({
        path: "(multiple)",
        sessions: [
          {
            key: "agent:worker:main",
            kind: "direct",
            sessionId: "sess-worker-multiple",
          },
        ],
      });
      const result = await executeMainSessionsList();
      expectWorkerTranscriptPath(result, {
        containsPath: path.join(stateDir, "agents", "worker", "sessions"),
        sessionId: "sess-worker-multiple",
      });
    });
  });

  it("resolves absolute {agentId} template paths per session agent", async () => {
    const templateStorePath = "/tmp/openclaw/agents/{agentId}/sessions/sessions.json";

    callGatewayMock.mockResolvedValueOnce({
      path: templateStorePath,
      sessions: [
        {
          key: "agent:worker:main",
          kind: "direct",
          sessionId: "sess-worker-template",
        },
      ],
    });
    const result = await executeMainSessionsList();
    const expectedSessionsDir = path.dirname(templateStorePath.replace("{agentId}", "worker"));
    expectWorkerTranscriptPath(result, {
      containsPath: expectedSessionsDir,
      sessionId: "sess-worker-template",
    });
  });
});

describe("sessions_list channel derivation", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: true },
        sessions: { visibility: "all" },
      },
    });
  });

  it("falls back to origin.provider when the legacy top-level channel field is missing", async () => {
    callGatewayMock.mockResolvedValueOnce({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:discord:group:ops",
          kind: "group",
          origin: { provider: "discord" },
        },
      ],
    });
    const result = await executeMainSessionsList();

    const details = requireDetails(result);
    const session = requireSessions(details)[0];
    expect(session?.key).toBe("agent:main:discord:group:ops");
    expect(session?.channel).toBe("discord");
  });
});

describe("sessions_send gating", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    embeddedRunMocks.queue.mockReset();
    embeddedRunMocks.resolveActiveSessionId.mockReset();
    resetSubagentRegistryForTests();
  });

  it("returns an error when neither sessionKey nor label is provided", async () => {
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-missing-target", {
      message: "hi",
      timeoutSeconds: 5,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("error");
    expect(details.error).toBe("Either sessionKey or label is required");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "an explicit registry", agents: { list: [{ id: "main", default: true }] } },
    { name: "the implicit default-only registry", agents: undefined },
  ])(
    "rejects a removed service-agent target with $name before gateway or A2A work",
    async ({ agents }) => {
      const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
      vi.mocked(runSessionsSendA2AFlow).mockClear();
      const tool = createSessionsSendTool({
        agentSessionKey: MAIN_AGENT_SESSION_KEY,
        agentChannel: MAIN_AGENT_CHANNEL,
        callGateway: callGatewayMock,
        config: {
          ...(agents ? { agents } : {}),
          session: { scope: "per-sender", mainKey: "main" },
          tools: {
            agentToAgent: { enabled: true, allow: ["*"] },
            sessions: { visibility: "all" },
          },
        } as never,
      });

      const result = await tool.execute("call-removed-target", {
        sessionKey: "agent:removed-service:slack:channel:C1",
        message: "continue",
        timeoutSeconds: 0,
      });

      expect(requireDetails(result)).toMatchObject({
        status: "forbidden",
        error: "Target agent is no longer configured.",
        sessionKey: "agent:removed-service:slack:channel:C1",
      });
      expect(callGatewayMock).not.toHaveBeenCalled();
      expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
    },
  );

  it("uses live config when a target is removed after tool construction", async () => {
    loadConfigMock.mockReturnValue({
      agents: { list: [{ id: "main", default: true }, { id: "service" }] },
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: true },
        sessions: { visibility: "all" },
      },
    });
    const tool = createSessionsSendTool({
      agentSessionKey: MAIN_AGENT_SESSION_KEY,
      agentId: "main",
      agentChannel: MAIN_AGENT_CHANNEL,
      callGateway: callGatewayMock,
    });
    loadConfigMock.mockReturnValue({
      agents: { list: [{ id: "main", default: true }] },
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: true },
        sessions: { visibility: "all" },
      },
    });

    const result = await tool.execute("call-live-removed-target", {
      sessionKey: "agent:service:main",
      message: "continue",
      timeoutSeconds: 0,
    });

    expect(requireDetails(result)).toMatchObject({
      status: "forbidden",
      error: "Target agent is no longer configured.",
      sessionKey: "agent:service:main",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("uses live config when the requester is removed after tool construction", async () => {
    loadConfigMock.mockReturnValue({
      agents: { list: [{ id: "main", default: true }, { id: "work" }, { id: "service" }] },
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: true },
        sessions: { visibility: "all" },
      },
    });
    const tool = createSessionsSendTool({
      agentSessionKey: "agent:work:main",
      agentId: "work",
      agentChannel: MAIN_AGENT_CHANNEL,
      callGateway: callGatewayMock,
    });
    loadConfigMock.mockReturnValue({
      agents: { list: [{ id: "main", default: true }, { id: "service" }] },
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: true },
        sessions: { visibility: "all" },
      },
    });

    const result = await tool.execute("call-live-removed-requester", {
      sessionKey: "agent:service:main",
      message: "continue",
      timeoutSeconds: 0,
    });

    expect(requireDetails(result)).toMatchObject({
      status: "forbidden",
      error: "Requesting agent is no longer configured.",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("revalidates after a missing main-session lookup before creating state", async () => {
    const initialConfig = {
      agents: { list: [{ id: "main", default: true }, { id: "service" }] },
      session: { scope: "per-sender" as const, mainKey: "main" },
      tools: {
        agentToAgent: { enabled: true },
        sessions: { visibility: "all" as const },
      },
    };
    loadConfigMock.mockReturnValue(initialConfig);
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.resolve") {
        loadConfigMock.mockReturnValue({
          ...initialConfig,
          agents: { list: [{ id: "main", default: true }] },
        });
        throw new Error("missing");
      }
      return {};
    });
    const tool = createSessionsSendTool({
      agentSessionKey: MAIN_AGENT_SESSION_KEY,
      agentId: "main",
      agentChannel: MAIN_AGENT_CHANNEL,
      callGateway: callGatewayMock,
    });

    const result = await tool.execute("call-remove-before-create", {
      sessionKey: "agent:service:main",
      message: "continue",
      timeoutSeconds: 0,
    });

    expect(requireDetails(result)).toMatchObject({
      status: "forbidden",
      error: "Conversation identity is no longer authorized.",
    });
    expect(
      callGatewayMock.mock.calls.some(
        ([request]) => (request as { method?: string }).method === "sessions.create",
      ),
    ).toBe(false);
  });

  it.each([
    { name: "best-effort queue retry", outcome: "transcript_commit_wait_unsupported" },
    { name: "persistent-session fallback", outcome: "no_active_run" },
  ])("revalidates before a post-await $name", async ({ outcome }) => {
    const usesPersistentFallback = outcome === "no_active_run";
    const identitySessionKey = usesPersistentFallback
      ? "agent:service:cron:job-1"
      : "agent:service:slack:channel:c1";
    const targetSessionKey = `${identitySessionKey}:run:active-1`;
    const initialConfig = {
      agents: { list: [{ id: "main", default: true }, { id: "service" }] },
      bindings: [
        {
          agentId: "service",
          match: {
            channel: "slack",
            accountId: "default",
            peer: { kind: "channel" as const, id: "C1" },
          },
        },
      ],
      session: { scope: "per-sender" as const, mainKey: "main" },
      tools: {
        agentToAgent: { enabled: true },
        sessions: { visibility: "all" as const },
      },
    };
    loadConfigMock.mockReturnValue(initialConfig);
    embeddedRunMocks.resolveActiveSessionId.mockReturnValue("service-active-session-id");
    embeddedRunMocks.queue.mockImplementationOnce(async () => {
      loadConfigMock.mockReturnValue(
        usesPersistentFallback
          ? {
              ...initialConfig,
              agents: { list: [{ id: "main", default: true }] },
            }
          : {
              ...initialConfig,
              bindings: [],
            },
      );
      return { queued: false, reason: outcome };
    });

    await withStubbedStateDir(`openclaw-sessions-send-${outcome}`, async () => {
      if (!usesPersistentFallback) {
        await saveSessionStore(resolveStorePath(undefined, { agentId: "service" }), {
          [identitySessionKey]: {
            sessionId: "service-parent-session",
            updatedAt: 1,
            chatType: "channel",
            channel: "slack",
            route: {
              channel: "slack",
              accountId: "default",
              target: { to: "channel:C1", chatType: "channel" },
            },
            origin: {
              provider: "slack",
              accountId: "default",
              chatType: "channel",
              to: "channel:C1",
              nativeChannelId: "C1",
            },
          },
        });
      }
      const tool = createSessionsSendTool({
        agentSessionKey: MAIN_AGENT_SESSION_KEY,
        agentId: "main",
        agentChannel: MAIN_AGENT_CHANNEL,
        callGateway: callGatewayMock,
      });

      const result = await tool.execute(`call-${outcome}`, {
        sessionKey: targetSessionKey,
        message: "continue",
        timeoutSeconds: 0,
      });

      expect(requireDetails(result)).toMatchObject({
        status: "forbidden",
        error: "Conversation identity is no longer authorized.",
      });
      expect(embeddedRunMocks.queue).toHaveBeenCalledOnce();
      expect(
        callGatewayMock.mock.calls.some(
          ([request]) => (request as { method?: string }).method === "agent",
        ),
      ).toBe(false);
    });
  });

  it("rejects an unbound route-shaped target before creating its first session row", async () => {
    const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
    vi.mocked(runSessionsSendA2AFlow).mockClear();
    const targetSessionKey = "agent:service:discord:channel:C1";

    await withStubbedStateDir("openclaw-sessions-send-rowless-route", async () => {
      const tool = createSessionsSendTool({
        agentSessionKey: MAIN_AGENT_SESSION_KEY,
        agentChannel: MAIN_AGENT_CHANNEL,
        callGateway: callGatewayMock,
        config: {
          agents: { list: [{ id: "main", default: true }, { id: "service" }] },
          session: { scope: "per-sender", mainKey: "main" },
          tools: {
            agentToAgent: { enabled: true, allow: ["*"] },
            sessions: { visibility: "all" },
          },
        } as never,
      });

      const result = await tool.execute("call-rowless-route", {
        sessionKey: targetSessionKey,
        message: "continue",
        timeoutSeconds: 0,
      });

      expect(requireDetails(result)).toMatchObject({
        status: "forbidden",
        error: "Target conversation identity is no longer authorized.",
        sessionKey: targetSessionKey,
      });
      expect(callGatewayMock).toHaveBeenCalledTimes(1);
      expect(requireGatewayRequest().method).toBe("sessions.list");
      expect(embeddedRunMocks.resolveActiveSessionId).not.toHaveBeenCalled();
      expect(embeddedRunMocks.queue).not.toHaveBeenCalled();
      expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
    });
  });

  it("rejects a persisted service audience after its live binding is removed", async () => {
    const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
    vi.mocked(runSessionsSendA2AFlow).mockClear();
    const targetSessionKey = "agent:service:slack:channel:C1";

    await withStubbedStateDir("openclaw-sessions-send-stale-audience", async () => {
      await saveSessionStore(resolveStorePath(undefined, { agentId: "service" }), {
        [targetSessionKey]: {
          sessionId: "stale-service-audience",
          updatedAt: 1,
          chatType: "channel",
          channel: "slack",
          route: {
            channel: "slack",
            accountId: "default",
            target: { to: "channel:C1", chatType: "channel" },
          },
          origin: {
            provider: "slack",
            accountId: "default",
            chatType: "channel",
            to: "channel:C1",
            nativeChannelId: "C1",
          },
        },
      });
      const tool = createSessionsSendTool({
        agentSessionKey: MAIN_AGENT_SESSION_KEY,
        agentChannel: MAIN_AGENT_CHANNEL,
        callGateway: callGatewayMock,
        config: {
          agents: { list: [{ id: "main", default: true }, { id: "service" }] },
          session: { scope: "per-sender", mainKey: "main" },
          tools: {
            agentToAgent: { enabled: true, allow: ["*"] },
            sessions: { visibility: "all" },
          },
        } as never,
      });

      const result = await tool.execute("call-stale-audience", {
        sessionKey: targetSessionKey,
        message: "continue",
        timeoutSeconds: 0,
      });

      expect(requireDetails(result)).toMatchObject({
        status: "forbidden",
        error: "Target conversation identity is no longer authorized.",
        sessionKey: targetSessionKey,
      });
      expect(callGatewayMock).toHaveBeenCalledTimes(1);
      expect(requireGatewayRequest().method).toBe("sessions.list");
      expect(embeddedRunMocks.resolveActiveSessionId).not.toHaveBeenCalled();
      expect(embeddedRunMocks.queue).not.toHaveBeenCalled();
      expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
    });
  });

  it("fails closed for a legacy child route without persisted parent proof", async () => {
    const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
    vi.mocked(runSessionsSendA2AFlow).mockClear();
    const targetSessionKey = "agent:service:discord:channel:thread-1";

    await withStubbedStateDir("openclaw-sessions-send-legacy-thread", async () => {
      await saveSessionStore(resolveStorePath(undefined, { agentId: "service" }), {
        [targetSessionKey]: {
          sessionId: "legacy-service-thread",
          updatedAt: 1,
          chatType: "channel",
          channel: "discord",
          route: {
            channel: "discord",
            accountId: "default",
            target: { to: "channel:thread-1", chatType: "channel" },
            thread: { id: "thread-1" },
          },
          origin: {
            provider: "discord",
            accountId: "default",
            chatType: "channel",
            to: "channel:thread-1",
            threadId: "thread-1",
          },
        },
      });
      const tool = createSessionsSendTool({
        agentSessionKey: MAIN_AGENT_SESSION_KEY,
        agentChannel: MAIN_AGENT_CHANNEL,
        callGateway: callGatewayMock,
        config: {
          agents: { list: [{ id: "main", default: true }, { id: "service" }] },
          bindings: [
            {
              agentId: "service",
              match: {
                channel: "discord",
                accountId: "default",
                peer: { kind: "channel", id: "parent-1" },
              },
            },
          ],
          session: { scope: "per-sender", mainKey: "main" },
          tools: {
            agentToAgent: { enabled: true, allow: ["*"] },
            sessions: { visibility: "all" },
          },
        } as never,
      });

      const result = await tool.execute("call-legacy-thread", {
        sessionKey: targetSessionKey,
        message: "continue",
        timeoutSeconds: 0,
      });

      expect(requireDetails(result)).toMatchObject({
        status: "forbidden",
        error: "Target conversation identity is no longer authorized.",
        sessionKey: targetSessionKey,
      });
      expect(callGatewayMock).toHaveBeenCalledTimes(1);
      expect(requireGatewayRequest().method).toBe("sessions.list");
      expect(embeddedRunMocks.resolveActiveSessionId).not.toHaveBeenCalled();
      expect(embeddedRunMocks.queue).not.toHaveBeenCalled();
      expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
    });
  });

  it("checks session visibility before inspecting a persisted target audience", async () => {
    const targetSessionKey = "agent:service:slack:channel:C1";

    await withStubbedStateDir("openclaw-sessions-send-hidden-stale-audience", async () => {
      await saveSessionStore(resolveStorePath(undefined, { agentId: "service" }), {
        [targetSessionKey]: {
          sessionId: "hidden-stale-service-audience",
          updatedAt: 1,
          chatType: "channel",
          channel: "slack",
          route: {
            channel: "slack",
            accountId: "default",
            target: { to: "channel:C1", chatType: "channel" },
          },
          origin: {
            provider: "slack",
            accountId: "default",
            chatType: "channel",
            to: "channel:C1",
            nativeChannelId: "C1",
          },
        },
      });
      const tool = createSessionsSendTool({
        agentSessionKey: MAIN_AGENT_SESSION_KEY,
        agentChannel: MAIN_AGENT_CHANNEL,
        callGateway: callGatewayMock,
        config: {
          agents: { list: [{ id: "main", default: true }, { id: "service" }] },
          session: { scope: "per-sender", mainKey: "main" },
          tools: {
            agentToAgent: { enabled: true, allow: ["*"] },
            sessions: { visibility: "self" },
          },
        } as never,
      });

      const result = await tool.execute("call-hidden-stale-audience", {
        sessionKey: targetSessionKey,
        message: "continue",
        timeoutSeconds: 0,
      });

      expect(requireDetails(result)).toMatchObject({
        status: "forbidden",
        error: expect.stringContaining("Session send visibility is restricted"),
        sessionKey: targetSessionKey,
      });
      expect(callGatewayMock).not.toHaveBeenCalled();
      expect(embeddedRunMocks.resolveActiveSessionId).not.toHaveBeenCalled();
      expect(embeddedRunMocks.queue).not.toHaveBeenCalled();
    });
  });

  it("keeps a removed agent's persisted child steerable while parent ownership is live", async () => {
    const targetSessionKey = "agent:removed-service:subagent:child";
    const createdAt = Date.now();
    addSubagentRunForTests({
      runId: "run-live-removed-service-child",
      childSessionKey: targetSessionKey,
      requesterSessionKey: MAIN_AGENT_SESSION_KEY,
      requesterDisplayKey: "main",
      task: "child task",
      cleanup: "keep",
      createdAt,
      startedAt: createdAt,
    });

    await withStubbedStateDir("openclaw-sessions-send-live-owned-child", async () => {
      await saveSessionStore(resolveStorePath(undefined, { agentId: "removed-service" }), {
        [targetSessionKey]: {
          sessionId: "live-removed-service-child",
          updatedAt: createdAt,
          spawnedBy: MAIN_AGENT_SESSION_KEY,
        },
      });
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string };
        if (request.method === "agent") {
          return { runId: "run-live-child-steer", acceptedAt: createdAt };
        }
        return {};
      });
      const tool = createSessionsSendTool({
        agentSessionKey: MAIN_AGENT_SESSION_KEY,
        agentChannel: MAIN_AGENT_CHANNEL,
        callGateway: callGatewayMock,
        config: {
          agents: { list: [{ id: "main", default: true }] },
          session: { scope: "per-sender", mainKey: "main" },
          tools: {
            agentToAgent: { enabled: true, allow: ["*"] },
            sessions: { visibility: "all" },
          },
        } as never,
      });

      const result = await tool.execute("call-live-owned-child", {
        sessionKey: targetSessionKey,
        message: "continue",
        timeoutSeconds: 0,
      });

      expect(requireDetails(result)).toMatchObject({
        status: "accepted",
        sessionKey: targetSessionKey,
        runId: "run-live-child-steer",
      });
      expect(callGatewayMock.mock.calls).toContainEqual([
        expect.objectContaining({
          method: "agent",
          params: expect.objectContaining({ sessionKey: targetSessionKey }),
        }),
      ]);
    });
  });

  it("keeps global parent lineage raw when steering its live-owned child", async () => {
    const targetSessionKey = "agent:removed-service:subagent:global-child";
    const createdAt = Date.now();
    addSubagentRunForTests({
      runId: "run-global-live-child",
      childSessionKey: targetSessionKey,
      requesterSessionKey: "global",
      requesterDisplayKey: "main",
      task: "global child task",
      cleanup: "keep",
      createdAt,
      startedAt: createdAt,
    });

    await withStubbedStateDir("openclaw-sessions-send-global-live-child", async () => {
      await saveSessionStore(resolveStorePath(undefined, { agentId: "removed-service" }), {
        [targetSessionKey]: {
          sessionId: "global-live-child",
          updatedAt: createdAt,
          spawnedBy: "global",
        },
      });
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string; params?: { spawnedBy?: string } };
        if (request.method === "sessions.list") {
          expect(request.params?.spawnedBy).toBe("global");
          return { sessions: [{ key: targetSessionKey }] };
        }
        return request.method === "agent"
          ? { runId: "run-global-live-child-steer", acceptedAt: createdAt }
          : {};
      });
      const tool = createSessionsSendTool({
        agentSessionKey: "global",
        agentId: "main",
        agentChannel: MAIN_AGENT_CHANNEL,
        callGateway: callGatewayMock,
        config: {
          agents: { list: [{ id: "main", default: true }] },
          session: { scope: "global", mainKey: "main" },
          tools: {
            agentToAgent: { enabled: true, allow: ["*"] },
            sessions: { visibility: "tree" },
          },
        } as never,
      });

      const result = await tool.execute("call-global-live-child", {
        sessionKey: targetSessionKey,
        message: "continue",
        timeoutSeconds: 0,
      });

      expect(requireDetails(result)).toMatchObject({
        status: "accepted",
        sessionKey: targetSessionKey,
        runId: "run-global-live-child-steer",
      });
      expect(callGatewayMock.mock.calls).toContainEqual([
        expect.objectContaining({
          method: "agent",
          params: expect.objectContaining({
            sessionKey: targetSessionKey,
            inputProvenance: expect.objectContaining({ sourceSessionKey: "global" }),
          }),
        }),
      ]);
    });
  });

  it("keeps repeated sends to a configured service main with internal route metadata", async () => {
    const targetSessionKey = "agent:service:main";

    await withStubbedStateDir("openclaw-sessions-send-internal-service-main", async () => {
      await saveSessionStore(resolveStorePath(undefined, { agentId: "service" }), {
        [targetSessionKey]: {
          sessionId: "service-main-internal",
          updatedAt: 1,
          chatType: "direct",
          channel: "webchat",
          lastChannel: "sessions_send",
          lastTo: "session:service",
          route: {
            channel: "webchat",
            target: { to: "session:service", chatType: "direct" },
          },
          origin: {
            provider: "webchat",
            surface: "webchat",
            chatType: "direct",
            to: "session:service",
          },
        },
      });
      let agentRun = 0;
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string };
        if (request.method === "sessions.resolve") {
          return { key: targetSessionKey };
        }
        if (request.method === "agent") {
          agentRun += 1;
          return { runId: `run-service-main-${agentRun}`, acceptedAt: agentRun };
        }
        return {};
      });
      const tool = createSessionsSendTool({
        agentSessionKey: MAIN_AGENT_SESSION_KEY,
        agentChannel: MAIN_AGENT_CHANNEL,
        callGateway: callGatewayMock,
        config: {
          agents: { list: [{ id: "main", default: true }, { id: "service" }] },
          session: { scope: "per-sender", mainKey: "main" },
          tools: {
            agentToAgent: { enabled: true, allow: ["*"] },
            sessions: { visibility: "all" },
          },
        } as never,
      });

      const first = await tool.execute("call-service-main-1", {
        sessionKey: targetSessionKey,
        message: "first",
        timeoutSeconds: 0,
      });
      const second = await tool.execute("call-service-main-2", {
        sessionKey: targetSessionKey,
        message: "second",
        timeoutSeconds: 0,
      });

      expect(requireDetails(first)).toMatchObject({
        status: "accepted",
        sessionKey: targetSessionKey,
        runId: "run-service-main-1",
      });
      expect(requireDetails(second)).toMatchObject({
        status: "accepted",
        sessionKey: targetSessionKey,
        runId: "run-service-main-2",
      });
      expect(
        callGatewayMock.mock.calls.filter(
          ([request]) => (request as { method?: string }).method === "agent",
        ),
      ).toHaveLength(2);
    });
  });

  it.each([
    {
      name: "per-sender main alias",
      scope: "per-sender" as const,
      mainKey: "primary",
      canonicalKey: "agent:work:primary",
      dispatchedKey: "agent:work:primary",
      visibility: "all" as const,
    },
    {
      name: "global main alias with tree visibility",
      scope: "global" as const,
      mainKey: "main",
      canonicalKey: "global",
      dispatchedKey: "global",
      visibility: "tree" as const,
    },
    {
      name: "global main alias with self visibility",
      scope: "global" as const,
      mainKey: "main",
      canonicalKey: "global",
      dispatchedKey: "global",
      visibility: "self" as const,
    },
  ])("revalidates the $name through its canonical owner", async (testCase) => {
    await withStubbedStateDir(`openclaw-sessions-send-${testCase.scope}-main-alias`, async () => {
      await saveSessionStore(resolveStorePath(undefined, { agentId: "work" }), {
        [testCase.canonicalKey]: {
          sessionId: `${testCase.scope}-main-alias`,
          updatedAt: 1,
        },
      });
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string };
        if (request.method === "agent") {
          return { runId: `run-${testCase.scope}-main-alias`, acceptedAt: 1 };
        }
        return {};
      });
      const tool = createSessionsSendTool({
        agentSessionKey: "agent:work:main",
        agentChannel: MAIN_AGENT_CHANNEL,
        callGateway: callGatewayMock,
        config: {
          agents: { list: [{ id: "work", default: true }] },
          session: { scope: testCase.scope, mainKey: testCase.mainKey },
          tools: {
            agentToAgent: { enabled: true, allow: ["*"] },
            sessions: { visibility: testCase.visibility },
          },
        } as never,
      });

      const result = await tool.execute(`call-${testCase.scope}-main-alias`, {
        sessionKey: "main",
        message: "continue",
        timeoutSeconds: 0,
      });

      expect(requireDetails(result)).toMatchObject({
        status: "accepted",
        sessionKey: "main",
        runId: `run-${testCase.scope}-main-alias`,
      });
      expect(callGatewayMock.mock.calls).toContainEqual([
        expect.objectContaining({
          method: "agent",
          params: expect.objectContaining({ sessionKey: testCase.dispatchedKey }),
        }),
      ]);
    });
  });

  it("keeps a nondefault target agent attached to a global main alias", async () => {
    await withStubbedStateDir("openclaw-sessions-send-global-nondefault", async () => {
      await saveSessionStore(resolveStorePath(undefined, { agentId: "work" }), {
        global: {
          sessionId: "work-global-main",
          updatedAt: 1,
        },
      });
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string };
        if (request.method === "agent") {
          return { runId: "run-work-global", acceptedAt: 1 };
        }
        return {};
      });
      const tool = createSessionsSendTool({
        agentSessionKey: MAIN_AGENT_SESSION_KEY,
        agentId: "personal",
        agentChannel: MAIN_AGENT_CHANNEL,
        callGateway: callGatewayMock,
        config: {
          agents: { list: [{ id: "personal", default: true }, { id: "work" }] },
          session: { scope: "global", mainKey: "main" },
          tools: {
            agentToAgent: { enabled: true, allow: ["*"] },
            sessions: { visibility: "all" },
          },
        } as never,
      });

      const result = await tool.execute("call-work-global", {
        sessionKey: "global",
        agentId: "work",
        message: "continue",
        timeoutSeconds: 0,
      });

      expect(requireDetails(result)).toMatchObject({
        status: "accepted",
        sessionKey: "main",
        runId: "run-work-global",
      });
      expect(callGatewayMock.mock.calls).toContainEqual([
        expect.objectContaining({
          method: "sessions.resolve",
          params: { key: "global", agentId: "work" },
        }),
      ]);
      expect(callGatewayMock.mock.calls).toContainEqual([
        expect.objectContaining({
          method: "agent",
          params: expect.objectContaining({ sessionKey: "global", agentId: "work" }),
        }),
      ]);
    });
  });

  it("keeps self visibility for a nondefault requester on its global session", async () => {
    await withStubbedStateDir("openclaw-sessions-send-global-requester", async () => {
      await saveSessionStore(resolveStorePath(undefined, { agentId: "work" }), {
        global: {
          sessionId: "work-global-requester",
          updatedAt: 1,
        },
      });
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string };
        if (request.method === "agent") {
          return { runId: "run-work-global-requester", acceptedAt: 1 };
        }
        return {};
      });
      const tool = createSessionsSendTool({
        agentSessionKey: "global",
        agentId: "work",
        agentChannel: MAIN_AGENT_CHANNEL,
        callGateway: callGatewayMock,
        config: {
          agents: { list: [{ id: "personal", default: true }, { id: "work" }] },
          session: { scope: "global", mainKey: "main" },
          tools: {
            agentToAgent: { enabled: true, allow: ["*"] },
            sessions: { visibility: "self" },
          },
        } as never,
      });

      const result = await tool.execute("call-work-global-requester", {
        sessionKey: "global",
        message: "continue",
        timeoutSeconds: 0,
      });

      expect(requireDetails(result)).toMatchObject({
        status: "accepted",
        sessionKey: "main",
        runId: "run-work-global-requester",
      });
      expect(callGatewayMock.mock.calls).toContainEqual([
        expect.objectContaining({
          method: "agent",
          params: expect.objectContaining({ sessionKey: "global", agentId: "work" }),
        }),
      ]);
    });
  });

  it("uses the selected global requester for cross-agent allow rules", async () => {
    const tool = createSessionsSendTool({
      agentSessionKey: "global",
      agentId: "work",
      agentChannel: MAIN_AGENT_CHANNEL,
      callGateway: callGatewayMock,
      config: {
        agents: {
          list: [{ id: "main", default: true }, { id: "work" }, { id: "service" }],
        },
        session: { scope: "global", mainKey: "main" },
        tools: {
          agentToAgent: { enabled: true, allow: ["main", "service"] },
          sessions: { visibility: "all" },
        },
      } as never,
    });

    const result = await tool.execute("call-work-global-a2a-denied", {
      sessionKey: "agent:service:main",
      message: "continue",
      timeoutSeconds: 0,
    });

    expect(requireDetails(result)).toMatchObject({
      status: "forbidden",
      error: "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
      sessionKey: "agent:service:main",
    });
    expect(
      callGatewayMock.mock.calls.some(
        ([request]) => (request as { method?: string }).method === "agent",
      ),
    ).toBe(false);
  });

  it("keeps a nondefault per-sender requester attached to its main alias", async () => {
    await withStubbedStateDir("openclaw-sessions-send-per-sender-requester", async () => {
      const targetSessionKey = "agent:work:main";
      await saveSessionStore(resolveStorePath(undefined, { agentId: "work" }), {
        [targetSessionKey]: {
          sessionId: "work-main-requester",
          updatedAt: 1,
        },
      });
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string };
        if (request.method === "agent") {
          return { runId: "run-work-main-requester", acceptedAt: 1 };
        }
        return {};
      });
      const tool = createSessionsSendTool({
        agentSessionKey: "agent:work:slack:channel:ops",
        agentId: "work",
        agentChannel: "slack",
        callGateway: callGatewayMock,
        config: {
          agents: { list: [{ id: "personal", default: true }, { id: "work" }] },
          bindings: [
            {
              agentId: "work",
              match: {
                channel: "slack",
                accountId: "default",
                peer: { kind: "channel", id: "ops" },
              },
            },
          ],
          session: { scope: "per-sender", mainKey: "main" },
          tools: {
            agentToAgent: { enabled: true, allow: ["*"] },
            sessions: { visibility: "all" },
          },
        } as never,
      });

      const result = await tool.execute("call-work-main-requester", {
        sessionKey: "main",
        message: "continue",
        timeoutSeconds: 0,
      });

      expect(requireDetails(result)).toMatchObject({
        status: "accepted",
        sessionKey: "main",
        runId: "run-work-main-requester",
      });
      expect(callGatewayMock.mock.calls).toContainEqual([
        expect.objectContaining({
          method: "agent",
          params: expect.objectContaining({ sessionKey: targetSessionKey }),
        }),
      ]);
    });
  });

  it("reloads current config before deferred target work", async () => {
    const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
    vi.mocked(runSessionsSendA2AFlow).mockClear();
    const targetSessionKey = "agent:service:slack:channel:c1";
    const initialConfig = {
      agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
      bindings: [
        {
          agentId: "service",
          match: {
            channel: "slack",
            accountId: "default",
            peer: { kind: "channel", id: "C1" },
          },
        },
      ],
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: true, allow: ["*"] },
        sessions: { visibility: "all" },
      },
    } as const;

    await withStubbedStateDir("openclaw-sessions-send-live-config", async () => {
      await saveSessionStore(resolveStorePath(undefined, { agentId: "service" }), {
        [targetSessionKey]: {
          sessionId: "service-live-config",
          updatedAt: 1,
          chatType: "channel",
          channel: "slack",
          route: {
            channel: "slack",
            accountId: "default",
            target: { to: "channel:C1", chatType: "channel" },
          },
          origin: {
            provider: "slack",
            accountId: "default",
            chatType: "channel",
            to: "channel:C1",
            nativeChannelId: "C1",
          },
        },
      });
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string };
        return request.method === "agent" ? { runId: "run-live-config", acceptedAt: 1 } : {};
      });
      const tool = createSessionsSendTool({
        agentSessionKey: MAIN_AGENT_SESSION_KEY,
        agentId: "personal",
        agentChannel: MAIN_AGENT_CHANNEL,
        callGateway: callGatewayMock,
        config: initialConfig as never,
      });

      const result = await tool.execute("call-live-config", {
        sessionKey: targetSessionKey,
        message: "continue",
        timeoutSeconds: 0,
      });
      expect(requireDetails(result).status).toBe("accepted");
      expect(runSessionsSendA2AFlow).toHaveBeenCalledOnce();

      loadConfigMock.mockReturnValue({
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        session: { scope: "per-sender", mainKey: "main" },
        tools: {
          agentToAgent: { enabled: true },
          sessions: { visibility: "all" },
        },
      });
      const flow = vi.mocked(runSessionsSendA2AFlow).mock.calls[0]?.[0];
      expect(flow).toBeDefined();
      await expect(flow?.revalidateAdmission()).resolves.toBe(false);
    });
  });

  it("revalidates the requester route before deferred A2A work", async () => {
    const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
    vi.mocked(runSessionsSendA2AFlow).mockClear();
    const requesterSessionKey = "agent:work:slack:channel:C0";
    const initialConfig = {
      agents: {
        list: [{ id: "personal", default: true }, { id: "work" }, { id: "service" }],
      },
      bindings: [
        {
          agentId: "work",
          match: {
            channel: "slack",
            accountId: "default",
            peer: { kind: "channel" as const, id: "C0" },
          },
        },
      ],
      session: { scope: "per-sender" as const, mainKey: "main" },
      tools: {
        agentToAgent: { enabled: true, allow: ["*"] },
        sessions: { visibility: "all" as const },
      },
    };

    await withStubbedStateDir("openclaw-sessions-send-requester-route", async () => {
      await saveSessionStore(resolveStorePath(undefined, { agentId: "work" }), {
        [requesterSessionKey]: {
          sessionId: "work-requester-route",
          updatedAt: 1,
          chatType: "channel",
          channel: "slack",
          route: {
            channel: "slack",
            accountId: "default",
            target: { to: "channel:C0", chatType: "channel" },
          },
          origin: {
            provider: "slack",
            accountId: "default",
            chatType: "channel",
            to: "channel:C0",
            nativeChannelId: "C0",
          },
        },
      });
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string };
        return request.method === "agent" ? { runId: "run-requester-route", acceptedAt: 1 } : {};
      });
      const tool = createSessionsSendTool({
        agentSessionKey: requesterSessionKey,
        agentId: "work",
        agentChannel: "slack",
        callGateway: callGatewayMock,
        config: initialConfig as never,
      });

      const result = await tool.execute("call-requester-route", {
        sessionKey: "agent:service:main",
        message: "continue",
        timeoutSeconds: 0,
      });
      expect(requireDetails(result).status).toBe("accepted");
      expect(runSessionsSendA2AFlow).toHaveBeenCalledOnce();

      loadConfigMock.mockReturnValue({
        agents: {
          list: [{ id: "personal", default: true }, { id: "work" }, { id: "service" }],
        },
        session: { scope: "per-sender", mainKey: "main" },
        tools: {
          agentToAgent: { enabled: true },
          sessions: { visibility: "all" },
        },
      });
      const flow = vi.mocked(runSessionsSendA2AFlow).mock.calls[0]?.[0];
      expect(flow).toBeDefined();
      await expect(flow?.revalidateAdmission()).resolves.toBe(false);
    });
  });

  it("rejects an agent qualifier that conflicts with an agent-scoped key", async () => {
    const tool = createSessionsSendTool({
      agentSessionKey: MAIN_AGENT_SESSION_KEY,
      callGateway: callGatewayMock,
      config: {
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      } as never,
    });

    const result = await tool.execute("call-conflicting-agent", {
      sessionKey: "agent:personal:main",
      agentId: "work",
      message: "continue",
      timeoutSeconds: 0,
    });

    expect(requireDetails(result)).toMatchObject({
      status: "error",
      error: 'agentId "work" does not match session key agent "personal".',
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each([1.5, -1, "1sec"])("rejects invalid timeoutSeconds value %s", async (timeoutSeconds) => {
    const tool = createMainSessionsSendTool();

    await expect(
      tool.execute("call-invalid-timeout", {
        sessionKey: MAIN_AGENT_SESSION_KEY,
        message: "hi",
        timeoutSeconds,
      }),
    ).rejects.toThrow("timeoutSeconds must be a non-negative integer");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects service-to-personal run-scoped sends before active-run queueing", async () => {
    embeddedRunMocks.resolveActiveSessionId.mockReturnValue("personal-active-session-id");
    const tool = createSessionsSendTool({
      agentSessionKey: "agent:service:slack:channel:ops",
      agentChannel: "slack",
      callGateway: callGatewayMock,
      config: {
        agents: { list: [{ id: "main", default: true }, { id: "service" }] },
        bindings: [
          {
            agentId: "service",
            match: {
              channel: "slack",
              accountId: "default",
              peer: { kind: "channel", id: "ops" },
            },
          },
        ],
        session: { scope: "per-sender", mainKey: "main" },
        tools: {
          agentToAgent: { enabled: true, allow: ["*"] },
          sessions: { visibility: "all" },
        },
      } as never,
    });

    const result = await tool.execute("call-denied-active-run", {
      sessionKey: "agent:main:slack:channel:personal:run:active-1",
      message: "inject into personal run",
      timeoutSeconds: 0,
    });

    expect(requireDetails(result)).toMatchObject({
      status: "forbidden",
      error: "Target conversation identity is no longer authorized.",
      sessionKey: "agent:main:slack:channel:personal:run:active-1",
    });
    expect(embeddedRunMocks.resolveActiveSessionId).not.toHaveBeenCalled();
    expect(embeddedRunMocks.queue).not.toHaveBeenCalled();
    expect(callGatewayMock.mock.calls).not.toContainEqual([
      expect.objectContaining({ method: "agent" }),
    ]);
  });

  it("returns an error when label resolution fails", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("No session found with label: nope"));
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-missing-label", {
      label: "nope",
      message: "hello",
      timeoutSeconds: 5,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("error");
    expect((result.details as { error?: string } | undefined)?.error ?? "").toContain(
      "No session found with label",
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(requireGatewayRequest().method).toBe("sessions.resolve");
  });

  it("prefers sessionKey over a redundant label", async () => {
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-session-key-label", {
      sessionKey: MAIN_AGENT_SESSION_KEY,
      label: "stale-label",
      message: "hi",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details).toMatchObject({
      status: "accepted",
      sessionKey: MAIN_AGENT_SESSION_KEY,
    });
    expect(callGatewayMock.mock.calls[0]?.[0]).toMatchObject({ method: "sessions.list" });
    expect(callGatewayMock.mock.calls).toContainEqual([
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({ sessionKey: MAIN_AGENT_SESSION_KEY }),
      }),
    ]);
    expect(callGatewayMock.mock.calls).not.toContainEqual([
      expect.objectContaining({
        method: "sessions.resolve",
        params: expect.objectContaining({ label: "stale-label" }),
      }),
    ]);
  });

  it("does not disclose a resolved session key when sessionId access is denied", async () => {
    const tool = createSessionsSendTool({
      agentSessionKey: MAIN_AGENT_SESSION_KEY,
      callGateway: callGatewayMock,
      config: {
        session: { scope: "per-sender", mainKey: "main" },
        tools: {
          agentToAgent: { enabled: false },
          sessions: { visibility: "tree" },
        },
      } as never,
    });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.resolve") {
        if (request.params?.key === "session-id-only") {
          throw new Error("not a session key");
        }
        return { key: "agent:other:main" };
      }
      if (request.method === "sessions.list") {
        if (request.params?.spawnedBy === MAIN_AGENT_SESSION_KEY) {
          return {
            path: "/tmp/sessions.json",
            sessions: [],
          };
        }
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: "agent:other:main", kind: "direct" }],
        };
      }
      return {};
    });

    const result = await tool.execute("call-denied-session-id", {
      sessionKey: "session-id-only",
      message: "hi",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("forbidden");
    expect(details.sessionKey).toBe("session-id-only");
  });

  it("rejects an owner-ambiguous global session ID before visibility or dispatch", async () => {
    const tool = createSessionsSendTool({
      agentSessionKey: "global",
      agentId: "personal",
      callGateway: callGatewayMock,
      config: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        session: { scope: "global", mainKey: "main" },
        tools: {
          agentToAgent: { enabled: true, allow: ["*"] },
          sessions: { visibility: "all" },
        },
      } as never,
    });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (
        request.method === "sessions.resolve" &&
        request.params?.sessionId === "service-session-id"
      ) {
        return { key: "global" };
      }
      throw new Error(`unexpected gateway call: ${request.method}`);
    });

    const result = await tool.execute("call-ambiguous-global-session-id", {
      sessionKey: "service-session-id",
      message: "continue",
      timeoutSeconds: 0,
    });

    expect(requireDetails(result)).toMatchObject({
      status: "forbidden",
      error: "Global session targets resolved by label or session ID require agentId.",
      sessionKey: "service-session-id",
    });
    expect(callGatewayMock.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({
        method: "sessions.resolve",
        params: { key: "service-session-id" },
      }),
      expect.objectContaining({
        method: "sessions.resolve",
        params: expect.objectContaining({ sessionId: "service-session-id" }),
      }),
    ]);
  });

  it("keeps an explicit agent owner on a global session ID", async () => {
    const tool = createSessionsSendTool({
      agentSessionKey: "global",
      agentId: "personal",
      callGateway: callGatewayMock,
      config: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        session: { scope: "global", mainKey: "main" },
        tools: {
          agentToAgent: { enabled: true, allow: ["*"] },
          sessions: { visibility: "all" },
        },
      } as never,
    });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.resolve" && request.params?.sessionId) {
        return { key: "global" };
      }
      if (request.method === "agent") {
        return { runId: "run-service-global-id", acceptedAt: 1 };
      }
      return {};
    });

    const result = await tool.execute("call-owned-global-session-id", {
      sessionKey: "service-session-id",
      agentId: "service",
      message: "continue",
      timeoutSeconds: 0,
    });

    expect(requireDetails(result)).toMatchObject({
      status: "accepted",
      sessionKey: "main",
      runId: "run-service-global-id",
    });
    expect(callGatewayMock.mock.calls).toContainEqual([
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({ sessionKey: "global", agentId: "service" }),
      }),
    ]);
  });

  it("blocks cross-agent sends when tools.agentToAgent.enabled is false", async () => {
    loadConfigMock.mockReturnValue({
      agents: { list: [{ id: "main", default: true }, { id: "other" }] },
      session: { scope: "per-sender", mainKey: "main" },
      tools: { agentToAgent: { enabled: false } },
    });
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call1", {
      sessionKey: "agent:other:main",
      message: "hi",
      timeoutSeconds: 0,
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(requireGatewayRequest().method).toBe("sessions.list");
    expect(requireDetails(result).status).toBe("forbidden");
  });

  it("rejects direct thread session targets before dispatching an agent run", async () => {
    loadConfigMock.mockReturnValue({
      agents: { list: [{ id: "main", default: true }, { id: "other" }] },
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: false },
        sessions: { visibility: "all" },
      },
    });
    const threadSessionKey = "agent:main:slack:channel:C123:thread:1710000000.000100";
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-thread-target", {
      sessionKey: threadSessionKey,
      message: "hi",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("error");
    expect(details.sessionKey).toBe(threadSessionKey);
    expect((result.details as { error?: string } | undefined)?.error ?? "").toContain(
      "cannot target a thread session",
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(requireGatewayRequest().method).toBe("sessions.list");
  });

  it("rejects label targets that resolve to canonical thread sessions", async () => {
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: false },
        sessions: { visibility: "all" },
      },
    });
    const threadSessionKey = "agent:main:discord:channel:123456:thread:987654";
    callGatewayMock.mockResolvedValueOnce({ key: threadSessionKey });
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-thread-label", {
      label: "active thread",
      message: "hi",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("error");
    expect(details.sessionKey).toBe(threadSessionKey);
    expect((result.details as { error?: string } | undefined)?.error ?? "").toContain(
      "cannot target a thread session",
    );
    expect(callGatewayMock.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ method: "sessions.resolve" }),
      expect.objectContaining({ method: "sessions.list" }),
    ]);
  });

  it("does not disclose a resolved thread session key from a sessionId target", async () => {
    loadConfigMock.mockReturnValue({
      agents: { list: [{ id: "main", default: true }, { id: "other" }] },
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: false },
        sessions: { visibility: "all" },
      },
    });
    const threadSessionKey = "agent:other:discord:channel:123456:thread:987654";
    callGatewayMock.mockResolvedValueOnce({ key: threadSessionKey });
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-thread-session-id", {
      sessionKey: "thread-session-id",
      message: "hi",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("forbidden");
    expect(details.sessionKey).toBe("thread-session-id");
    expect((result.details as { error?: string } | undefined)?.error ?? "").toContain(
      "Agent-to-agent messaging is disabled",
    );
    expect(callGatewayMock.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ method: "sessions.resolve" }),
      expect.objectContaining({ method: "sessions.list" }),
    ]);
  });

  it("does not reuse a stale assistant reply when no new reply appears", async () => {
    const tool = createMainSessionsSendTool();
    let historyCalls = 0;
    const staleAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "older reply from a previous run" }],
      timestamp: 20,
    };

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: MAIN_AGENT_SESSION_KEY, kind: "direct" }],
        };
      }
      if (request.method === "agent") {
        return { runId: "run-stale-send", acceptedAt: 123 };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-stale-send", status: "ok" };
      }
      if (request.method === "chat.history") {
        historyCalls += 1;
        return { messages: [staleAssistantMessage] };
      }
      return {};
    });

    const result = await tool.execute("call-stale-send", {
      sessionKey: MAIN_AGENT_SESSION_KEY,
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(historyCalls).toBe(2);
    const details = requireDetails(result);
    expect(details.status).toBe("ok");
    expect(details.reply).toBeUndefined();
    expect(details.sessionKey).toBe(MAIN_AGENT_SESSION_KEY);
  });

  it("passes a baseline into fire-and-forget same-session A2A delivery", async () => {
    const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
    vi.mocked(runSessionsSendA2AFlow).mockClear();
    const tool = createMainSessionsSendTool();
    const staleAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "older reply from a previous run" }],
      timestamp: 20,
    };

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: MAIN_AGENT_SESSION_KEY, kind: "direct" }],
        };
      }
      if (request.method === "chat.history") {
        return { messages: [staleAssistantMessage] };
      }
      if (request.method === "agent") {
        return { runId: "run-fire-and-forget", acceptedAt: 123 };
      }
      return {};
    });

    const result = await tool.execute("call-fire-and-forget-same-session", {
      sessionKey: MAIN_AGENT_SESSION_KEY,
      message: "ping",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("accepted");
    expect(details.sessionKey).toBe(MAIN_AGENT_SESSION_KEY);
    const flowParams = vi.mocked(runSessionsSendA2AFlow).mock.calls[0]?.[0];
    expect(flowParams?.waitRunId).toBe("run-fire-and-forget");
    expect(flowParams?.baseline?.text).toBe("older reply from a previous run");
  });

  it("accepts fire-and-forget same-session sends when baseline history is unavailable", async () => {
    const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
    vi.mocked(runSessionsSendA2AFlow).mockClear();
    const tool = createMainSessionsSendTool();

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: MAIN_AGENT_SESSION_KEY, kind: "direct" }],
        };
      }
      if (request.method === "chat.history") {
        throw new Error("history unavailable");
      }
      if (request.method === "agent") {
        return { runId: "run-fire-and-forget", acceptedAt: 123 };
      }
      return {};
    });

    const result = await tool.execute("call-fire-and-forget-history-fail", {
      sessionKey: MAIN_AGENT_SESSION_KEY,
      message: "ping",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("accepted");
    expect(details.sessionKey).toBe(MAIN_AGENT_SESSION_KEY);
    const flowParams = vi.mocked(runSessionsSendA2AFlow).mock.calls[0]?.[0];
    expect(flowParams?.waitRunId).toBe("run-fire-and-forget");
    expect(flowParams?.baseline).toBeUndefined();
  });

  it.each([
    {
      label: "canonical cron run",
      requesterSessionKey: "agent:main:cron:job:run:abc",
      expected: 0,
    },
    {
      label: "normal requester",
      requesterSessionKey: "agent:main:main",
      expected: 5,
    },
    {
      label: "non-canonical cron-like requester",
      requesterSessionKey: "agent:main:slack:cron:job:run:uuid",
      expected: 5,
    },
  ] as const)(
    "uses the expected ping-pong turns for a $label",
    async ({ requesterSessionKey, expected }) => {
      const flowParams = await executeFireAndForgetA2AFrom(requesterSessionKey);

      expect(flowParams.maxPingPongTurns).toBe(expected);
      expect(flowParams.requesterSessionKey).toBe(requesterSessionKey);
    },
  );

  it("caps oversized timeoutSeconds before waiting for the target run", async () => {
    const tool = createMainSessionsSendTool();
    const waitTimeouts: unknown[] = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; timeoutMs?: unknown };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: MAIN_AGENT_SESSION_KEY, kind: "direct" }],
        };
      }
      if (request.method === "agent") {
        return { runId: "run-huge-timeout", acceptedAt: 123 };
      }
      if (request.method === "agent.wait") {
        waitTimeouts.push(request.timeoutMs);
        return { runId: "run-huge-timeout", status: "ok" };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });

    const result = await tool.execute("call-huge-timeout", {
      sessionKey: MAIN_AGENT_SESSION_KEY,
      message: "ping",
      timeoutSeconds: Number.MAX_SAFE_INTEGER,
    });

    expect(requireDetails(result).status).toBe("ok");
    expect(waitTimeouts).toEqual([MAX_TIMER_TIMEOUT_MS]);
  });
});
