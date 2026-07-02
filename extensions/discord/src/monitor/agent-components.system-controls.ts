// Discord plugin module implements agent components.system controls behavior.
import type { APIStringSelectComponent } from "discord-api-types/v10";
import { ButtonStyle } from "discord-api-types/v10";
import { logDebug, logError } from "openclaw/plugin-sdk/logging-core";
import {
  Button,
  StringSelectMenu,
  type ButtonInteraction,
  type ComponentData,
  type StringSelectMenuInteraction,
} from "../internal/discord.js";
import { resolveDiscordCurrentConversationRoute } from "../outbound-session-route.js";
import {
  AGENT_BUTTON_KEY,
  AGENT_SELECT_KEY,
  ackComponentInteraction,
  parseAgentComponentData,
  resolveAuthorizedComponentInteraction,
  resolveDiscordInteractionId,
  type AgentComponentContext,
  type AgentComponentMessageInteraction,
} from "./agent-components-helpers.js";
import {
  canonicalizeMainSessionAlias,
  enqueueSystemEvent,
  requestHeartbeat,
  resolveAgentMainSessionKey,
} from "./agent-components.deps.runtime.js";

type AgentSystemControlParams = {
  ctx: AgentComponentContext;
  interaction: AgentComponentMessageInteraction;
  data: ComponentData;
  label: string;
  authorizationComponentLabel: string;
  invalidReply: string;
  unauthorizedReply: string;
  contextKeyPrefix: string;
  formatEventText: (params: { componentId: string; username: string; userId: string }) => string;
};

function resolveAgentComponentEventSessionKey(params: {
  cfg: AgentComponentContext["cfg"];
  agentId: string;
  sessionKey: string;
}): string {
  const canonical = canonicalizeMainSessionAlias(params);
  // Global storage still needs an agent-qualified ephemeral queue key so the
  // same service owner is used by enqueue, deferred admission, and wake.
  return canonical === "global"
    ? resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId })
    : canonical;
}

async function runAgentSystemControlInteraction(params: AgentSystemControlParams): Promise<void> {
  const parsed = parseAgentComponentData(params.data);
  if (!parsed) {
    logError(`${params.label}: failed to parse component data`);
    try {
      await params.interaction.reply({
        content: params.invalidReply,
        ephemeral: true,
      });
    } catch {
      // Interaction may have expired
    }
    return;
  }

  const { componentId } = parsed;
  const authorized = await resolveAuthorizedComponentInteraction({
    ctx: params.ctx,
    interaction: params.interaction,
    label: params.label,
    componentLabel: params.authorizationComponentLabel,
    unauthorizedReply: params.unauthorizedReply,
    defer: false,
  });
  if (!authorized) {
    return;
  }
  const { interactionCtx, channelCtx, admittedRoute, replyOpts } = authorized;
  const { channelId, username, userId } = interactionCtx;
  const route = admittedRoute.route;

  const eventText = params.formatEventText({ componentId, username, userId });
  logDebug(`${params.label}: enqueuing event for channel ${channelId}: ${eventText}`);

  const interactionId = resolveDiscordInteractionId(params.interaction);
  const contextKey = `${params.contextKeyPrefix}:${channelId}:${componentId}:${userId}:${interactionId}`;
  const eventSessionKey = resolveAgentComponentEventSessionKey({
    cfg: params.ctx.cfg,
    agentId: route.agentId,
    sessionKey: route.sessionKey,
  });
  const queued = enqueueSystemEvent(eventText, {
    sessionKey: eventSessionKey,
    contextKey,
    contextMode: "exact",
    actor: { channel: "discord", accountId: params.ctx.accountId, senderId: userId },
    deliveryContext: {
      channel: "discord",
      to: interactionCtx.isDirectMessage ? `user:${userId}` : `channel:${channelId}`,
      accountId: params.ctx.accountId,
    },
  });
  if (queued) {
    requestHeartbeat({
      source: "channel-interaction",
      intent: "immediate",
      reason: "hook:discord-interaction",
      agentId: route.agentId,
      sessionKey: eventSessionKey,
      heartbeat: { target: "last" },
      conversation: {
        messageChannel: "discord",
        accountId: params.ctx.accountId,
        routeMatchedBy: route.matchedBy,
        chatType: interactionCtx.isDirectMessage
          ? "direct"
          : interactionCtx.isGroupDm
            ? "group"
            : "channel",
        systemEventContextKey: contextKey,
        groupId: interactionCtx.isDirectMessage ? undefined : channelId,
        groupChannel: channelCtx.channelName,
        groupSpace: interactionCtx.rawGuildId,
        senderId: userId,
        resolveCurrentRoute: async (cfg) => {
          const current = await resolveDiscordCurrentConversationRoute({
            cfg,
            agentId: route.agentId,
            accountId: params.ctx.accountId,
            target: interactionCtx.isDirectMessage ? `user:${userId}` : `channel:${channelId}`,
            chatType: interactionCtx.isDirectMessage
              ? "direct"
              : interactionCtx.isGroupDm
                ? "group"
                : "channel",
            conversationId: channelId,
            parentConversationId: channelCtx.parentId,
            groupSpace: interactionCtx.rawGuildId,
            senderId: userId,
          });
          if (!current) {
            return null;
          }
          return {
            ...current,
            sessionKey: resolveAgentComponentEventSessionKey({
              cfg,
              agentId: current.agentId,
              sessionKey: current.sessionKey,
            }),
          };
        },
      },
    });
  }

  await ackComponentInteraction({
    interaction: params.interaction,
    replyOpts,
    label: params.label,
  });
}

export class AgentComponentButton extends Button {
  override label = AGENT_BUTTON_KEY;
  customId = `${AGENT_BUTTON_KEY}:seed=1`;
  override style = ButtonStyle.Primary;
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  override async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    await runAgentSystemControlInteraction({
      ctx: this.ctx,
      interaction,
      data,
      label: "agent button",
      authorizationComponentLabel: "button",
      invalidReply: "This button is no longer valid.",
      unauthorizedReply: "You are not authorized to use this button.",
      contextKeyPrefix: "discord:agent-button",
      formatEventText: ({ componentId, username, userId }) =>
        `[Discord component: ${componentId} clicked by ${username} (${userId})]`,
    });
  }
}

export class AgentSelectMenu extends StringSelectMenu {
  customId = `${AGENT_SELECT_KEY}:seed=1`;
  options: APIStringSelectComponent["options"] = [];
  private ctx: AgentComponentContext;

  constructor(ctx: AgentComponentContext) {
    super();
    this.ctx = ctx;
  }

  override async run(interaction: StringSelectMenuInteraction, data: ComponentData): Promise<void> {
    const values = interaction.values ?? [];
    const valuesText = values.length > 0 ? ` (selected: ${values.join(", ")})` : "";
    await runAgentSystemControlInteraction({
      ctx: this.ctx,
      interaction,
      data,
      label: "agent select",
      authorizationComponentLabel: "select",
      invalidReply: "This select menu is no longer valid.",
      unauthorizedReply: "You are not authorized to use this select menu.",
      contextKeyPrefix: "discord:agent-select",
      formatEventText: ({ componentId, username, userId }) =>
        `[Discord select menu: ${componentId} interacted by ${username} (${userId})${valuesText}]`,
    });
  }
}

export function createAgentComponentButton(ctx: AgentComponentContext): Button {
  return new AgentComponentButton(ctx);
}

export function createAgentSelectMenu(ctx: AgentComponentContext): StringSelectMenu {
  return new AgentSelectMenu(ctx);
}
