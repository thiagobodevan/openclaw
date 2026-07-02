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
    });

    expect(route).toMatchObject({
      agentId: "service",
      sessionKey: "agent:service:clickclack:channel:channel:operations",
      mainSessionKey: "agent:service:main",
      matchedBy: "config.agent",
    });
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
});
