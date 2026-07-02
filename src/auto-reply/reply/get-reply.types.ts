// Shared get-reply type contracts for command, directive, and runtime layers.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyOptionsWithHeartbeatRunScope } from "../../infra/heartbeat-run-scope.js";
import type { ConversationIdentityDecision } from "../../routing/conversation-identity.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";

export type ReplySessionBinding = {
  sessionKey?: string;
  sessionId: string;
  storePath?: string;
};

export type InternalReplySessionOptions = {
  requestedSessionId?: string;
  resumeRequestedSession?: boolean;
  sessionPromptSourceReplyDeliveryMode?: GetReplyOptions["sourceReplyDeliveryMode"];
};

export type InternalGetReplyOptions = GetReplyOptions &
  InternalReplySessionOptions &
  ReplyOptionsWithHeartbeatRunScope & {
    /** Dispatch-time admission result; prevents hooks and the resolver from making separate decisions. */
    conversationIdentityDecision?: ConversationIdentityDecision;
  };

/** Reply resolver signature used by dispatchers and tests for dependency injection. */
export type GetReplyFromConfig = (
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: OpenClawConfig,
) => Promise<ReplyPayload | ReplyPayload[] | undefined>;

export type InternalGetReplyFromConfig = (
  ctx: MsgContext,
  opts?: InternalGetReplyOptions,
  configOverride?: OpenClawConfig,
) => Promise<ReplyPayload | ReplyPayload[] | undefined>;
