// Google Meet tests cover shared-audience agent consultation identity.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { EXTERNAL_CONVERSATION_IDENTITY_DENIAL } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";
import { consultOpenClawAgentForGoogleMeet, testing } from "./agent-consult.js";
import type { GoogleMeetConfig } from "./config.js";

const fullConfig = {
  agents: { list: [{ id: "personal", default: true }, { id: "meeting-service" }] },
} as OpenClawConfig;

function meetConfig(agentId?: string): GoogleMeetConfig {
  return { realtime: { agentId } } as GoogleMeetConfig;
}

describe("Google Meet consult identity", () => {
  it("denies consultation before runtime preparation when no service agent is configured", async () => {
    await expect(
      consultOpenClawAgentForGoogleMeet({
        config: meetConfig(),
        fullConfig,
        runtime: {} as never,
        logger: {} as never,
        meetingSessionId: "meeting-1",
        args: {},
        transcript: [],
      }),
    ).rejects.toThrow(EXTERNAL_CONVERSATION_IDENTITY_DENIAL);
  });

  it("accepts only an explicit non-personal service agent for the meeting audience", () => {
    expect(
      testing.resolveGoogleMeetConsultIdentity({
        config: meetConfig("personal"),
        fullConfig,
        meetingSessionId: "meeting-1",
      }).decision,
    ).toMatchObject({ mode: "external", allowed: false });
    expect(
      testing.resolveGoogleMeetConsultIdentity({
        config: meetConfig("meeting-service"),
        fullConfig,
        meetingSessionId: "meeting-1",
      }).decision,
    ).toMatchObject({ mode: "organization", allowed: true });
  });
});
