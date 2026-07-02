// Raft delivers wake hints only; message content stays in the operator's Raft CLI session.
import { randomUUID } from "node:crypto";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveConversationIdentityAdmission } from "openclaw/plugin-sdk/routing";
import type { ResolvedRaftAccount } from "./accounts.js";
import { RAFT_CHANNEL_ID } from "./accounts.js";

const WAKE_TEXT =
  "Raft wake hint received. Check Raft for pending messages, then reply through the Raft CLI.";

type RaftChannelRuntime = Pick<
  PluginRuntime["channel"],
  "inbound" | "reply" | "routing" | "session"
>;
export type RaftServiceRoute = ReturnType<RaftChannelRuntime["routing"]["resolveAgentRoute"]>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function resolveRaftServiceRoute(
  ctx: ChannelGatewayContext<ResolvedRaftAccount>,
): RaftServiceRoute {
  const channelRuntime = ctx.channelRuntime as RaftChannelRuntime | undefined;
  const profile = ctx.account.profile;
  if (!channelRuntime || !profile) {
    throw new Error("Raft requires channel runtime support and a configured CLI profile.");
  }
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: RAFT_CHANNEL_ID,
    accountId: ctx.accountId,
    peer: {
      kind: "direct",
      id: profile,
    },
  });
  const identityDecision = resolveConversationIdentityAdmission({
    cfg: ctx.cfg,
    ctx: {
      AgentId: route.agentId,
      SessionKey: route.sessionKey,
      AgentRouteMatchedBy: route.matchedBy,
      ChatType: "direct",
      SenderId: profile,
      Provider: RAFT_CHANNEL_ID,
      Surface: RAFT_CHANNEL_ID,
    },
  });
  if (!identityDecision.allowed || identityDecision.mode !== "organization") {
    throw new Error(
      "Raft requires an explicit binding to a non-default service agent. Configure a distinct agent and bind the Raft account before starting the Gateway.",
    );
  }
  return route;
}

export async function dispatchRaftWake(params: {
  ctx: ChannelGatewayContext<ResolvedRaftAccount>;
  route: RaftServiceRoute;
}): Promise<void> {
  const { ctx } = params;
  // Gateway supplies the full runtime; the public context type intentionally
  // exposes only runtime contexts so external plugins cannot assume more.
  const channelRuntime = ctx.channelRuntime as RaftChannelRuntime | undefined;
  const profile = ctx.account.profile;
  if (!channelRuntime || !profile) {
    return;
  }
  const route = params.route;
  const timestamp = Date.now();
  const command = `raft --profile ${shellQuote(profile)}`;

  await channelRuntime.inbound.run({
    channel: RAFT_CHANNEL_ID,
    accountId: ctx.accountId,
    raw: {
      kind: "wake",
      profile,
    },
    adapter: {
      ingest: () => ({
        id: randomUUID(),
        timestamp,
        rawText: WAKE_TEXT,
        textForAgent: `${WAKE_TEXT}\n\nUse \`${command} message check\` to read pending messages and \`${command} message send\` to respond.`,
        textForCommands: "",
      }),
      resolveTurn: async (input) => {
        const ctxPayload = channelRuntime.inbound.buildContext({
          channel: RAFT_CHANNEL_ID,
          accountId: ctx.accountId,
          messageId: input.id,
          timestamp: input.timestamp,
          from: `raft:${profile}`,
          sender: {
            id: profile,
            name: "Raft",
          },
          conversation: {
            kind: "direct",
            id: profile,
            label: `Raft ${profile}`,
          },
          route: {
            agentId: route.agentId,
            accountId: ctx.accountId,
            matchedBy: route.matchedBy,
            routeSessionKey: route.sessionKey,
            dispatchSessionKey: route.sessionKey,
          },
          reply: {
            to: `raft:${profile}`,
          },
          message: {
            rawBody: input.rawText,
            commandBody: input.textForCommands,
            bodyForAgent: input.textForAgent,
          },
        });
        const storePath = channelRuntime.session.resolveStorePath(ctx.cfg.session?.store, {
          agentId: route.agentId,
        });
        return {
          cfg: ctx.cfg,
          channel: RAFT_CHANNEL_ID,
          accountId: ctx.accountId,
          agentId: route.agentId,
          routeSessionKey: route.sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: channelRuntime.session.recordInboundSession,
          dispatchReplyWithBufferedBlockDispatcher:
            channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
          replyOptions: { identityContractVersion: 1 },
          // Raft's bridge only transports wake hints. The agent owns CLI delivery
          // after it reads the pending Raft messages, so OpenClaw must not emit a
          // duplicate synthetic reply through the channel dispatcher.
          delivery: {
            deliver: async () => ({ visibleReplySent: false }),
          },
          record: {
            onRecordError: (error) =>
              ctx.log?.warn?.(`Raft session metadata update failed: ${String(error)}`),
          },
        };
      },
    },
  });
}
