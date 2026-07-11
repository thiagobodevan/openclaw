import { testing as sessionBindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { nextcloudTalkPlugin } from "./channel.js";

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});

describe("nextcloudTalkPlugin current conversation routing", () => {
  it("certifies a DM sender route paired with its distinct room token", async () => {
    const route = await nextcloudTalkPlugin.messaging?.resolveCurrentConversationRoute?.({
      cfg: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        bindings: [
          {
            agentId: "service",
            match: {
              channel: "nextcloud-talk",
              accountId: "default",
              peer: { kind: "direct", id: "user-1" },
            },
          },
        ],
      },
      agentId: "service",
      accountId: "default",
      target: "user-1",
      chatType: "direct",
      senderId: "user-1",
      audienceEvidence: [
        { source: "route", value: "user-1" },
        { source: "delivery", value: "user-1" },
        { source: "origin-target", value: "nextcloud-talk:room-1" },
      ],
      requireAudienceValidation: true,
    });

    expect(route).toMatchObject({
      agentId: "service",
      channel: "nextcloud-talk",
      matchedBy: "binding.peer",
      audienceValidated: true,
    });
  });

  it("rejects conflicting persisted DM sender evidence", async () => {
    const route = await nextcloudTalkPlugin.messaging?.resolveCurrentConversationRoute?.({
      cfg: {},
      accountId: "default",
      target: "user-1",
      chatType: "direct",
      senderId: "user-1",
      audienceEvidence: [
        { source: "route", value: "user-2" },
        { source: "origin-target", value: "room-1" },
      ],
      requireAudienceValidation: true,
    });

    expect(route).toBeNull();
  });

  it("rejects conflicting persisted DM room tokens", async () => {
    const route = await nextcloudTalkPlugin.messaging?.resolveCurrentConversationRoute?.({
      cfg: {},
      accountId: "default",
      target: "user-1",
      conversationId: "room-2",
      chatType: "direct",
      senderId: "user-1",
      audienceEvidence: [
        { source: "route", value: "user-1" },
        { source: "origin-target", value: "room-1" },
      ],
      requireAudienceValidation: true,
    });

    expect(route).toBeNull();
  });

  it("preserves shared-room service routing", async () => {
    const route = await nextcloudTalkPlugin.messaging?.resolveCurrentConversationRoute?.({
      cfg: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        bindings: [
          {
            agentId: "service",
            match: {
              channel: "nextcloud-talk",
              accountId: "default",
              peer: { kind: "group", id: "room-1" },
            },
          },
        ],
      },
      agentId: "service",
      accountId: "default",
      target: "room-1",
      conversationId: "nextcloud-talk:room-1",
      chatType: "group",
      senderId: "user-1",
      audienceEvidence: [
        { source: "route", value: "room-1" },
        { source: "origin-target", value: "nextcloud-talk:room-1" },
      ],
      requireAudienceValidation: true,
    });

    expect(route).toMatchObject({
      agentId: "service",
      channel: "nextcloud-talk",
      audienceValidated: true,
    });
  });
});
