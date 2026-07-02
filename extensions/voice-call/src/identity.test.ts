import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveVoiceCallConfig } from "./config.js";
import {
  isVoiceCallInboundIdentityCurrent,
  resolveVoiceCallInboundAdmission,
  resolveVoiceCallInboundIdentity,
} from "./identity.js";

const coreConfig = {
  agents: {
    list: [{ id: "main", default: true }, { id: "team-service" }],
  },
} as OpenClawConfig;

describe("resolveVoiceCallInboundIdentity", () => {
  it("does not treat an allowlisted caller as the personal owner", () => {
    const decision = resolveVoiceCallInboundIdentity({
      config: resolveVoiceCallConfig({
        inboundPolicy: "allowlist",
        allowFrom: ["+15550001111"],
      }),
      coreConfig,
      from: "+15550001111",
    });

    expect(decision).toEqual({ mode: "external", allowed: false, reason: "untrusted_direct" });
    expect(
      resolveVoiceCallInboundAdmission({
        config: resolveVoiceCallConfig({
          inboundPolicy: "allowlist",
          allowFrom: ["+15550001111"],
        }),
        coreConfig,
        from: "+15550001111",
      }),
    ).toBeUndefined();
  });

  it("denies an open inbound call instead of inheriting the personal agent", () => {
    const decision = resolveVoiceCallInboundIdentity({
      config: resolveVoiceCallConfig({ inboundPolicy: "open" }),
      coreConfig,
      from: "+15550002222",
    });

    expect(decision).toEqual({ mode: "external", allowed: false, reason: "untrusted_direct" });
  });

  it("allows an open inbound number route bound to a service agent", () => {
    const config = resolveVoiceCallConfig({
      inboundPolicy: "open",
      numbers: {
        "+15550003333": { agentId: "team-service" },
      },
    });
    const decision = resolveVoiceCallInboundIdentity({
      config,
      coreConfig,
      from: "+15550002222",
      to: "+15550003333",
    });

    expect(decision).toEqual({
      mode: "organization",
      allowed: true,
      reason: "bound_service_agent",
    });
    expect(
      resolveVoiceCallInboundAdmission({
        config,
        coreConfig,
        from: "+1 (555) 000-2222",
        to: "+15550003333",
      }),
    ).toEqual({
      agentId: "team-service",
      routeMatchedBy: "config.agent",
      chatType: "direct",
      senderId: "+15550002222",
      senderE164: "+15550002222",
      senderIsOwner: false,
      responsePolicy: { model: null, systemPrompt: null, timeoutMs: 30000 },
    });
  });

  it("keeps a restored service identity only while its agent remains current", () => {
    const identity = {
      agentId: "team-service",
      routeMatchedBy: "config.agent" as const,
      chatType: "direct" as const,
      senderIsOwner: false as const,
      responsePolicy: { model: null, systemPrompt: null, timeoutMs: 30000 },
    };

    expect(
      isVoiceCallInboundIdentityCurrent({
        coreConfig,
        identity,
      }),
    ).toBe(true);
    expect(
      isVoiceCallInboundIdentityCurrent({
        coreConfig: {},
        identity,
      }),
    ).toBe(false);
  });
});
