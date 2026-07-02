// Discord plugin module implements native command behavior.
import { resolveDirectStatusReplyForSession } from "openclaw/plugin-sdk/command-status-runtime";
import {
  ensureConfiguredBindingRouteReady,
  touchRuntimeConversationBindingRoute,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import * as pluginRuntime from "openclaw/plugin-sdk/plugin-runtime";
import { dispatchReplyWithDispatcher } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { handleDiscordDmCommandDecision } from "./dm-command-decision.js";
import { resolveDiscordNativeInteractionRouteState } from "./native-command-route.js";

export const nativeCommandRuntime = {
  matchPluginCommand: pluginRuntime.matchPluginCommand,
  executePluginCommand: pluginRuntime.executePluginCommand,
  dispatchReplyWithDispatcher,
  resolveDirectStatusReplyForSession,
  resolveDiscordNativeInteractionRouteState,
  ensureConfiguredBindingRouteReady,
  touchRuntimeConversationBindingRoute,
  handleDiscordDmCommandDecision,
  getSessionEntry,
};

export const testing = {
  setMatchPluginCommand(
    next: typeof pluginRuntime.matchPluginCommand,
  ): typeof pluginRuntime.matchPluginCommand {
    const previous = nativeCommandRuntime.matchPluginCommand;
    nativeCommandRuntime.matchPluginCommand = next;
    return previous;
  },
  setExecutePluginCommand(
    next: typeof pluginRuntime.executePluginCommand,
  ): typeof pluginRuntime.executePluginCommand {
    const previous = nativeCommandRuntime.executePluginCommand;
    nativeCommandRuntime.executePluginCommand = next;
    return previous;
  },
  setDispatchReplyWithDispatcher(
    next: typeof dispatchReplyWithDispatcher,
  ): typeof dispatchReplyWithDispatcher {
    const previous = nativeCommandRuntime.dispatchReplyWithDispatcher;
    nativeCommandRuntime.dispatchReplyWithDispatcher = next;
    return previous;
  },
  setResolveDirectStatusReplyForSession(
    next: typeof resolveDirectStatusReplyForSession,
  ): typeof resolveDirectStatusReplyForSession {
    const previous = nativeCommandRuntime.resolveDirectStatusReplyForSession;
    nativeCommandRuntime.resolveDirectStatusReplyForSession = next;
    return previous;
  },
  setResolveDiscordNativeInteractionRouteState(
    next: typeof resolveDiscordNativeInteractionRouteState,
  ): typeof resolveDiscordNativeInteractionRouteState {
    const previous = nativeCommandRuntime.resolveDiscordNativeInteractionRouteState;
    nativeCommandRuntime.resolveDiscordNativeInteractionRouteState = next;
    return previous;
  },
  setEnsureConfiguredBindingRouteReady(
    next: typeof ensureConfiguredBindingRouteReady,
  ): typeof ensureConfiguredBindingRouteReady {
    const previous = nativeCommandRuntime.ensureConfiguredBindingRouteReady;
    nativeCommandRuntime.ensureConfiguredBindingRouteReady = next;
    return previous;
  },
  setTouchRuntimeConversationBindingRoute(
    next: typeof touchRuntimeConversationBindingRoute,
  ): typeof touchRuntimeConversationBindingRoute {
    const previous = nativeCommandRuntime.touchRuntimeConversationBindingRoute;
    nativeCommandRuntime.touchRuntimeConversationBindingRoute = next;
    return previous;
  },
  setHandleDiscordDmCommandDecision(
    next: typeof handleDiscordDmCommandDecision,
  ): typeof handleDiscordDmCommandDecision {
    const previous = nativeCommandRuntime.handleDiscordDmCommandDecision;
    nativeCommandRuntime.handleDiscordDmCommandDecision = next;
    return previous;
  },
  setGetSessionEntry(next: typeof getSessionEntry): typeof getSessionEntry {
    const previous = nativeCommandRuntime.getSessionEntry;
    nativeCommandRuntime.getSessionEntry = next;
    return previous;
  },
};
export { testing as __testing };
