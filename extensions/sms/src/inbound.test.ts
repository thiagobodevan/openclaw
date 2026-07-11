// Sms tests cover inbound plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { dispatchSmsInboundEvent, type SmsChannelRuntime } from "./inbound.js";
import type { sendSmsViaTwilio as sendSmsViaTwilioType } from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";

const sendSmsViaTwilio = vi.hoisted(() =>
  vi.fn<typeof sendSmsViaTwilioType>(async () => ({ sid: "SM-pair", to: "+15551234567" })),
);

vi.mock("./twilio.js", () => ({
  sendSmsViaTwilio,
}));

function createAccount(overrides: Partial<ResolvedSmsAccount> = {}): ResolvedSmsAccount {
  return {
    accountId: "default",
    enabled: true,
    accountSid: "AC123",
    authToken: "secret",
    fromNumber: "+15557654321",
    messagingServiceSid: "",
    defaultTo: "",
    webhookPath: "/webhooks/sms",
    publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "pairing",
    allowFrom: [],
    textChunkLimit: 1500,
    ...overrides,
  };
}

function createRuntime() {
  const readAllowFromStore = vi.fn(async () => [] as string[]);
  const upsertPairingRequest = vi.fn(async () => ({ code: "PAIR123", created: true }));
  const resolveAgentRoute = vi.fn();
  const run = vi.fn<
    (params: {
      adapter: {
        ingest: (msg: {
          from: string;
          to: string;
          body: string;
          messageSid: string;
          accountSid: string;
        }) => unknown;
        resolveTurn: (ingested: unknown) => Promise<{ routeSessionKey: string }>;
      };
    }) => void
  >();
  const buildContext = vi.fn();
  const resolveStorePath = vi.fn();
  const runtime = {
    pairing: {
      readAllowFromStore,
      upsertPairingRequest,
    },
    routing: {
      resolveAgentRoute,
    },
    inbound: {
      run,
      buildContext,
    },
    session: {
      resolveStorePath,
      recordInboundSession: vi.fn(),
    },
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
    },
  } as unknown as SmsChannelRuntime;
  return {
    runtime,
    readAllowFromStore,
    upsertPairingRequest,
    resolveAgentRoute,
    run,
    buildContext,
    resolveStorePath,
  };
}

describe("dispatchSmsInboundEvent", () => {
  it("creates and sends a pairing challenge for first-time SMS senders", async () => {
    const { runtime, readAllowFromStore, upsertPairingRequest, resolveAgentRoute, run } =
      createRuntime();
    resolveAgentRoute.mockReturnValue({
      agentId: "main",
      accountId: "default",
      sessionKey: "agent:main:sms:direct:+15551234567",
      matchedBy: "default",
    });
    sendSmsViaTwilio.mockClear();

    await dispatchSmsInboundEvent({
      cfg: {},
      account: createAccount(),
      channelRuntime: runtime,
      msg: {
        from: "+15551234567",
        to: "+15557654321",
        body: "hello",
        messageSid: "SM-inbound",
        accountSid: "AC123",
      },
    });

    expect(readAllowFromStore).toHaveBeenCalledWith({
      channel: "sms",
      accountId: "default",
    });
    expect(upsertPairingRequest).toHaveBeenCalledWith({
      channel: "sms",
      accountId: "default",
      id: "+15551234567",
      meta: undefined,
    });
    expect(sendSmsViaTwilio).toHaveBeenCalledOnce();
    expect(sendSmsViaTwilio).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+15551234567",
        text: expect.stringContaining("PAIR123"),
      }),
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("dispatches a paired sender to the default personal route", async () => {
    const { runtime, readAllowFromStore, upsertPairingRequest, resolveAgentRoute, run } =
      createRuntime();
    readAllowFromStore.mockResolvedValue(["+15551234567"]);
    resolveAgentRoute.mockReturnValue({
      agentId: "main",
      accountId: "default",
      sessionKey: "agent:main:sms:direct:+15551234567",
      matchedBy: "default",
    });
    sendSmsViaTwilio.mockClear();

    await dispatchSmsInboundEvent({
      cfg: {},
      account: createAccount(),
      channelRuntime: runtime,
      msg: {
        from: "+15551234567",
        to: "+15557654321",
        body: "hello",
        messageSid: "SM-paired",
        accountSid: "AC123",
      },
    });

    expect(readAllowFromStore).toHaveBeenCalledOnce();
    expect(upsertPairingRequest).not.toHaveBeenCalled();
    expect(sendSmsViaTwilio).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
  });

  it("denies a paired sender that does not match the configured command owner", async () => {
    const { runtime, readAllowFromStore, upsertPairingRequest, resolveAgentRoute, run } =
      createRuntime();
    readAllowFromStore.mockResolvedValue(["+15551234567"]);
    resolveAgentRoute.mockReturnValue({
      agentId: "main",
      accountId: "default",
      sessionKey: "agent:main:sms:direct:+15551234567",
      matchedBy: "default",
    });
    sendSmsViaTwilio.mockClear();

    await dispatchSmsInboundEvent({
      cfg: {
        agents: { list: [{ id: "main", default: true }] },
        commands: { ownerAllowFrom: ["+15550000000"] },
      },
      account: createAccount(),
      channelRuntime: runtime,
      msg: {
        from: "+15551234567",
        to: "+15557654321",
        body: "hello",
        messageSid: "SM-untrusted",
        accountSid: "AC123",
      },
    });

    expect(readAllowFromStore).toHaveBeenCalledOnce();
    expect(upsertPairingRequest).not.toHaveBeenCalled();
    expect(sendSmsViaTwilio).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("uses the canonical routed session key for authorized SMS turns", async () => {
    const { runtime, resolveAgentRoute, run, buildContext, resolveStorePath } = createRuntime();
    resolveAgentRoute.mockReturnValue({
      agentId: "team-ops",
      accountId: "default",
      sessionKey: "agent:team-ops:sms:direct:+15551234567",
      matchedBy: "binding.peer",
    });
    buildContext.mockReturnValue({ SessionKey: "agent:team-ops:sms:direct:+15551234567" });
    resolveStorePath.mockReturnValue("/tmp/openclaw-sessions");

    await dispatchSmsInboundEvent({
      cfg: {
        agents: {
          list: [{ id: "main", default: true }, { id: "team-ops" }],
        },
      },
      account: createAccount({
        dmPolicy: "allowlist",
        allowFrom: ["+15551234567"],
      }),
      channelRuntime: runtime,
      msg: {
        from: "+15551234567",
        to: "+15557654321",
        body: "hello",
        messageSid: "SM-inbound",
        accountSid: "AC123",
      },
    });

    const runParams = run.mock.calls[0]?.[0];
    const ingested = runParams.adapter.ingest({
      from: "+15551234567",
      to: "+15557654321",
      body: "hello",
      messageSid: "SM-inbound",
      accountSid: "AC123",
    });
    const turn = await runParams.adapter.resolveTurn(ingested);

    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({
          agentId: "team-ops",
          matchedBy: "binding.peer",
          routeSessionKey: "agent:team-ops:sms:direct:+15551234567",
          dispatchSessionKey: "agent:team-ops:sms:direct:+15551234567",
        }),
      }),
    );
    expect(turn.routeSessionKey).toBe("agent:team-ops:sms:direct:+15551234567");
  });
});
