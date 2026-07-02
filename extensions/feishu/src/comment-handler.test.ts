// Feishu tests cover comment handler plugin behavior.
import type { PreparedInboundReply } from "openclaw/plugin-sdk/channel-inbound";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { handleFeishuCommentEvent } from "./comment-handler.js";
import { setFeishuRuntime } from "./runtime.js";

const resolveDriveCommentEventTurnMock = vi.hoisted(() => vi.fn());
const resolveDriveCommentNoticeFactsMock = vi.hoisted(() => vi.fn());
const createFeishuCommentReplyDispatcherMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn(() => ({ request: vi.fn() })));
const deliverCommentThreadTextMock = vi.hoisted(() => vi.fn());
const ensureConfiguredBindingRouteReadyMock = vi.hoisted(() => vi.fn());
const resolveConfiguredBindingRouteMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    ensureConfiguredBindingRouteReady: (
      params: Parameters<typeof actual.ensureConfiguredBindingRouteReady>[0],
    ) =>
      ensureConfiguredBindingRouteReadyMock.getMockImplementation()
        ? ensureConfiguredBindingRouteReadyMock(params)
        : actual.ensureConfiguredBindingRouteReady(params),
    resolveConfiguredBindingRoute: (
      params: Parameters<typeof actual.resolveConfiguredBindingRoute>[0],
    ) =>
      resolveConfiguredBindingRouteMock.getMockImplementation()
        ? resolveConfiguredBindingRouteMock(params)
        : actual.resolveConfiguredBindingRoute(params),
  };
});

vi.mock("./monitor.comment.js", () => ({
  resolveDriveCommentNoticeFacts: resolveDriveCommentNoticeFactsMock,
  resolveDriveCommentEventTurn: resolveDriveCommentEventTurnMock,
}));

vi.mock("./comment-dispatcher.js", () => ({
  createFeishuCommentReplyDispatcher: createFeishuCommentReplyDispatcherMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./drive.js", () => ({
  deliverCommentThreadText: deliverCommentThreadTextMock,
}));

async function raceWithNextMacrotask<T>(promise: Promise<T>): Promise<T | "pending"> {
  return await Promise.race([
    promise,
    new Promise<"pending">((resolve) => {
      setImmediate(() => resolve("pending"));
    }),
  ]);
}

function buildConfig(overrides?: Partial<ClawdbotConfig>): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        dmPolicy: "open",
        allowFrom: ["*"],
      },
    },
    ...overrides,
  } as ClawdbotConfig;
}

let currentRuntimeConfig = buildConfig();

function buildResolvedRoute(matchedBy: "binding.channel" | "default" = "binding.channel") {
  const agentId = matchedBy === "default" ? "main" : "service";
  return {
    agentId,
    channel: "feishu",
    accountId: "default",
    sessionKey: `agent:${agentId}:feishu:channel:comment-doc:docx:doc_token_1`,
    mainSessionKey: `agent:${agentId}:main`,
    lastRoutePolicy: "session" as const,
    matchedBy,
  };
}

