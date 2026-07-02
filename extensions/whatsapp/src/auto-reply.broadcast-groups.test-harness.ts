// Whatsapp plugin module implements auto reply.broadcast groups harness behavior.
import { vi } from "vitest";
import {
  createWebInboundDeliverySpies,
  createWebListenerFactoryCapture,
  sendWebDirectInboundMessage,
} from "./auto-reply.test-harness.js";
import { monitorWebChannel } from "./auto-reply/monitor.js";
import type { WebInboundMessageInput } from "./inbound.js";

export async function monitorWebChannelWithCapture(resolver: unknown): Promise<{
  spies: ReturnType<typeof createWebInboundDeliverySpies>;
  onMessage: (msg: WebInboundMessageInput) => Promise<void>;
}> {
  const spies = createWebInboundDeliverySpies();
  const { listenerFactory, getOnMessage } = createWebListenerFactoryCapture();

  await monitorWebChannel(false, listenerFactory, false, resolver as never);
  const onMessage = getOnMessage();
  if (!onMessage) {
    throw new Error("Missing onMessage handler");
  }

  return { spies, onMessage };
}

export async function sendWebDirectInboundAndCollectSessionKeys(): Promise<{
  seen: string[];
  routeMatches: string[];
  resolver: ReturnType<typeof vi.fn>;
}> {
  const seen: string[] = [];
  const routeMatches: string[] = [];
  const resolver = vi.fn(async (ctx: { SessionKey?: unknown; AgentRouteMatchedBy?: unknown }) => {
    seen.push(String(ctx.SessionKey));
    routeMatches.push(String(ctx.AgentRouteMatchedBy));
    return { text: "ok" };
  });

  const { spies, onMessage } = await monitorWebChannelWithCapture(resolver);
  await sendWebDirectInboundMessage({
    onMessage,
    spies,
    id: "m1",
    from: "+1000",
    to: "+2000",
    body: "hello",
  });

  return { seen, routeMatches, resolver };
}
