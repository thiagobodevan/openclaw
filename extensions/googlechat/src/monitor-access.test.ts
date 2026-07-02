// Googlechat tests cover monitor access plugin behavior.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const createChannelPairingController = vi.hoisted(() => vi.fn());
const isDangerousNameMatchingEnabled = vi.hoisted(() => vi.fn());
const resolveAllowlistProviderRuntimeGroupPolicy = vi.hoisted(() => vi.fn());
const resolveDefaultGroupPolicy = vi.hoisted(() => vi.fn());
const warnMissingProviderGroupPolicyFallbackOnce = vi.hoisted(() => vi.fn());
const sendGoogleChatMessage = vi.hoisted(() => vi.fn());
const resolveConversationIdentityMode = vi.hoisted(() =>
  vi.fn(() => ({ mode: "organization", allowed: true, reason: "bound_service_agent" })),
);

vi.mock("../runtime-api.js", () => ({
  GROUP_POLICY_BLOCKED_LABEL: { space: "space" },
  createChannelPairingController,
  isDangerousNameMatchingEnabled,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveConversationIdentityMode,
  warnMissingProviderGroupPolicyFallbackOnce,
}));

vi.mock("./api.js", () => ({
  sendGoogleChatMessage,
}));

function createCore() {
  return {
    channel: {
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
        shouldHandleTextCommands: vi.fn(() => false),
        isControlCommandMessage: vi.fn(() => false),
      },
      text: {
        hasControlCommand: vi.fn(() => false),
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "googlechat-service",
          sessionKey: "agent:googlechat-service:googlechat:direct:spaces/AAA",
          matchedBy: "binding.peer",
        })),
      },
    },
  };
}

function primeCommonDefaults() {
  sendGoogleChatMessage.mockReset();
  isDangerousNameMatchingEnabled.mockReturnValue(false);
  resolveDefaultGroupPolicy.mockReturnValue("allowlist");
  resolveAllowlistProviderRuntimeGroupPolicy.mockReturnValue({
    groupPolicy: "allowlist",
    providerMissingFallbackApplied: false,
  });
  warnMissingProviderGroupPolicyFallbackOnce.mockReturnValue(undefined);
  resolveConversationIdentityMode.mockReturnValue({
    mode: "organization",
    allowed: true,
    reason: "bound_service_agent",
  });
}

const baseAccessConfig = {
  channels: { googlechat: {} },
  commands: { useAccessGroups: true },
} as const;

const defaultSender = {
  senderId: "users/alice",
  senderName: "Alice",
  senderEmail: "alice@example.com",
} as const;

let applyGoogleChatInboundAccessPolicy: typeof import("./monitor-access.js").applyGoogleChatInboundAccessPolicy;
let resolveGoogleChatStableSenderIsOwner: typeof import("./monitor-access.js").resolveGoogleChatStableSenderIsOwner;

function allowInboundGroupTraffic() {
  createChannelPairingController.mockReturnValue({
    readAllowFromStore: vi.fn(async () => []),
    issueChallenge: vi.fn(),
  });
}

async function applyInboundAccessPolicy(
  overrides: Partial<Parameters<typeof applyGoogleChatInboundAccessPolicy>[0]>,
) {
  return applyGoogleChatInboundAccessPolicy({
    account: {
      accountId: "default",
      config: {},
    } as never,
    config: baseAccessConfig as never,
    core: createCore() as never,
    space: { name: "spaces/AAA", displayName: "Team Room" } as never,
    message: { annotations: [] } as never,
    isGroup: true,
    rawBody: "hello team",
    logVerbose: vi.fn(),
    ...defaultSender,
    ...overrides,
  } as never);
}