function mockCallArg(mockFn: ReturnType<typeof vi.fn>, label: string, callIndex = 0, argIndex = 0) {
  const call = mockFn.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  if (!(argIndex in call)) {
    throw new Error(`expected ${label} call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

function createTestRuntime(overrides?: {
  currentCfg?: ClawdbotConfig;
  readAllowFromStore?: () => Promise<unknown[]>;
  upsertPairingRequest?: () => Promise<{ code: string; created: boolean }>;
  resolveAgentRoute?: () => ReturnType<typeof buildResolvedRoute>;
  dispatchReplyFromConfig?: PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"];
  withReplyDispatcher?: PluginRuntime["channel"]["reply"]["withReplyDispatcher"];
}) {
  const finalizeInboundContext = vi.fn((ctx: Record<string, unknown>) => ctx);
  const dispatchReplyFromConfig =
    overrides?.dispatchReplyFromConfig ??
    vi.fn(async () => ({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    }));
  const withReplyDispatcher =
    overrides?.withReplyDispatcher ??
    vi.fn(
      async ({
        run,
        onSettled,
      }: {
        run: () => Promise<unknown>;
        onSettled?: () => Promise<void> | void;
      }) => {
        try {
          return await run();
        } finally {
          await onSettled?.();
        }
      },
    );
  const recordInboundSession = vi.fn(async () => {});
  const dispatchPreparedForTest = vi.fn(async (turn: PreparedInboundReply<unknown>) => {
    await turn.recordInboundSession({
      storePath: turn.storePath,
      sessionKey: turn.ctxPayload.SessionKey ?? turn.routeSessionKey,
      ctx: turn.ctxPayload,
      groupResolution: turn.record?.groupResolution,
      createIfMissing: turn.record?.createIfMissing,
      updateLastRoute: turn.record?.updateLastRoute,
      onRecordError: turn.record?.onRecordError ?? (() => undefined),
    });
    const dispatchResult = await turn.runDispatch();
    return {
      admission: { kind: "dispatch" as const },
      dispatched: true,
      ctxPayload: turn.ctxPayload,
      routeSessionKey: turn.routeSessionKey,
      dispatchResult,
    };
  });

  return {
    config: {
      current: vi.fn(() => overrides?.currentCfg ?? currentRuntimeConfig),
    },
    channel: {
      routing: {
        buildAgentSessionKey: vi.fn(
          ({
            agentId,
            channel,
            peer,
          }: {
            agentId: string;
            channel: string;
            peer?: { kind?: string; id?: string };
          }) => `agent:${agentId}:${channel}:${peer?.kind ?? "direct"}:${peer?.id ?? "peer"}`,
        ),
        resolveAgentRoute: vi.fn(overrides?.resolveAgentRoute ?? (() => buildResolvedRoute())),
      },
      reply: {
        finalizeInboundContext,
        dispatchReplyFromConfig,
        withReplyDispatcher,
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/feishu-session-store.json"),
        recordInboundSession,
      },
      inbound: {
        run: vi.fn(async (params: Parameters<PluginRuntime["channel"]["inbound"]["run"]>[0]) => {
          const input = await params.adapter.ingest(params.raw);
          if (!input) {
            return {
              admission: { kind: "drop" as const, reason: "ingest-null" },
              dispatched: false,
            };
          }
          const eventClass = {
            kind: "message" as const,
            canStartAgentTurn: true,
          };
          const turn = await params.adapter.resolveTurn(input, eventClass, {});
          if (!("runDispatch" in turn)) {
            throw new Error("feishu comment test runtime only supports prepared turns");
          }
          return await dispatchPreparedForTest(turn as PreparedInboundReply<unknown>);
        }) as unknown as PluginRuntime["channel"]["inbound"]["run"],
      },
      pairing: {
        readAllowFromStore: vi.fn(overrides?.readAllowFromStore ?? (async () => [])),
        upsertPairingRequest: vi.fn(
          overrides?.upsertPairingRequest ??
            (async () => ({
              code: "TESTCODE",
              created: true,
            })),
        ),
        buildPairingReply: vi.fn((code: string) => `Pairing code: ${code}`),
      },
    },
  } as unknown as PluginRuntime;
}

describe("handleFeishuCommentEvent", () => {
  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/conversation-runtime");
    vi.doUnmock("./monitor.comment.js");
    vi.doUnmock("./comment-dispatcher.js");
    vi.doUnmock("./client.js");
    vi.doUnmock("./drive.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    ensureConfiguredBindingRouteReadyMock.mockReset();
    resolveConfiguredBindingRouteMock.mockReset();
    currentRuntimeConfig = buildConfig();
    resolveDriveCommentNoticeFactsMock.mockReturnValue({
      eventId: "evt_1",
      commentId: "comment_1",
      replyId: "reply_1",
      noticeType: "add_comment",
      fileToken: "doc_token_1",
      fileType: "docx",
      senderId: "ou_sender",
      senderUserId: "on_sender_user",
      timestamp: "1774951528000",
      isMentioned: true,
    });
    resolveDriveCommentEventTurnMock.mockResolvedValue({
      eventId: "evt_1",
      messageId: "drive-comment:evt_1",
      commentId: "comment_1",
      replyId: "reply_1",
      noticeType: "add_comment",
      fileToken: "doc_token_1",
      fileType: "docx",
      isWholeComment: false,
      senderId: "ou_sender",
      senderUserId: "on_sender_user",
      timestamp: "1774951528000",
      isMentioned: true,
      documentTitle: "Project review",
      prompt: "prompt body",
      preview: "prompt body",
      rootCommentText: "root comment",
      targetReplyText: "latest reply",
    });
    deliverCommentThreadTextMock.mockResolvedValue({
      delivery_mode: "reply_comment",
      reply_id: "r1",
    });

    const runtime = createTestRuntime();
    setFeishuRuntime(runtime);

    createFeishuCommentReplyDispatcherMock.mockReturnValue({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      markRunComplete: vi.fn(),
      startTypingReaction: vi.fn(async () => {}),
      cleanupTypingReaction: vi.fn(async () => {}),
    });
  });

  it("records a comment-thread inbound context with a routable Feishu origin", async () => {
    await handleFeishuCommentEvent({
      cfg: buildConfig(),
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    const runtime = (await import("./runtime.js")).getFeishuRuntime();
    const finalizeInboundContext = runtime.channel.reply.finalizeInboundContext as ReturnType<
      typeof vi.fn
    >;
    const recordInboundSession = runtime.channel.session.recordInboundSession as ReturnType<
      typeof vi.fn
    >;
    const dispatchReplyFromConfig = runtime.channel.reply.dispatchReplyFromConfig as ReturnType<
      typeof vi.fn
    >;

    expect(finalizeInboundContext).toHaveBeenCalledTimes(1);
    const finalizedContext = mockCallArg(finalizeInboundContext, "finalizeInboundContext") as
      | Record<string, unknown>
      | undefined;
    expect({
      agentId: finalizedContext?.AgentId,
      from: finalizedContext?.From,
      to: finalizedContext?.To,
      surface: finalizedContext?.Surface,
      originatingChannel: finalizedContext?.OriginatingChannel,
      originatingTo: finalizedContext?.OriginatingTo,
      messageSid: finalizedContext?.MessageSid,
      messageThreadId: finalizedContext?.MessageThreadId,
      chatType: finalizedContext?.ChatType,
      chatId: finalizedContext?.ChatId,
      groupChannel: finalizedContext?.GroupChannel,
    }).toEqual({
      agentId: "service",
      from: "feishu:ou_sender",
      to: "comment:docx:doc_token_1:comment_1",
      surface: "feishu-comment",
      originatingChannel: "feishu",
      originatingTo: "comment:docx:doc_token_1:comment_1",
      messageSid: "drive-comment:evt_1",
      messageThreadId: "reply_1",
      chatType: "channel",
      chatId: "comment-doc:docx:doc_token_1",
      groupChannel: "Project review",
    });
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    const recordArgs = mockCallArg(recordInboundSession, "recordInboundSession") as
      | { sessionKey?: string }
      | undefined;
    expect(recordArgs?.sessionKey).toBe(
      "agent:service:feishu:channel:comment-doc:docx:doc_token_1",
    );
    expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const resolveAgentRoute = runtime.channel.routing.resolveAgentRoute as ReturnType<typeof vi.fn>;
    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "channel", id: "comment-doc:docx:doc_token_1" },
      }),
    );
  });

  it("readies a configured comment binding and dispatches to its service identity", async () => {
    const cfg = buildConfig();
    const runtime = createTestRuntime({
      currentCfg: cfg,
      resolveAgentRoute: () => buildResolvedRoute("default"),
    });
    setFeishuRuntime(runtime);
    const configuredBinding = { statefulTarget: { sessionKey: "agent:codex:acp:comment" } };
    const configuredRoute = {
      ...buildResolvedRoute("binding.channel"),
      agentId: "codex",
      mainSessionKey: "agent:codex:main",
      sessionKey: "agent:codex:acp:comment",
    };
    resolveConfiguredBindingRouteMock.mockReturnValue({
      bindingResolution: configuredBinding,
      boundAgentId: "codex",
      boundSessionKey: configuredRoute.sessionKey,
      route: configuredRoute,
    });
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({ ok: true });

    await handleFeishuCommentEvent({
      cfg,
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledWith({
      cfg,
      bindingResolution: configuredBinding,
    });
    expect(resolveDriveCommentEventTurnMock).toHaveBeenCalledTimes(1);
    const finalizeInboundContext = runtime.channel.reply.finalizeInboundContext as ReturnType<
      typeof vi.fn
    >;
    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        AgentId: "codex",
        SessionKey: "agent:codex:acp:comment",
      }),
    );
  });

  it("drops a comment before hydration when its configured binding is unavailable", async () => {
    const cfg = buildConfig();
    const runtime = createTestRuntime({
      currentCfg: cfg,
      resolveAgentRoute: () => buildResolvedRoute("default"),
    });
    setFeishuRuntime(runtime);
    const configuredBinding = { statefulTarget: { sessionKey: "agent:codex:acp:comment" } };
    resolveConfiguredBindingRouteMock.mockReturnValue({
      bindingResolution: configuredBinding,
      boundAgentId: "codex",
      boundSessionKey: "agent:codex:acp:comment",
      route: {
        ...buildResolvedRoute("binding.channel"),
        agentId: "codex",
        mainSessionKey: "agent:codex:main",
        sessionKey: "agent:codex:acp:comment",
      },
    });
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({
      ok: false,
      error: "target unavailable",
    });

    await handleFeishuCommentEvent({
      cfg,
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
    expect(resolveDriveCommentEventTurnMock).not.toHaveBeenCalled();
    expect(runtime.channel.reply.dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("allows comment senders matched by user_id allowlist entries", async () => {
    const runtime = createTestRuntime();
    setFeishuRuntime(runtime);

    await handleFeishuCommentEvent({
      cfg: buildConfig({
        channels: {
          feishu: {
            enabled: true,
            dmPolicy: "allowlist",
            allowFrom: ["on_sender_user"],
          },
        },
      }),
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    const dispatchReplyFromConfig = runtime.channel.reply.dispatchReplyFromConfig as ReturnType<
      typeof vi.fn
    >;
    expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(deliverCommentThreadTextMock).not.toHaveBeenCalled();
  });

  it("denies an unbound document audience before hydrating comment content", async () => {
    const runtime = createTestRuntime({
      resolveAgentRoute: () => buildResolvedRoute("default"),
    });
    setFeishuRuntime(runtime);

    await handleFeishuCommentEvent({
      cfg: buildConfig({
        channels: {
          feishu: {
            enabled: true,
            dmPolicy: "pairing",
            allowFrom: [],
          },
        },
      }),
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    expect(resolveDriveCommentEventTurnMock).not.toHaveBeenCalled();
    const dispatchReplyFromConfig = runtime.channel.reply.dispatchReplyFromConfig as ReturnType<
      typeof vi.fn
    >;
    expect(deliverCommentThreadTextMock).not.toHaveBeenCalled();
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("issues a pairing challenge in the comment thread when dmPolicy=pairing", async () => {
    const runtime = createTestRuntime();
    setFeishuRuntime(runtime);

    await handleFeishuCommentEvent({
      cfg: buildConfig({
        channels: {
          feishu: {
            enabled: true,
            dmPolicy: "pairing",
            allowFrom: [],
          },
        },
      }),
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    expect(deliverCommentThreadTextMock).toHaveBeenCalledTimes(1);
    const pairingClient = mockCallArg(deliverCommentThreadTextMock, "deliverCommentThreadText");
    const pairingReply = mockCallArg(
      deliverCommentThreadTextMock,
      "deliverCommentThreadText",
      0,
      1,
    );
    expect(pairingClient).toBe(createFeishuClientMock.mock.results[0]?.value);
    expect(pairingReply).toEqual({
      file_token: "doc_token_1",
      file_type: "docx",
      comment_id: "comment_1",
      content: [
        "OpenClaw: access not configured.",
        "",
        "Your Feishu user id: ou_sender",
        "Pairing code:",
        "```",
        "TESTCODE",
        "```",
        "",
        "Ask the bot owner to approve with:",
        "```",
        "openclaw pairing approve feishu TESTCODE",
        "```",
      ].join("\n"),
    });
    const dispatchReplyFromConfig = runtime.channel.reply.dispatchReplyFromConfig as ReturnType<
      typeof vi.fn
    >;
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("passes whole-comment metadata to the comment reply dispatcher", async () => {
    resolveDriveCommentEventTurnMock.mockResolvedValueOnce({
      eventId: "evt_whole",
      messageId: "drive-comment:evt_whole",
      commentId: "comment_whole",
      replyId: "reply_whole",
      noticeType: "add_reply",
      fileToken: "doc_token_1",
      fileType: "docx",
      isWholeComment: true,
      senderId: "ou_sender",
      senderUserId: "on_sender_user",
      timestamp: "1774951528000",
      isMentioned: false,
      documentTitle: "Project review",
      prompt: "prompt body",
      preview: "prompt body",
      rootCommentText: "root comment",
      targetReplyText: "reply text",
    });

    await handleFeishuCommentEvent({
      cfg: buildConfig(),
      accountId: "default",
      event: { event_id: "evt_whole" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    expect(createFeishuCommentReplyDispatcherMock).toHaveBeenCalledTimes(1);
    const dispatcherArgs = mockCallArg(
      createFeishuCommentReplyDispatcherMock,
      "createFeishuCommentReplyDispatcher",
    ) as
      | {
          commentId?: string;
          fileToken?: string;
          fileType?: string;
          isWholeComment?: boolean;
          replyId?: string;
        }
      | undefined;
    expect(dispatcherArgs?.commentId).toBe("comment_whole");
    expect(dispatcherArgs?.fileToken).toBe("doc_token_1");
    expect(dispatcherArgs?.fileType).toBe("docx");
    expect(dispatcherArgs?.replyId).toBe("reply_whole");
    expect(dispatcherArgs?.isWholeComment).toBe(true);
  });

  it("always finalizes comment typing cleanup even when dispatch fails", async () => {
    const dispatchReplyFromConfig = vi.fn(async () => {
      throw new Error("dispatch failed");
    });
    const runtime = createTestRuntime({ dispatchReplyFromConfig });
    setFeishuRuntime(runtime);
    const markRunComplete = vi.fn();
    const markDispatchIdle = vi.fn();
    const cleanupTypingReaction = vi.fn(async () => {});
    createFeishuCommentReplyDispatcherMock.mockReturnValue({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      replyOptions: {},
      markDispatchIdle,
      markRunComplete,
      startTypingReaction: vi.fn(async () => {}),
      cleanupTypingReaction,
    });

    await expect(
      handleFeishuCommentEvent({
        cfg: buildConfig(),
        accountId: "default",
        event: { event_id: "evt_1" },
        botOpenId: "ou_bot",
        runtime: {
          log: vi.fn(),
          error: vi.fn(),
        } as never,
      }),
    ).rejects.toThrow("dispatch failed");

    expect(markRunComplete).toHaveBeenCalledTimes(1);
    expect(markDispatchIdle).toHaveBeenCalledTimes(1);
    expect(cleanupTypingReaction).toHaveBeenCalledTimes(1);
  });

  it("does not wait for comment typing cleanup before returning", async () => {
    let resolveCleanup: (() => void) | undefined;
    const cleanupTypingReaction = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        }),
    );
    createFeishuCommentReplyDispatcherMock.mockReturnValue({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      markRunComplete: vi.fn(),
      startTypingReaction: vi.fn(async () => {}),
      cleanupTypingReaction,
    });

    const eventPromise = handleFeishuCommentEvent({
      cfg: buildConfig(),
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    const status = await raceWithNextMacrotask(eventPromise.then(() => "done"));

    expect(status).toBe("done");
    expect(cleanupTypingReaction).toHaveBeenCalledTimes(1);

    resolveCleanup?.();
    await eventPromise;
  });

  it("does not start comment typing reaction before dispatch begins", async () => {
    const startTypingReaction = vi.fn(async () => {});
    createFeishuCommentReplyDispatcherMock.mockReturnValue({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      markRunComplete: vi.fn(),
      startTypingReaction,
      cleanupTypingReaction: vi.fn(async () => {}),
    });

    await handleFeishuCommentEvent({
      cfg: buildConfig(),
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    expect(startTypingReaction).not.toHaveBeenCalled();
    const runtime = (await import("./runtime.js")).getFeishuRuntime();
    const dispatchReplyFromConfig = runtime.channel.reply.dispatchReplyFromConfig as ReturnType<
      typeof vi.fn
    >;
    expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });
});
