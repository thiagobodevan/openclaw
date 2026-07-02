// Slack plugin module implements slash harness behavior.
import { vi } from "vitest";

type AsyncMock = ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;

const mocks = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  readAllowFromStoreMock: vi.fn(),
  upsertPairingRequestMock: vi.fn(),
  resolveAgentRouteMock: vi.fn(),
  lookupRuntimeConversationBindingRouteMock: vi.fn(),
  touchRuntimeConversationBindingRouteMock: vi.fn(),
  resolveConfiguredBindingRouteMock: vi.fn(),
  ensureConfiguredBindingRouteReadyMock: vi.fn(),
  finalizeInboundContextMock: vi.fn(),
  resolveConversationLabelMock: vi.fn(),
  recordSessionMetaFromInboundMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  resolveStorePathMock: vi.fn(),
  deliverSlackSlashRepliesMock: vi.fn<(params: unknown) => Promise<unknown>>(async () => {}),
}));

vi.mock("./slash-dispatch.runtime.js", () => {
  return {
    deliverSlackSlashReplies: (params: unknown) => mocks.deliverSlackSlashRepliesMock(params),
    dispatchReplyWithDispatcher: (...args: unknown[]) => mocks.dispatchMock(...args),
    finalizeInboundContext: (...args: unknown[]) => mocks.finalizeInboundContextMock(...args),
    resolveAgentRoute: (...args: unknown[]) => mocks.resolveAgentRouteMock(...args),
    lookupRuntimeConversationBindingRoute: (...args: unknown[]) =>
      mocks.lookupRuntimeConversationBindingRouteMock(...args),
    touchRuntimeConversationBindingRoute: (...args: unknown[]) =>
      mocks.touchRuntimeConversationBindingRouteMock(...args),
    resolveConfiguredBindingRoute: (...args: unknown[]) =>
      mocks.resolveConfiguredBindingRouteMock(...args),
    ensureConfiguredBindingRouteReady: (...args: unknown[]) =>
      mocks.ensureConfiguredBindingRouteReadyMock(...args),
    resolveChunkMode: vi.fn(() => "auto"),
    resolveConversationLabel: (...args: unknown[]) => mocks.resolveConversationLabelMock(...args),
    resolveMarkdownTableMode: vi.fn(() => "auto"),
    recordInboundSessionMetaSafe: (...args: unknown[]) =>
      mocks.recordSessionMetaFromInboundMock(...args),
  };
});

vi.mock("./conversation.runtime.js", () => ({
  upsertChannelPairingRequest: (...args: unknown[]) => mocks.upsertPairingRequestMock(...args),
}));

type SlashHarnessMocks = {
  dispatchMock: ReturnType<typeof vi.fn>;
  readAllowFromStoreMock: ReturnType<typeof vi.fn>;
  upsertPairingRequestMock: ReturnType<typeof vi.fn>;
  resolveAgentRouteMock: ReturnType<typeof vi.fn>;
  lookupRuntimeConversationBindingRouteMock: ReturnType<typeof vi.fn>;
  touchRuntimeConversationBindingRouteMock: ReturnType<typeof vi.fn>;
  resolveConfiguredBindingRouteMock: ReturnType<typeof vi.fn>;
  ensureConfiguredBindingRouteReadyMock: ReturnType<typeof vi.fn>;
  finalizeInboundContextMock: ReturnType<typeof vi.fn>;
  resolveConversationLabelMock: ReturnType<typeof vi.fn>;
  recordSessionMetaFromInboundMock: AsyncMock;
  resolveStorePathMock: ReturnType<typeof vi.fn>;
  deliverSlackSlashRepliesMock: AsyncMock;
};

export function getSlackSlashMocks(): SlashHarnessMocks {
  return mocks;
}

export function resetSlackSlashMocks() {
  mocks.dispatchMock.mockReset().mockResolvedValue({ counts: { final: 1, tool: 0, block: 0 } });
  mocks.readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  mocks.upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
  mocks.resolveAgentRouteMock.mockReset().mockImplementation((params: unknown) => {
    const peerKind = (params as { peer?: { kind?: string } })?.peer?.kind;
    return peerKind === "direct"
      ? {
          agentId: "main",
          sessionKey: "session:1",
          accountId: "acct",
        }
      : {
          agentId: "team",
          sessionKey: "session:team",
          accountId: "acct",
          matchedBy: "binding.peer",
        };
  });
  mocks.lookupRuntimeConversationBindingRouteMock
    .mockReset()
    .mockImplementation(({ route }: { route: unknown }) => ({ bindingRecord: null, route }));
  mocks.touchRuntimeConversationBindingRouteMock.mockReset();
  mocks.resolveConfiguredBindingRouteMock
    .mockReset()
    .mockImplementation(({ route }: { route: unknown }) => ({
      bindingResolution: null,
      route,
    }));
  mocks.ensureConfiguredBindingRouteReadyMock.mockReset().mockResolvedValue({ ok: true });
  mocks.finalizeInboundContextMock.mockReset().mockImplementation((ctx: unknown) => ctx);
  mocks.resolveConversationLabelMock.mockReset().mockReturnValue(undefined);
  mocks.recordSessionMetaFromInboundMock.mockReset().mockResolvedValue(undefined);
  mocks.resolveStorePathMock.mockReset().mockReturnValue("/tmp/openclaw-sessions.json");
  mocks.deliverSlackSlashRepliesMock.mockReset().mockResolvedValue(undefined);
}
