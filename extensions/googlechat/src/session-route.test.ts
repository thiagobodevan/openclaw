import { testing as sessionBindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { googlechatPlugin } from "./channel.js";

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});

describe("googlechatPlugin current conversation routing", () => {
  it("certifies a DM space target and its distinct sender identity", async () => {
    const route = await googlechatPlugin.messaging?.resolveCurrentConversationRoute?.({
      cfg: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        bindings: [
          {
            agentId: "service",
            match: {
              channel: "googlechat",
              accountId: "default",
              peer: { kind: "direct", id: "spaces/DM" },
            },
          },
        ],
      },
      agentId: "service",
      accountId: "default",
      target: "googlechat:spaces/DM",
      chatType: "direct",
      senderId: "users/123",
      audienceEvidence: [
        { source: "route", value: "spaces/DM" },
        { source: "origin-native", value: "googlechat:spaces/DM" },
        { source: "origin-target", value: "spaces/DM" },
      ],
      requireAudienceValidation: true,
    });

    expect(route).toMatchObject({
      agentId: "service",
      channel: "googlechat",
      matchedBy: "binding.peer",
      audienceValidated: true,
    });
  });

  it("rejects a DM route without a native user sender", async () => {
    const route = await googlechatPlugin.messaging?.resolveCurrentConversationRoute?.({
      cfg: {},
      accountId: "default",
      target: "spaces/DM",
      conversationId: "spaces/DM",
      chatType: "direct",
      senderId: "spaces/DM",
    });

    expect(route).toBeNull();
  });

  it("rejects conflicting persisted DM space evidence", async () => {
    const route = await googlechatPlugin.messaging?.resolveCurrentConversationRoute?.({
      cfg: {},
      accountId: "default",
      target: "spaces/DM",
      conversationId: "spaces/DM",
      chatType: "direct",
      senderId: "users/123",
      audienceEvidence: [
        { source: "route", value: "spaces/DM" },
        { source: "origin-native", value: "spaces/OTHER" },
      ],
      requireAudienceValidation: true,
    });

    expect(route).toBeNull();
  });

  it("preserves shared-space service routing", async () => {
    const route = await googlechatPlugin.messaging?.resolveCurrentConversationRoute?.({
      cfg: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        bindings: [
          {
            agentId: "service",
            match: {
              channel: "googlechat",
              accountId: "default",
              peer: { kind: "group", id: "spaces/TEAM" },
            },
          },
        ],
      },
      agentId: "service",
      accountId: "default",
      target: "spaces/TEAM",
      conversationId: "spaces/TEAM",
      chatType: "channel",
      senderId: "users/123",
      audienceEvidence: [
        { source: "route", value: "spaces/TEAM" },
        { source: "origin-native", value: "spaces/TEAM" },
      ],
      requireAudienceValidation: true,
    });

    expect(route).toMatchObject({
      agentId: "service",
      channel: "googlechat",
      audienceValidated: true,
    });
  });
});