describe("googlechat inbound access policy", () => {
  beforeAll(async () => {
    ({ applyGoogleChatInboundAccessPolicy, resolveGoogleChatStableSenderIsOwner } =
      await import("./monitor-access.js"));
  });

  it("recognizes owners only by stable ids and gives command owners precedence", () => {
    const account = {
      accountId: "default",
      config: { dm: { allowFrom: ["users/account-owner"] } },
    } as never;

    expect(
      resolveGoogleChatStableSenderIsOwner({
        config: { commands: { ownerAllowFrom: ["googlechat:users/command-owner"] } } as never,
        account,
        senderId: "users/command-owner",
      }),
    ).toBe(true);
    expect(
      resolveGoogleChatStableSenderIsOwner({
        config: { commands: { ownerAllowFrom: ["googlechat:users/command-owner"] } } as never,
        account,
        senderId: "users/account-owner",
      }),
    ).toBe(false);
    expect(
      resolveGoogleChatStableSenderIsOwner({
        config: {} as never,
        account: {
          accountId: "default",
          config: { dm: { allowFrom: ["Alice Example"] } },
        } as never,
        senderId: "users/alice",
      }),
    ).toBe(false);
    expect(
      resolveGoogleChatStableSenderIsOwner({
        config: { commands: { ownerAllowFrom: ["*"] } } as never,
        account,
        senderId: "users/account-owner",
      }),
    ).toBe(false);
  });

  afterAll(() => {
    vi.doUnmock("../runtime-api.js");
    vi.doUnmock("./api.js");
    vi.resetModules();
  });

  it.each([
    {
      name: "blocks raw email entries when dangerous name matching is disabled",
      allowNameMatching: false,
      allowFrom: ["jane@example.com"],
      senderId: "users/123",
      ok: false,
    },
    {
      name: "matches raw email entries when dangerous name matching is enabled",
      allowNameMatching: true,
      allowFrom: ["jane@example.com"],
      senderId: "users/123",
      ok: true,
    },
    {
      name: "does not treat users/<email> entries as email allowlist entries",
      allowNameMatching: true,
      allowFrom: ["users/jane@example.com"],
      senderId: "users/123",
      ok: false,
    },
    {
      name: "matches user id entries",
      allowNameMatching: false,
      allowFrom: ["users/abc"],
      senderId: "users/abc",
      ok: true,
    },
  ])("$name", async ({ allowNameMatching, allowFrom, senderId, ok }) => {
    primeCommonDefaults();
    isDangerousNameMatchingEnabled.mockReturnValue(allowNameMatching);
    createChannelPairingController.mockReturnValue({
      readAllowFromStore: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });

    const result = await applyInboundAccessPolicy({
      isGroup: false,
      account: {
        accountId: "default",
        config: {
          dm: {
            policy: "allowlist",
            allowFrom,
          },
        },
      } as never,
      senderId,
      senderEmail: "Jane@Example.com",
    });
    expect(result.ok).toBe(ok);
  });

  it("issues a pairing challenge for unauthorized DMs in pairing mode", async () => {
    primeCommonDefaults();
    const now = new Date("2026-05-09T06:35:00.000Z").getTime();
    const issueChallenge = vi.fn(async ({ onCreated, sendPairingReply }) => {
      onCreated?.();
      await sendPairingReply("pairing text");
    });
    createChannelPairingController.mockReturnValue({
      readAllowFromStore: vi.fn(async () => []),
      issueChallenge,
    });
    sendGoogleChatMessage.mockResolvedValue({ ok: true });

    const statusSink = vi.fn();
    const logVerbose = vi.fn();
    const account = {
      accountId: "default",
      config: {
        dm: { policy: "pairing" },
      },
    };

    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      await expect(
        applyGoogleChatInboundAccessPolicy({
          account: account as never,
          config: {
            channels: { googlechat: {} },
          } as never,
          core: createCore() as never,
          space: { name: "spaces/AAA", displayName: "DM" } as never,
          message: { annotations: [] } as never,
          isGroup: false,
          senderId: "users/abc",
          senderName: "Alice",
          senderEmail: "alice@example.com",
          rawBody: "hello",
          statusSink,
          logVerbose,
        }),
      ).resolves.toEqual({ ok: false });

      expect(issueChallenge).toHaveBeenCalledTimes(1);
      expect(sendGoogleChatMessage).toHaveBeenCalledWith({
        account,
        space: "spaces/AAA",
        text: "pairing text",
      });
      expect(statusSink).toHaveBeenCalledWith({
        lastOutboundAt: now,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not pair an unauthorized DM onto a denied personal identity", async () => {
    primeCommonDefaults();
    const issueChallenge = vi.fn();
    createChannelPairingController.mockReturnValue({
      readAllowFromStore: vi.fn(async () => []),
      issueChallenge,
    });
    resolveConversationIdentityMode.mockReturnValue({
      mode: "external",
      allowed: false,
      reason: "untrusted_direct",
    });

    await expect(
      applyGoogleChatInboundAccessPolicy({
        account: {
          accountId: "default",
          config: { dm: { policy: "pairing" } },
        } as never,
        config: { channels: { googlechat: {} } } as never,
        core: createCore() as never,
        space: { name: "spaces/AAA", displayName: "DM" } as never,
        message: { annotations: [] } as never,
        isGroup: false,
        senderId: "users/guest",
        senderName: "Guest",
        rawBody: "hello",
        logVerbose: vi.fn(),
      }),
    ).resolves.toEqual({ ok: false });
    expect(issueChallenge).not.toHaveBeenCalled();
    expect(sendGoogleChatMessage).not.toHaveBeenCalled();
  });

  it("allows group traffic when sender and mention gates pass", async () => {
    primeCommonDefaults();
    allowInboundGroupTraffic();
    const core = createCore();
    core.channel.commands.shouldComputeCommandAuthorized.mockReturnValue(true);
    core.channel.commands.resolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    await expect(
      applyInboundAccessPolicy({
        account: {
          accountId: "default",
          config: {
            botUser: "users/app-bot",
            groups: {
              "spaces/AAA": {
                users: ["users/alice"],
                requireMention: true,
                systemPrompt: " group prompt ",
              },
            },
          },
        } as never,
        core: core as never,
        message: {
          annotations: [
            {
              type: "USER_MENTION",
              userMention: { user: { name: "users/app-bot" } },
            },
          ],
        } as never,
      }),
    ).resolves.toEqual({
      ok: true,
      commandAuthorized: true,
      effectiveWasMentioned: true,
      groupSystemPrompt: "group prompt",
    });
  });

  it("allows group traffic from generic message sender access groups", async () => {
    primeCommonDefaults();
    allowInboundGroupTraffic();

    const result = await applyInboundAccessPolicy({
      config: {
        ...baseAccessConfig,
        accessGroups: {
          operators: {
            type: "message.senders",
            members: {
              googlechat: ["users/alice"],
            },
          },
        },
      } as never,
      account: {
        accountId: "default",
        config: {
          groups: {
            "spaces/AAA": {
              users: ["accessGroup:operators"],
              requireMention: false,
            },
          },
        },
      } as never,
    });
    expect(result.ok).toBe(true);
  });

  it("expands generic message sender access groups before DM access checks", async () => {
    primeCommonDefaults();
    const readAllowFromStore = vi.fn(async () => []);
    createChannelPairingController.mockReturnValue({
      readAllowFromStore,
      issueChallenge: vi.fn(),
    });

    const result = await applyInboundAccessPolicy({
      isGroup: false,
      config: {
        ...baseAccessConfig,
        accessGroups: {
          operators: {
            type: "message.senders",
            members: {
              googlechat: ["users/alice"],
            },
          },
        },
      } as never,
      account: {
        accountId: "default",
        config: {
          dm: {
            policy: "allowlist",
            allowFrom: ["accessGroup:operators"],
          },
        },
      } as never,
    });
    expect(result.ok).toBe(true);

    expect(readAllowFromStore).not.toHaveBeenCalled();
  });

  it("preserves allowlist group policy when a routed space has no sender allowlist", async () => {
    primeCommonDefaults();
    allowInboundGroupTraffic();
    const logVerbose = vi.fn();

    await expect(
      applyInboundAccessPolicy({
        account: {
          accountId: "default",
          config: {
            dm: {
              policy: "allowlist",
              allowFrom: ["users/alice"],
            },
            groups: {
              "spaces/AAA": {
                enabled: true,
              },
            },
          },
        } as never,
        logVerbose,
      }),
    ).resolves.toEqual({ ok: false });

    expect(logVerbose).toHaveBeenCalledWith(
      "drop group message (sender policy blocked, reason=groupPolicy=allowlist (empty allowlist), space=spaces/AAA)",
    );
  });

  it("keeps configured space users sender-scoped when group policy is open", async () => {
    primeCommonDefaults();
    resolveAllowlistProviderRuntimeGroupPolicy.mockReturnValue({
      groupPolicy: "open",
      providerMissingFallbackApplied: false,
    });
    allowInboundGroupTraffic();
    const logVerbose = vi.fn();

    await expect(
      applyInboundAccessPolicy({
        account: {
          accountId: "default",
          config: {
            groupPolicy: "open",
            groups: {
              "spaces/AAA": {
                users: ["users/bob"],
                requireMention: false,
              },
            },
          },
        } as never,
        logVerbose,
      }),
    ).resolves.toEqual({ ok: false });

    expect(logVerbose).toHaveBeenCalledWith("drop group message (sender not allowed, users/alice)");
  });

  it("drops unauthorized group control commands", async () => {
    primeCommonDefaults();
    allowInboundGroupTraffic();
    resolveAllowlistProviderRuntimeGroupPolicy.mockReturnValue({
      groupPolicy: "open",
      providerMissingFallbackApplied: false,
    });
    const core = createCore();
    core.channel.commands.shouldComputeCommandAuthorized.mockReturnValue(true);
    core.channel.commands.isControlCommandMessage.mockReturnValue(true);
    const logVerbose = vi.fn();

    await expect(
      applyInboundAccessPolicy({
        core: core as never,
        account: {
          accountId: "default",
          config: {
            groups: {
              "spaces/AAA": {
                requireMention: false,
              },
            },
          },
        } as never,
        rawBody: "/admin",
        logVerbose,
      }),
    ).resolves.toEqual({ ok: false });

    expect(logVerbose).toHaveBeenCalledWith("googlechat: drop control command from users/alice");
  });

  it("does not match group policy by mutable space displayName when the stable id differs", async () => {
    primeCommonDefaults();
    allowInboundGroupTraffic();
    const logVerbose = vi.fn();

    await expect(
      applyInboundAccessPolicy({
        account: {
          accountId: "default",
          config: {
            groups: {
              "Finance Ops": {
                users: ["users/alice"],
                requireMention: true,
                systemPrompt: "finance-only prompt",
              },
            },
          },
        } as never,
        core: createCore() as never,
        space: { name: "spaces/BBB", displayName: "Finance Ops" } as never,
        message: {
          annotations: [
            {
              type: "USER_MENTION",
              userMention: { user: { name: "users/app" } },
            },
          ],
        } as never,
        rawBody: "show quarter close status",
        logVerbose,
      }),
    ).resolves.toEqual({ ok: false });

    expect(logVerbose).toHaveBeenCalledWith(
      "Deprecated Google Chat group key detected: group routing now requires stable space ids (spaces/<spaceId>). Update channels.googlechat.groups keys: Finance Ops",
    );
    expect(logVerbose).toHaveBeenCalledWith(
      "drop group message (deprecated mutable group key matched, space=spaces/BBB)",
    );
  });

  it("fails closed instead of falling back to wildcard when a deprecated room key matches", async () => {
    primeCommonDefaults();
    resolveAllowlistProviderRuntimeGroupPolicy.mockReturnValue({
      groupPolicy: "open",
      providerMissingFallbackApplied: false,
    });
    allowInboundGroupTraffic();
    const logVerbose = vi.fn();

    await expect(
      applyInboundAccessPolicy({
        account: {
          accountId: "default",
          config: {
            groupPolicy: "open",
            groups: {
              "*": {
                users: ["users/alice"],
              },
              "Finance Ops": {
                enabled: false,
                users: ["users/bob"],
              },
            },
          },
        } as never,
        core: createCore() as never,
        space: { name: "spaces/BBB", displayName: "Finance Ops" } as never,
        rawBody: "show quarter close status",
        logVerbose,
      }),
    ).resolves.toEqual({ ok: false });

    expect(logVerbose).toHaveBeenCalledWith(
      "drop group message (deprecated mutable group key matched, space=spaces/BBB)",
    );
  });
});
