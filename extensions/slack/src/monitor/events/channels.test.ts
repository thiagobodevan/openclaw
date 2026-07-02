// Slack tests cover channels plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
let registerSlackChannelEvents: typeof import("./channels.js").registerSlackChannelEvents;
let createSlackSystemEventTestHarness: typeof import("./system-event-test-harness.js").createSlackSystemEventTestHarness;

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));
vi.mock("openclaw/plugin-sdk/system-event-runtime.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));
type SlackChannelHandler = (args: {
  event: Record<string, unknown>;
  body: unknown;
}) => Promise<void>;

function createChannelContext(params?: {
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
  resolveRouteReady?: () => Promise<null>;
}) {
  const harness = createSlackSystemEventTestHarness({ channelType: "channel" });
  if (params?.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = params.shouldDropMismatchedSlackEvent;
  }
  if (params?.resolveRouteReady) {
    harness.ctx.resolveSlackSystemEventRouteReady = params.resolveRouteReady;
  }
  registerSlackChannelEvents({ ctx: harness.ctx, trackEvent: params?.trackEvent });
  return {
    getCreatedHandler: () => harness.getHandler("channel_created") as SlackChannelHandler | null,
  };
}

function requireChannelHandler(handler: SlackChannelHandler | null): SlackChannelHandler {
  if (!handler) {
    throw new Error("expected Slack channel_created handler");
  }
  return handler;
}

describe("registerSlackChannelEvents", () => {
  beforeAll(async () => {
    ({ registerSlackChannelEvents } = await import("./channels.js"));
    ({ createSlackSystemEventTestHarness } = await import("./system-event-test-harness.js"));
  });

  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
  });

  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    const { getCreatedHandler } = createChannelContext({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
    });
    const createdHandler = requireChannelHandler(getCreatedHandler());

    await createdHandler({
      event: {
        channel: { id: "C1", name: "general" },
      },
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("tracks accepted events", async () => {
    const trackEvent = vi.fn();
    const { getCreatedHandler } = createChannelContext({ trackEvent });
    const createdHandler = requireChannelHandler(getCreatedHandler());

    await createdHandler({
      event: {
        channel: { id: "C1", name: "general" },
      },
      body: {},
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Slack channel created: #general.", {
      sessionKey: "agent:service:slack:channel:c1",
      contextKey: "slack:channel:created:C1",
    });
  });

  it("does not enqueue lifecycle events without an admitted service route", async () => {
    const resolveRouteReady = vi.fn(async () => null);
    const { getCreatedHandler } = createChannelContext({ resolveRouteReady });
    const createdHandler = requireChannelHandler(getCreatedHandler());

    await createdHandler({
      event: {
        channel: { id: "C1", name: "general" },
      },
      body: {},
    });

    expect(resolveRouteReady).toHaveBeenCalledWith({
      channelId: "C1",
      channelType: "channel",
    });
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });
});
