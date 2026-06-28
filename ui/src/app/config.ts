import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  type ControlUiBootstrapConfig,
  type ControlUiEmbedSandboxMode,
} from "../../../src/gateway/control-ui-contract.js";
import { normalizeAssistantIdentity } from "../lib/assistant-identity.ts";
import { setUiTimeFormatPreference } from "../lib/format.ts";
import { normalizeRouteBasePath } from "../router/index.ts";
import { resolveControlUiAuthCandidates } from "./control-ui-auth.ts";

type ApplicationConfigAuthSource = {
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  settings?: { token?: string | null } | null;
  password?: string | null;
};

export type ApplicationConfig = {
  assistantIdentity: {
    agentId: string | null;
    name: string;
    avatar: string | null;
    avatarSource: string | null;
    avatarStatus: "none" | "local" | "remote" | "data" | null;
    avatarReason: string | null;
  };
  serverVersion: string | null;
  localMediaPreviewRoots: string[];
  embedSandboxMode: ControlUiEmbedSandboxMode;
  allowExternalEmbedUrls: boolean;
  chatMessageMaxWidth: string | null;
};

export type ApplicationConfigCapability = {
  readonly current: ApplicationConfig;
  refresh: (options?: {
    auth?: ApplicationConfigAuthSource;
    skipWithoutAuthCandidate?: boolean;
  }) => Promise<void>;
  subscribe: (listener: (config: ApplicationConfig) => void) => () => void;
};

export const DEFAULT_APPLICATION_CONFIG: ApplicationConfig = {
  assistantIdentity: {
    agentId: null,
    name: "Assistant",
    avatar: null,
    avatarSource: null,
    avatarStatus: null,
    avatarReason: null,
  },
  serverVersion: null,
  localMediaPreviewRoots: [],
  embedSandboxMode: "strict",
  allowExternalEmbedUrls: false,
  chatMessageMaxWidth: null,
};

export function normalizeApplicationConfig(parsed: ControlUiBootstrapConfig): ApplicationConfig {
  const identity = normalizeAssistantIdentity({
    agentId: parsed.assistantAgentId ?? null,
    name: parsed.assistantName,
    avatar: parsed.assistantAvatar ?? null,
    avatarSource: parsed.assistantAvatarSource ?? null,
    avatarStatus: parsed.assistantAvatarStatus ?? null,
    avatarReason: parsed.assistantAvatarReason ?? null,
  });
  return {
    assistantIdentity: {
      agentId: identity.agentId ?? null,
      name: identity.name,
      avatar: identity.avatar,
      avatarSource: identity.avatarSource ?? null,
      avatarStatus: identity.avatarStatus ?? null,
      avatarReason: identity.avatarReason ?? null,
    },
    serverVersion: parsed.serverVersion ?? null,
    localMediaPreviewRoots: Array.isArray(parsed.localMediaPreviewRoots)
      ? parsed.localMediaPreviewRoots.filter((value): value is string => typeof value === "string")
      : [],
    embedSandboxMode:
      parsed.embedSandbox === "trusted"
        ? "trusted"
        : parsed.embedSandbox === "strict"
          ? "strict"
          : "scripts",
    allowExternalEmbedUrls: parsed.allowExternalEmbedUrls === true,
    chatMessageMaxWidth:
      typeof parsed.chatMessageMaxWidth === "string" && parsed.chatMessageMaxWidth.trim()
        ? parsed.chatMessageMaxWidth
        : null,
  };
}

export async function loadApplicationConfig(params: {
  basePath: string;
  auth?: ApplicationConfigAuthSource;
  skipWithoutAuthCandidate?: boolean;
}): Promise<ApplicationConfig | null> {
  if (typeof window === "undefined" || typeof fetch !== "function") {
    return null;
  }

  const basePath = normalizeRouteBasePath(params.basePath);
  const url = basePath
    ? `${basePath}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`
    : CONTROL_UI_BOOTSTRAP_CONFIG_PATH;

  try {
    const resolvedUrl = new URL(url, window.location.origin);
    const sameOrigin = resolvedUrl.origin === window.location.origin;
    const authCandidates = sameOrigin ? resolveControlUiAuthCandidates(params.auth ?? {}) : [];
    if (params.skipWithoutAuthCandidate && sameOrigin && authCandidates.length === 0) {
      return null;
    }
    const attempts = authCandidates.length > 0 ? authCandidates : [""];
    let res: Response | null = null;
    for (const candidate of attempts) {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (candidate) {
        headers.Authorization = `Bearer ${candidate}`;
      }
      res = await fetch(url, { method: "GET", headers, credentials: "same-origin" });
      if (res.ok) {
        break;
      }
      if (res.status !== 401 && res.status !== 403) {
        return null;
      }
    }
    if (!res || !res.ok) {
      return null;
    }
    const parsed = (await res.json()) as ControlUiBootstrapConfig;
    setUiTimeFormatPreference(parsed.timeFormat);
    return normalizeApplicationConfig(parsed);
  } catch {
    return null;
  }
}

export function createApplicationConfigCapability(params: {
  basePath: string;
  auth?: ApplicationConfigAuthSource;
}): ApplicationConfigCapability {
  let current = DEFAULT_APPLICATION_CONFIG;
  let refreshVersion = 0;
  const listeners = new Set<(config: ApplicationConfig) => void>();

  const publish = (next: ApplicationConfig) => {
    current = next;
    for (const listener of listeners) {
      listener(current);
    }
  };

  return {
    get current() {
      return current;
    },
    async refresh(options) {
      const version = ++refreshVersion;
      const next = await loadApplicationConfig({
        basePath: params.basePath,
        auth: options?.auth ?? params.auth,
        skipWithoutAuthCandidate: options?.skipWithoutAuthCandidate,
      });
      if (next && version === refreshVersion) {
        publish(next);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
