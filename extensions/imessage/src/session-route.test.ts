import { testing as sessionBindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveIMessageCurrentConversationRoute } from "./session-route.js";

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});

describe("resolveIMessageCurrentConversationRoute", () => {
  it("certifies direct service aliases paired with the current native conversation", () => {
    expect(
      resolveIMessageCurrentConversationRoute({
        cfg: {
          agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
          bindings: [
            {
              agentId: "service",
              match: {
                channel: "imessage",
                peer: { kind: "direct", id: "+15551234567" },
              },
            },
          ],
        },
        accountId: "default",
        target: "imessage:+15551234567",
        conversationId: "42",
        chatType: "direct",
        senderId: "+15551234567",
        audienceEvidence: [
          { source: "route", value: "imessage:+15551234567" },
          { source: "origin-native", value: "chat_id:42" },
          { source: "origin-target", value: "sms:+15551234567" },
        ],
        requireAudienceValidation: true,
      }),
    ).toMatchObject({
      agentId: "service",
      channel: "imessage",
      audienceValidated: true,
    });
  });

  it("certifies equivalent shared conversation forms", () => {
    expect(
      resolveIMessageCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "42",
        conversationId: "chat_id:42",
        chatType: "group",
        audienceEvidence: [
          { source: "delivery", value: "42" },
          { source: "origin-target", value: "chat_id:42" },
        ],
        requireAudienceValidation: true,
      }),
    ).toMatchObject({ channel: "imessage", audienceValidated: true });
  });

  it("rejects a shared target persisted as a direct audience", () => {
    expect(
      resolveIMessageCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "chat_id:42",
        conversationId: "42",
        chatType: "direct",
        senderId: "42",
      }),
    ).toBeNull();
  });
});
