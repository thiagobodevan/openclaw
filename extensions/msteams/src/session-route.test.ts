import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMSTeamsCurrentConversationRoute } from "./session-route.js";

const bindingRuntimeMocks = vi.hoisted(() => ({
  resolveConfiguredBindingRoute: vi.fn(({ route }: { route: ResolvedAgentRoute }) => ({
    bindingResolution: null,
    route,
  })),
  lookupRuntimeConversationBindingRoute: vi.fn(({ route }: { route: ResolvedAgentRoute }) => ({
    bindingRecord: null,
    route,
  })),
}));

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => bindingRuntimeMocks);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveMSTeamsCurrentConversationRoute", () => {
  const cfg = {
    agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
    bindings: [
      {
        agentId: "service",
        match: {
          channel: "msteams",
          teamId: "team-1",
          peer: { kind: "channel" as const, id: "19:channel@thread.tacv2" },
        },
      },
    ],
  };

  it("accepts the native team and conversation pair for a channel route", () => {
    expect(
      resolveMSTeamsCurrentConversationRoute({
        cfg,
        accountId: "default",
        target: "conversation:19:channel@thread.tacv2",
        conversationId: "team-1/19:channel@thread.tacv2",
        chatType: "channel",
        groupSpace: "team-1",
        audienceEvidence: [
          { source: "route", value: "conversation:19:channel@thread.tacv2" },
          { source: "origin-native", value: "team-1/19:channel@thread.tacv2" },
        ],
        requireAudienceValidation: true,
      }),
    ).toMatchObject({
      agentId: "service",
      sessionKey: "agent:service:msteams:channel:19:channel@thread.tacv2",
      matchedBy: "binding.peer",
      audienceValidated: true,
    });
  });

  it("rejects a native conversation from another channel", () => {
    expect(
      resolveMSTeamsCurrentConversationRoute({
        cfg,
        accountId: "default",
        target: "conversation:19:channel@thread.tacv2",
        conversationId: "team-1/19:stale@thread.tacv2",
        chatType: "channel",
        groupSpace: "team-1",
      }),
    ).toBeNull();
  });

  it("uses persisted chat type for ambiguous ids and enforces explicit kinds", () => {
    expect(
      resolveMSTeamsCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "user:user-1",
        chatType: "direct",
        senderId: "user-1",
      }),
    ).toMatchObject({ channel: "msteams" });
    expect(
      resolveMSTeamsCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "user-1",
        chatType: "direct",
        senderId: "user-1",
      }),
    ).toBeNull();
    expect(
      resolveMSTeamsCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "conversation:19:conversation@thread.tacv2",
        chatType: "group",
      }),
    ).toMatchObject({
      channel: "msteams",
      sessionKey: "agent:main:msteams:group:19:conversation@thread.tacv2",
    });
    expect(
      resolveMSTeamsCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "channel:group-conversation",
        chatType: "group",
      }),
    ).toBeNull();
    expect(
      resolveMSTeamsCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "group:19:conversation@thread.tacv2",
        chatType: "channel",
      }),
    ).toBeNull();
    expect(
      resolveMSTeamsCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "conversation:shared-conversation",
        chatType: "direct",
        senderId: "shared-conversation",
      }),
    ).toBeNull();
  });

  it("rejects conflicting explicit audience kinds", () => {
    expect(
      resolveMSTeamsCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "group:19:conversation@thread.tacv2",
        chatType: "group",
        audienceEvidence: [
          { source: "route", value: "group:19:conversation@thread.tacv2" },
          { source: "origin-native", value: "channel:19:conversation@thread.tacv2" },
        ],
        requireAudienceValidation: true,
      }),
    ).toBeNull();
  });

  it("keeps team-qualified native evidence channel-scoped", () => {
    expect(
      resolveMSTeamsCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "group:19:conversation@thread.tacv2",
        conversationId: "team-1/19:conversation@thread.tacv2",
        chatType: "group",
        groupSpace: "team-1",
        audienceEvidence: [
          { source: "route", value: "group:19:conversation@thread.tacv2" },
          {
            source: "origin-native",
            value: "team-1/19:conversation@thread.tacv2",
          },
        ],
        requireAudienceValidation: true,
      }),
    ).toBeNull();
  });

  it("rejects direct audience evidence for a shared conversation with the same id", () => {
    expect(
      resolveMSTeamsCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "group:19:conversation@thread.tacv2",
        chatType: "group",
        audienceEvidence: [
          { source: "route", value: "group:19:conversation@thread.tacv2" },
          { source: "origin-native", value: "dm:19:conversation@thread.tacv2" },
        ],
        requireAudienceValidation: true,
      }),
    ).toBeNull();
  });

  it("does not treat an empty evidence set as channel-owned proof", () => {
    expect(
      resolveMSTeamsCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "group:19:conversation@thread.tacv2",
        chatType: "group",
        audienceEvidence: [],
        requireAudienceValidation: true,
      }),
    ).toBeNull();
  });
});
