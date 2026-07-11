import { testing as sessionBindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveSignalCurrentConversationRoute } from "./session-route.js";

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});

describe("resolveSignalCurrentConversationRoute", () => {
  const uuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

  it("certifies equivalent direct uuid forms against the current service route", () => {
    expect(
      resolveSignalCurrentConversationRoute({
        cfg: {
          agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
          bindings: [
            {
              agentId: "service",
              match: {
                channel: "signal",
                peer: { kind: "direct", id: `uuid:${uuid}` },
              },
            },
          ],
        },
        accountId: "default",
        target: `uuid:${uuid}`,
        conversationId: uuid,
        chatType: "direct",
        senderId: `signal:uuid:${uuid}`,
        audienceEvidence: [
          { source: "route", value: `uuid:${uuid}` },
          { source: "origin-native", value: uuid },
          { source: "origin-target", value: `signal:${uuid}` },
        ],
        requireAudienceValidation: true,
      }),
    ).toMatchObject({
      agentId: "service",
      channel: "signal",
      audienceValidated: true,
    });
  });

  it("certifies equivalent group forms", () => {
    expect(
      resolveSignalCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "group:shared-1",
        conversationId: "signal:group:shared-1",
        chatType: "group",
        audienceEvidence: [
          { source: "route", value: "group:shared-1" },
          { source: "origin-target", value: "signal:group:shared-1" },
        ],
        requireAudienceValidation: true,
      }),
    ).toMatchObject({ channel: "signal", audienceValidated: true });
  });

  it("rejects a shared target persisted as a direct audience", () => {
    expect(
      resolveSignalCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "group:shared-1",
        chatType: "direct",
        senderId: "group:shared-1",
      }),
    ).toBeNull();
  });
});
