import { describe, expect, it } from "vitest";
import { clickClackPlugin } from "./channel.js";
import type { CoreConfig } from "./types.js";

describe("clickClackPlugin current conversation routing", () => {
  it("revalidates the account service agent instead of falling back to core routing", async () => {
    const cfg: CoreConfig = {
      agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
      channels: {
        clickclack: {
          baseUrl: "https://chat.example.test",
          token: "test-token",
          workspace: "ops",
          agentId: "service",
        },
      },
    };

    const route = await clickClackPlugin.messaging?.resolveCurrentConversationRoute?.({
      cfg,
      accountId: "default",
      target: "channel:operations",
      conversationId: "operations",
      chatType: "group",
      senderId: "user-1",
      audienceEvidence: [
        { source: "route", value: "channel:operations" },
        { source: "origin-native", value: "operations" },
      ],
      requireAudienceValidation: true,
    });

    expect(route).toMatchObject({
      agentId: "service",
      sessionKey: "agent:service:clickclack:channel:channel:operations",
      mainSessionKey: "agent:service:main",
      matchedBy: "config.agent",
      audienceValidated: true,
    });
  });

  it("rejects conflicting persisted group evidence", async () => {
    const route = await clickClackPlugin.messaging?.resolveCurrentConversationRoute?.({
      cfg: {},
      accountId: "default",
      target: "channel:operations",
      conversationId: "operations",
      chatType: "group",
      audienceEvidence: [
        { source: "route", value: "channel:operations" },
        { source: "group", value: "channel:engineering" },
      ],
      requireAudienceValidation: true,
    });

    expect(route).toBeNull();
  });

  it("rejects a thread whose persisted channel parent is not channel-owned proof", async () => {
    const route = await clickClackPlugin.messaging?.resolveCurrentConversationRoute?.({
      cfg: {},
      accountId: "default",
      target: "thread:root-1",
      conversationId: "channel:operations",
      chatType: "group",
      audienceEvidence: [
        { source: "route", value: "thread:root-1" },
        { source: "origin-native", value: "channel:operations" },
      ],
      requireAudienceValidation: true,
    });

    expect(route).toBeNull();
  });

  it("rejects a persisted target whose chat type no longer agrees", async () => {
    const route = await clickClackPlugin.messaging?.resolveCurrentConversationRoute?.({
      cfg: {},
      accountId: "default",
      target: "dm:user-1",
      chatType: "group",
    });

    expect(route).toBeNull();
  });

  it("rejects a direct target that disagrees with its persisted sender", async () => {
    const route = await clickClackPlugin.messaging?.resolveCurrentConversationRoute?.({
      cfg: {},
      accountId: "default",
      target: "dm:user-1",
      chatType: "direct",
      senderId: "user-2",
      audienceEvidence: [
        { source: "route", value: "dm:user-1" },
        { source: "last", value: "dm:user-1" },
      ],
      requireAudienceValidation: true,
    });

    expect(route).toBeNull();
  });

  it("certifies matching direct target and sender evidence", async () => {
    const route = await clickClackPlugin.messaging?.resolveCurrentConversationRoute?.({
      cfg: {},
      accountId: "default",
      target: "dm:user-1",
      chatType: "direct",
      senderId: "user-1",
      audienceEvidence: [
        { source: "route", value: "dm:user-1" },
        { source: "origin-target", value: "dm:user-1" },
      ],
      requireAudienceValidation: true,
    });

    expect(route).toMatchObject({
      channel: "clickclack",
      accountId: "default",
      audienceValidated: true,
    });
  });
});
