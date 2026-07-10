Warning: truncated output (original token count: 43498)
Total output lines: 4900

// Live model profile gateway tests sweep configured providers, auth profiles, model listing, and smoke prompts.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clampThinkingLevel,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import { renderCatNoncePngBase64 } from "../../test/helpers/live-image-probe.js";
import { discoverAuthStorage, discoverModels } from "../agents/agent-model-discovery.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentDir } from "../agents/agent-scope.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { collectAnthropicApiKeys } from "../agents/live-auth-keys.js";
import { appendPrioritizedDynamicLiveModels } from "../agents/live-model-dynamic-candidates.js";
import { isModelNotFoundErrorMessage } from "../agents/live-model-errors.js";
import {
  DEFAULT_HIGH_SIGNAL_LIVE_MODEL_LIMIT,
  DEFAULT_SMALL_LIVE_MODEL_LIMIT,
  getHighSignalLiveModelPriorityIndex,
  getHighSignalLiveModelProviders,
  isHighSignalLiveModelRef,
  isSmallLiveModelRef,
  listPrioritizedSmallLiveModelRefs,
  resolveHighSignalLiveModelLimit,
  selectHighSignalLiveItems,
  selectSmallLiveItems,
  shouldExcludeProviderFromDefaultHighSignalLiveSweep,
} from "../agents/live-model-filter.js";
import { createLiveTargetMatcher } from "../agents/live-target-matcher.js";
import { isLiveProfileKeyModeEnabled, isLiveTestEnabled } from "../agents/live-test-helpers.js";
import {
  isLiveBillingDrift,
  isLiveRateLimitDrift,
  shouldSkipLiveProviderDrift,
} from "../agents/live-test-provider-drift.js";
import { getApiKeyForModel, resolveEnvApiKey } from "../agents/model-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { shouldSuppressBuiltInModel } from "../agents/model-suppression.js";
import { ensureOpenClawModelsJson } from "../agents/models-config.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "../agents/stream-message-shared.js";
import { clearRuntimeConfigSnapshot, getRuntimeConfig } from "../config/io.js";
import type { ModelsConfig, ModelProviderConfig, OpenClawConfig } from "../config/types.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { ModelRegistry } from "../llm/model-registry.js";
import { normalizeGoogleModelId } from "../plugin-sdk/google-model-id.js";
import { resolveProviderThinkingProfile } from "../plugins/provider-runtime.js";
import type { ProviderThinkingModelCompat } from "../plugins/provider-thinking.types.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { stripAssistantInternalScaffolding } from "../shared/text/assistant-visible-text.js";
import { findFinalTagMatches, stripFinalTags } from "../shared/text/final-tags.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { getFreePort, isPortFree } from "../test-utils/ports.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import {
  hasExpectedSingleNonce,
  hasExpectedToolNonce,
  isLikelyToolNonceRefusal,
  shouldRetryExecReadProbe,
  shouldRetryToolReadProbe,
} from "./live-tool-probe.test-helpers.js";
import { startGatewayServer } from "./server.impl.js";
import { readSessionMessagesAsync } from "./session-transcript-readers.js";
import { loadSessionEntry } from "./session-utils.js";

const ZAI_FALLBACK = isTruthyEnvValue(process.env.OPENCLAW_LIVE_GATEWAY_ZAI_FALLBACK);
const REQUIRE_PROFILE_KEYS = isLiveProfileKeyModeEnabled();
const LIVE_CREDENTIAL_PRECEDENCE = REQUIRE_PROFILE_KEYS ? "profile-first" : "env-first";
const PROVIDERS = parseFilter(process.env.OPENCLAW_LIVE_GATEWAY_PROVIDERS);
const GATEWAY_LIVE_SMOKE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_GATEWAY_SMOKE);
const THINKING_LEVEL = resolveGatewayLiveThinkingLevel({
  raw: process.env.OPENCLAW_LIVE_GATEWAY_THINKING,
  smoke: GATEWAY_LIVE_SMOKE,
});
const ENABLE_EXTRA_TOOL_PROBES = !GATEWAY_LIVE_SMOKE;
const ENABLE_EXTRA_IMAGE_PROBES = !GATEWAY_LIVE_SMOKE;
const THINKING_TAG_RE = /<\s*\/?\s*(?:(?:antml:)?(?:think(?:ing)?|thought)|antthinking)\s*>/i;
const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const GATEWAY_LIVE_DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const GATEWAY_LIVE_UNBOUNDED_TIMEOUT_MS = 60 * 60 * 1000;
const EXPLICIT_LIVE_FALLBACK_CONTEXT_WINDOW = 128_000;
const GATEWAY_LIVE_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const GATEWAY_LIVE_PROBE_TIMEOUT_MS = Math.max(
  30_000,
  toInt(process.env.OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS, 90_000),
);
const GATEWAY_LIVE_SETUP_TIMEOUT_MS = resolveGatewayLiveSetupTimeoutMs();
const GATEWAY_LIVE_MODEL_TIMEOUT_MS = resolveGatewayLiveModelTimeoutMs();
const GATEWAY_LIVE_SESSION_CONTROL_TIMEOUT_MS = resolveGatewayLiveSessionControlTimeoutMs();
const GATEWAY_LIVE_TRANSCRIPT_TIMEOUT_MS = resolveGatewayLiveTranscriptTimeoutMs();
const GATEWAY_LIVE_AGENT_RUN_TIMEOUT_MS = resolveGatewayLiveAgentRunTimeoutMs();
const GATEWAY_LIVE_AGENT_WAIT_TIMEOUT_MS = resolveGatewayLiveAgentWaitTimeoutMs();
const GATEWAY_LIVE_HEARTBEAT_MS = Math.max(
  1_000,
  toInt(process.env.OPENCLAW_LIVE_GATEWAY_HEARTBEAT_MS, 30_000),
);
const GATEWAY_LIVE_STRIP_SCAFFOLDING_MODEL_KEYS = new Set([
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.1-pro-preview-customtools",
  "openai/gpt-5.4-pro",
]);
const GATEWAY_LIVE_AGENT_ID = "dev";
const GATEWAY_LIVE_CONFIG_TEST_WORKSPACE = path.join(os.tmpdir(), "openclaw-live-config-test");
const GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR = path.join(
  os.tmpdir(),
  "openclaw-live-config-test-agent",
);
const GATEWAY_LIVE_EXEC_READ_NONCE_MISS_SKIP_MODEL_KEYS = new Set([
  "fireworks/accounts/fireworks/models/glm-5",
  "fireworks/accounts/fireworks/models/kimi-k2p5",
  "fireworks/accounts/fireworks/models/kimi-k2p6",
  "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
  "google/gemini-3.1-flash-lite",
]);
const GATEWAY_LIVE_TOOL_NONCE_MISS_SKIP_MODEL_KEYS = new Set([
  // Hosted DeepSeek V4 Flash can surface its internal tool-call sentinel
  // instead of the readback nonce after the tool-read probe succeeds.
  "deepinfra/deepseek-ai/DeepSeek-V4-Flash",
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-pro-preview",
]);
const GATEWAY_LIVE_MAX_MODELS = resolveGatewayLiveMaxModels();
const GATEWAY_LIVE_SUITE_TIMEOUT_MS = resolveGatewayLiveSuiteTimeoutMs(GATEWAY_LIVE_MAX_MODELS);
const QUIET_LIVE_LOGS = process.env.OPENCLAW_LIVE_TEST_QUIET !== "0";

const describeLive = isLiveTestEnabled(["OPENCLAW_LIVE_GATEWAY"]) ? describe : describe.skip;

function parseFilter(raw?: string): Set<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "all") {
    return null;
  }
  const ids: string[] = [];
  for (const rawId of trimmed.split(",")) {
    const id = rawId.trim();
    if (id.length > 0) {
      ids.push(id);
    }
  }
  return ids.length ? new Set(ids) : null;
}

function providerFilterList(): string[] | undefined {
  return PROVIDERS
    ? [...PROVIDERS].toSorted((left, right) => left.localeCompare(right))
    : undefined;
}

function providerListFromExplicitModelFilter(params: {
  modelFilter: Set<string> | null;
  providerFilter: Set<string> | null;
}): string[] | undefined {
  if (!params.modelFilter || params.modelFilter.size === 0) {
    return undefined;
  }
  const providers = new Set<string>();
  for (const raw of params.modelFilter) {
    const ref = parseExplicitLiveModelRef(raw, params.providerFilter);
    if (!ref) {
      return undefined;
    }
    providers.add(ref.provider);
  }
  return providers.size > 0
    ? [...providers].toSorted((left, right) => left.localeCompare(right))
    : undefined;
}

function providerScopedModelRegistryProviders(params: {
  providerList: string[] | undefined;
  useSmall: boolean;
  useExplicit: boolean;
  modelFilter: Set<string> | null;
  providerFilter: Set<string> | null;
}): string[] | undefined {
  if (params.providerList) {
    return params.providerList;
  }
  if (!params.useExplicit) {
    const providers = params.useSmall
      ? [
          ...new Set(
            listPrioritizedSmallLiveModelRefs().map((ref) => normalizeProviderId(ref.provider)),
          ),
        ].toSorted((left, right) => left.localeCompare(right))
      : getHighSignalLiveModelProviders();
    return providers.filter((provider) =>
      params.providerFilter ? params.providerFilter.has(provider) : true,
    );
  }
  return providerListFromExplicitModelFilter({
    modelFilter: params.modelFilter,
    providerFilter: params.providerFilter,
  });
}

function filterGatewayLiveModelRefsByProvider(
  refs: readonly { provider: string; id: string }[],
  providerFilter: ReadonlySet<string> | null,
): Array<{ provider: string; id: string }> {
  if (!providerFilter) {
    return [...refs];
  }
  const providers = new Set(
    [...providerFilter].map((provider) => normalizeProviderId(provider)).filter(Boolean),
  );
  return refs.filter((ref) => providers.has(normalizeProviderId(ref.provider)));
}

function isWantedSmallGatewayLiveModel(params: {
  model: Pick<Model, "provider" | "id">;
  targetMatcher: ReturnType<typeof createLiveTargetMatcher>;
}): boolean {
  return (
    params.targetMatcher.matchesProvider(params.model.provider) &&
    isSmallLiveModelRef({ provider: params.model.provider, id: params.model.id })
  );
}

function shouldSuppressGatewayLiveOllamaWarnings(): boolean {
  return PROVIDERS !== null && !PROVIDERS.has("ollama");
}

async function withSuppressedGatewayLiveWarnings<T>(run: () => Promise<T>): Promise<T> {
  if (!shouldSuppressGatewayLiveOllamaWarnings()) {
    return await run();
  }
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (args.some((arg) => typeof arg === "string" && isOllamaUnavailableErrorMessage(arg))) {
      return;
    }
    originalWarn(...args);
  };
  try {
    return await run();
  } finally {
    console.warn = originalWarn;
  }
}

function toInt(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveGatewayLiveSetupTimeoutMs(
  raw = process.env.OPENCLAW_LIVE_GATEWAY_SETUP_TIMEOUT_MS,
): number {
  return Math.max(1_000, toInt(raw, 180_000));
}

function resolveGatewayLiveMaxModels(): number {
  const gatewayRaw = process.env.OPENCLAW_LIVE_GATEWAY_MAX_MODELS?.trim();
  if (gatewayRaw) {
    return Math.max(0, toInt(gatewayRaw, 0));
  }
  const rawModels = process.env.OPENCLAW_LIVE_GATEWAY_MODELS?.trim();
  const useSmallModels = rawModels === "small";
  const useExplicitModels =
    Boolean(rawModels) && rawModels !== "modern" && rawModels !== "all" && !useSmallModels;
  return resolveHighSignalLiveModelLimit({
    rawMaxModels: process.env.OPENCLAW_LIVE_MAX_MODELS,
    useExplicitModels,
    defaultLimit: useSmallModels
      ? DEFAULT_SMALL_LIVE_MODEL_LIMIT
      : DEFAULT_HIGH_SIGNAL_LIVE_MODEL_LIMIT,
  });
}

function resolveGatewayLiveSuiteTimeoutMs(maxModels: number): number {
  if (maxModels <= 0) {
    return GATEWAY_LIVE_UNBOUNDED_TIMEOUT_MS;
  }
  // Gateway live runs multiple probes per model and may retry with another
  // profile key before moving on, so the suite budget has to scale with the
  // model timeout rather than only the first prompt.
  const perModelBudgetMs = Math.max(3 * 60 * 1000, GATEWAY_LIVE_MODEL_TIMEOUT_MS * 3);
  const estimated = 10 * 60 * 1000 + maxModels * perModelBudgetMs;
  return Math.max(
    GATEWAY_LIVE_DEFAULT_TIMEOUT_MS,
    Math.min(GATEWAY_LIVE_MAX_TIMEOUT_MS, estimated),
  );
}

function resolveGatewayLiveModelTimeoutMs(
  gatewayModelTimeoutRaw = process.env.OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS,
  liveModelTimeoutRaw = process.env.OPENCLAW_LIVE_MODEL_TIMEOUT_MS,
  stepTimeoutMs = GATEWAY_LIVE_PROBE_TIMEOUT_MS,
): number {
  const requested = toInt(gatewayModelTimeoutRaw, toInt(liveModelTimeoutRaw, 300_000));
  return Math.max(stepTimeoutMs, requested);
}

function resolveGatewayLiveSessionControlTimeoutMs(
  stepTimeoutMs = GATEWAY_LIVE_PROBE_TIMEOUT_MS,
  modelTimeoutMs = GATEWAY_LIVE_MODEL_TIMEOUT_MS,
): number {
  return Math.max(stepTimeoutMs, Math.min(modelTimeoutMs, 180_000));
}

function resolveGatewayLiveTranscriptTimeoutMs(
  stepTimeoutMs = GATEWAY_LIVE_PROBE_TIMEOUT_MS,
  modelTimeoutMs = GATEWAY_LIVE_MODEL_TIMEOUT_MS,
): number {
  return Math.max(stepTimeoutMs, modelTimeoutMs);
}

function resolveGatewayLiveAgentRunTimeoutMs(
  modelTimeoutMs = GATEWAY_LIVE_MODEL_TIMEOUT_MS,
): number {
  if (!Number.isFinite(modelTimeoutMs) || modelTimeoutMs <= 1_000) {
    return Math.max(1_000, Math.floor(modelTimeoutMs));
  }
  const terminalGraceMs = Math.min(30_000, Math.max(5_000, Math.floor(modelTimeoutMs / 6)));
  return Math.max(1_000, Math.floor(modelTimeoutMs - terminalGraceMs));
}

function resolveGatewayLiveAgentWaitTimeoutMs(
  agentRunTimeoutMs = GATEWAY_LIVE_AGENT_RUN_TIMEOUT_MS,
  modelTimeoutMs = GATEWAY_LIVE_MODEL_TIMEOUT_MS,
): number {
  const waitGraceMs = Math.min(10_000, Math.max(1_000, Math.floor(modelTimeoutMs / 12)));
  return Math.max(1_000, Math.min(modelTimeoutMs, Math.floor(agentRunTimeoutMs + waitGraceMs)));
}

function resolveGatewayLiveProviderTimeoutSeconds(
  modelTimeoutMs = GATEWAY_LIVE_MODEL_TIMEOUT_MS,
): number {
  return Math.max(1, Math.ceil(modelTimeoutMs / 1_000));
}

function isGatewayLiveProbeTimeout(error: string): boolean {
  return /probe timeout after \d+ms/i.test(error);
}

function isGatewayLiveModelTimeout(error: string): boolean {
  return (
    /model timeout after \d+ms/i.test(error) ||
    (/\bagent\.wait timeout for runId=/i.test(error) &&
      /\btimeoutPhase=(?:preflight|provider|post_turn)\b/i.test(error))
  );
}

function assertGatewayLiveDidNotSkipAllDueToTimeout(params: {
  label: string;
  skippedCount: number;
  timeoutSkippedCount: number;
  total: number;
}): void {
  if (
    params.total === 0 ||
    params.skippedCount !== params.total ||
    params.timeoutSkippedCount === 0
  ) {
    return;
  }
  throw new Error(
    `[${params.label}] skipped all ${params.total} live model(s) after ${params.timeoutSkippedCount} timeout skip(s); increase the live gateway timeout or fix the timeout source instead of treating this as missing profile coverage.`,
  );
}

function assertGatewayLiveCompletedSomeModels(params: {
  label: string;
  passedCount: number;
  skippedCount: number;
  timeoutSkippedCount: number;
  total: number;
}): void {
  if (params.total === 0 || params.passedCount > 0) {
    return;
  }
  assertGatewayLiveDidNotSkipAllDueToTimeout({
    label: params.label,
    skippedCount: params.skippedCount,
    timeoutSkippedCount: params.timeoutSkippedCount,
    total: params.total,
  });
  throw new Error(
    `[${params.label}] completed zero successful live model run(s) across ${params.total} selected model(s); skipped=${params.skippedCount}. Live proof must exercise at least one model.`,
  );
}

function formatGatewayLiveFilterSet(filter: ReadonlySet<string> | null): string {
  if (!filter || filter.size === 0) {
    return "all";
  }
  return [...filter].toSorted((left, right) => left.localeCompare(right)).join(",");
}

function assertGatewayLiveSelectedSomeModels(params: {
  allowProviderDriftSkip: boolean;
  label: string;
  modelFilter: ReadonlySet<string> | null;
  providerFilter: ReadonlySet<string> | null;
  total: number;
  useSmall: boolean;
  useExplicit: boolean;
  wantedCount: number;
}): void {
  if (params.wantedCount > 0 || (!params.modelFilter && !params.providerFilter)) {
    return;
  }
  if (
    params.allowProviderDriftSkip &&
    params.providerFilter &&
    [...params.providerFilter].every((provider) =>
      shouldSkipEmptyResponseForLiveModel({ provider, allowNotFoundSkip: true }),
    )
  ) {
    return;
  }
  const mode = params.useExplicit ? "explicit" : params.useSmall ? "small" : "high-signal";
  throw new Error(
    `[${params.label}] selected no ${mode} live models for providers=${formatGatewayLiveFilterSet(params.providerFilter)} models=${formatGatewayLiveFilterSet(params.modelFilter)} from ${params.total} registry model(s); update the live model selection or pass explicit live model refs.`,
  );
}

function assertGatewayLiveHasRunnableCandidates(params: {
  candidatesCount: number;
  label: string;
  skipped: Array<{ model: string; error: string }>;
}): void {
  if (params.candidatesCount > 0) {
    return;
  }
  const preview = params.skipped.length > 0 ? `:\n${formatFailurePreview(params.skipped, 8)}` : ".";
  throw new Error(
    `[${params.label}] selected no runnable live model candidates with usable credentials; skipped ${params.skipped.length} candidate(s)${preview}`,
  );
}

function failGatewayLiveStartupCoverage(params: { label: string; reason: string }): never {
  throw new Error(
    `[${params.label}] gateway startup failed before live model coverage: ${params.reason}`,
  );
}

async function withGatewayLiveTimeout<T>(params: {
  operation: Promise<T>;
  timeoutMs: number;
  timeoutLabel: "setup" | "probe" | "model";
  context: string;
}): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  let heartbeatCount = 0;
  const heartbeat = setInterval(() => {
    heartbeatCount += 1;
    logProgress(
      `${params.context}: still running (${Math.max(1, Math.round((Date.now() - startedAt) / 1_000))}s)`,
    );
  }, GATEWAY_LIVE_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return await Promise.race([
      params.operation,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new Error(
              `${params.timeoutLabel} timeout after ${params.timeoutMs}ms (${params.context})`,
            ),
          );
        }, params.timeoutMs);
      }),
    ]);
  } finally {
    clearInterval(heartbeat);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (heartbeatCount > 0) {
      logProgress(
        `${params.context}: completed after ${Math.max(1, Math.round((Date.now() - startedAt) / 1_000))}s`,
      );
    }
  }
}

async function withGatewayLiveSetupTimeout<T>(
  operation: Promise<T>,
  context: string,
  timeoutMs = GATEWAY_LIVE_SETUP_TIMEOUT_MS,
): Promise<T> {
  return await withGatewayLiveTimeout({
    operation,
    timeoutMs,
    timeoutLabel: "setup",
    context,
  });
}

async function withGatewayLiveProbeTimeout<T>(operation: Promise<T>, context: string): Promise<T> {
  return await withGatewayLiveTimeout({
    operation,
    timeoutMs: GATEWAY_LIVE_PROBE_TIMEOUT_MS,
    timeoutLabel: "probe",
    context,
  });
}

async function withGatewayLiveSessionControlTimeout<T>(
  operation: Promise<T>,
  context: string,
): Promise<T> {
  return await withGatewayLiveTimeout({
    operation,
    timeoutMs: GATEWAY_LIVE_SESSION_CONTROL_TIMEOUT_MS,
    timeoutLabel: "probe",
    context,
  });
}

async function withGatewayLiveModelTimeout<T>(operation: Promise<T>, context: string): Promise<T> {
  return await withGatewayLiveTimeout({
    operation,
    timeoutMs: GATEWAY_LIVE_MODEL_TIMEOUT_MS,
    timeoutLabel: "model",
    context,
  });
}

function logProgress(message: string): void {
  writeSync(2, `[live] ${message}\n`);
}

function enterProductionEnvForLiveRun() {
  const previous = {
    vitest: process.env.VITEST,
    nodeEnv: process.env.NODE_ENV,
    testFast: process.env.OPENCLAW_TEST_FAST,
  };
  delete process.env.VITEST;
  delete process.env.OPENCLAW_TEST_FAST;
  process.env.NODE_ENV = "production";
  return previous;
}

function restoreProductionEnvForLiveRun(previous: {
  vitest: string | undefined;
  nodeEnv: string | undefined;
  testFast: string | undefined;
}) {
  if (previous.vitest === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = previous.vitest;
  }
  if (previous.testFast === undefined) {
    delete process.env.OPENCLAW_TEST_FAST;
  } else {
    process.env.OPENCLAW_TEST_FAST = previous.testFast;
  }
  if (previous.nodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = previous.nodeEnv;
  }
}

function restoreOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    deleteTestEnvValue(key);
  } else {
    setTestEnvValue(key, value);
  }
}

function formatFailurePreview(
  failures: Array<{ model: string; error: string }>,
  maxItems: number,
): string {
  const limit = Math.max(1, maxItems);
  const lines = failures.slice(0, limit).map((failure, index) => {
    const normalized = failure.error.replace(/\s+/g, " ").trim();
    const clipped = normalized.length > 320 ? `${normalized.slice(0, 317)}...` : normalized;
    return `${index + 1}. ${failure.model}: ${clipped}`;
  });
  const remaining = failures.length - limit;
  if (remaining > 0) {
    lines.push(`... and ${remaining} more`);
  }
  return lines.join("\n");
}

function assertNoReasoningTags(params: {
  text: string;
  model: string;
  phase: string;
  label: string;
}): void {
  if (!params.text) {
    return;
  }
  if (THINKING_TAG_RE.test(params.text) || findFinalTagMatches(params.text).length > 0) {
    const snippet = params.text.length > 200 ? `${params.text.slice(0, 200)}…` : params.text;
    throw new Error(
      `[${params.label}] reasoning tag leak (${params.model} / ${params.phase}): ${snippet}`,
    );
  }
}

function isMeaningful(text: string): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === "ok") {
    return false;
  }
  if (trimmed.length < 60) {
    return false;
  }
  const words = trimmed.split(/\s+/g);
  if (words.length < 12) {
    return false;
  }
  return true;
}

function hasEventLoopPromptKeywords(text: string): boolean {
  return /\bmicro\s*-?\s*tasks?\b/i.test(text) && /\bmacro\s*-?\s*tasks?\b/i.test(text);
}

function shouldStripAssistantScaffoldingForLiveModel(modelKey?: string): boolean {
  if (!modelKey) {
    return false;
  }
  if (GATEWAY_LIVE_STRIP_SCAFFOLDING_MODEL_KEYS.has(modelKey)) {
    return true;
  }
  const [provider, ...rest] = modelKey.split("/");
  const modelId = rest.join("/");
  if (provider === "anthropic") {
    return true;
  }
  if (provider === "minimax" || provider === "minimax-portal") {
    // MiniMax transcript persistence can mirror our <final> wrapper style even
    // though user-visible surfaces already strip it. Keep the live reader
    // aligned with the runtime-facing sanitizers for the whole provider family.
    return true;
  }
  if (provider !== "google" || rest.length === 0) {
    return false;
  }
  const normalizedKey = `${provider}/${normalizeGoogleModelId(modelId)}`;
  return GATEWAY_LIVE_STRIP_SCAFFOLDING_MODEL_KEYS.has(normalizedKey);
}

function maybeStripAssistantScaffoldingForLiveModel(text: string, modelKey?: string): string {
  if (!shouldStripAssistantScaffoldingForLiveModel(modelKey)) {
    return text;
  }
  return stripAssistantInternalScaffolding(stripKnownLiveReasoningWrappers(text)).trim();
}

function stripKnownLiveReasoningWrappers(text: string): string {
  const withoutThinking = text
    .replace(/<\s*think\b[^<>]*>[\s\S]*?<\s*\/\s*think\s*>/gi, "")
    .replace(/^[\s\S]*?<\s*\/\s*think\s*>\s*/i, "");
  return stripFinalTags(withoutThinking);
}

function shouldSkipExecReadNonceMissForLiveModel(modelKey?: string): boolean {
  if (!modelKey) {
    return false;
  }
  if (GATEWAY_LIVE_EXEC_READ_NONCE_MISS_SKIP_MODEL_KEYS.has(modelKey)) {
    return true;
  }
  const [provider, ...rest] = modelKey.split("/");
  if (provider !== "google" || rest.length === 0) {
    return false;
  }
  const normalizedKey = `${provider}/${normalizeGoogleModelId(rest.join("/"))}`;
  return GATEWAY_LIVE_EXEC_READ_NONCE_MISS_SKIP_MODEL_KEYS.has(normalizedKey);
}

function shouldSkipEmptyResponseForLiveModel(params: {
  provider: string;
  allowNotFoundSkip: boolean;
}): boolean {
  if (isGoogleishProvider(params.provider)) {
    return true;
  }
  if (params.provider === "openrouter" || params.provider === "opencode") {
    return true;
  }
  if (params.provider === "opencode-go") {
    return true;
  }
  if (!params.allowNotFoundSkip) {
    return false;
  }
  return (
    params.provider === "google-antigravity" ||
    params.provider === "minimax" ||
    params.provider === "minimax-portal" ||
    params.provider === "openai" ||
    params.provider === "zai"
  );
}

describe("maybeStripAssistantScaffoldingForLiveModel", () => {
  it("strips scaffolding for Gemini preview models with known transcript wrappers", () => {
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        "<final>Visible</final>",
        "google/gemini-3-flash-preview",
      ),
    ).toBe("Visible");
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        "<final data-model=openrouter/google/gemini/>Visible",
        "google/gemini-3-flash-preview",
      ),
    ).toBe("Visible");
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        "<think>hidden</think>Visible",
        "google/gemini-3.1-flash-preview",
      ),
    ).toBe("Visible");
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        "<think>hidden</think>Visible",
        "google/gemini-3.1-flash-lite",
      ),
    ).toBe("Visible");
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        "<think>hidden</think>Visible",
        "google/gemini-3.1-pro-preview",
      ),
    ).toBe("Visible");
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        "<think>hidden</think>Visible",
        "google/gemini-3.1-pro-preview-customtools",
      ),
    ).toBe("Visible");
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        [
          "<think>",
          "1. Inspect",
          "```",
          "draft",
          "```",
          "2. Draft the explanation",
          "</think>The event loop drains the microtask queue before the next macrotask.",
        ].join("\n"),
        "google/gemini-3-flash-preview",
      ),
    ).toBe("The event loop drains the microtask queue before the next macrotask.");
  });

  it("strips scaffolding for known OpenAI transcript wrappers", () => {
    expect(
      maybeStripAssistantScaffoldingForLiveModel("<final>Visible</final>", "openai/gpt-5.4-pro"),
    ).toBe("Visible");
    expect(
      maybeStripAssistantScaffoldingForLiveModel("<final>Visible</final>", "openai/gpt-5.4"),
    ).toBe("<final>Visible</final>");
  });

  it("strips Anthropic antml transcript wrappers", () => {
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        "<antml:thinking>hidden</thinking>Visible",
        "anthropic/claude-opus-4-6",
      ),
    ).toBe("Visible");
  });

  it("strips scaffolding for MiniMax transcript wrappers", () => {
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        "<final>Visible</final>",
        "minimax/MiniMax-M2.5-highspeed",
      ),
    ).toBe("Visible");
    expect(
      maybeStripAssistantScaffoldingForLiveModel(
        "<final>Visible</final>",
        "minimax-portal/MiniMax-M2.7-highspeed",
      ),
    ).toBe("Visible");
    expect(
      maybeStripAssistantScaffoldingForLiveModel("<final>Visible</final>", "minimax/MiniMax-M2.7"),
    ).toBe("Visible");
  });
});

describe("shouldSkipExecReadNonceMissForLiveModel", () => {
  it("matches the known Gemini lite exec/read isolation case", () => {
    expect(shouldSkipExecReadNonceMissForLiveModel("google/gemini-3.1-flash-lite-preview")).toBe(
      true,
    );
    expect(shouldSkipExecReadNonceMissForLiveModel("google/gemini-3.1-flash-lite")).toBe(true);
    expect(shouldSkipExecReadNonceMissForLiveModel("google/gemini-3.1-flash-preview")).toBe(false);
  });

  it("matches hosted Fireworks models that execute but miss readback nonces", () => {
    expect(
      shouldSkipExecReadNonceMissForLiveModel("fireworks/accounts/fireworks/models/glm-5"),
    ).toBe(true);
    expect(
      shouldSkipExecReadNonceMissForLiveModel("fireworks/accounts/fireworks/models/kimi-k2p5"),
    ).toBe(true);
    expect(
      shouldSkipExecReadNonceMissForLiveModel("fireworks/accounts/fireworks/models/kimi-k2p6"),
    ).toBe(true);
    expect(
      shouldSkipExecReadNonceMissForLiveModel(
        "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
      ),
    ).toBe(true);
  });
});

describe("resolveGatewayLiveModelTimeoutMs", () => {
  it("prefers gateway-specific timeout when provided", () => {
    expect(resolveGatewayLiveModelTimeoutMs("180000", "45000", 90_000)).toBe(180_000);
  });

  it("falls back to the shared live timeout", () => {
    expect(resolveGatewayLiveModelTimeoutMs("", "45000", 30_000)).toBe(45_000);
  });

  it("defaults to the release live model budget", () => {
    expect(resolveGatewayLiveModelTimeoutMs("", undefined, 90_000)).toBe(300_000);
  });
});

describe("resolveGatewayLiveTranscriptTimeoutMs", () => {
  it("uses the model budget for transcript waits", () => {
    expect(resolveGatewayLiveTranscriptTimeoutMs(90_000, 180_000)).toBe(180_000);
  });
});

describe("gateway live timeout floors", () => {
  it("defaults setup budget above slow ARM model discovery", () => {
    expect(resolveGatewayLiveSetupTimeoutMs("")).toBe(180_000);
  });

  it("keeps explicit shorter setup budgets available for targeted probes", () => {
    expect(resolveGatewayLiveSetupTimeoutMs("60000")).toBe(60_000);
  });

  it("never goes below the probe timeout", () => {
    expect(resolveGatewayLiveModelTimeoutMs("45000", undefined, 90_000)).toBe(90_000);
    expect(resolveGatewayLiveTranscriptTimeoutMs(240_000, 180_000)).toBe(240_000);
  });
});

describe("resolveGatewayLiveSessionControlTimeoutMs", () => {
  it("allows slow gateway session-control calls without using the full model budget", () => {
    expect(resolveGatewayLiveSessionControlTimeoutMs(90_000, 300_000)).toBe(180_000);
  });

  it("keeps explicit longer probe budgets intact", () => {
    expect(resolveGatewayLiveSessionControlTimeoutMs(240_000, 300_000)).toBe(240_000);
  });
});

describe("resolveGatewayLiveAgentRunTimeoutMs", () => {
  it("leaves terminal-observation grace inside the model timeout", () => {
    expect(resolveGatewayLiveAgentRunTimeoutMs(180_000)).toBe(150_000);
  });

  it("keeps short live probes bounded but positive", () => {
    expect(resolveGatewayLiveAgentRunTimeoutMs(6_000)).toBe(1_000);
  });
});

describe("resolveGatewayLiveAgentWaitTimeoutMs", () => {
  it("waits past the run timeout but before the model timeout", () => {
    expect(resolveGatewayLiveAgentWaitTimeoutMs(150_000, 180_000)).toBe(160_000);
  });
});

describe("resolveGatewayLiveProviderTimeoutSeconds", () => {
  it("matches provider timeout config to the harness model budget", () => {
    expect(resolveGatewayLiveProviderTimeoutSeconds(180_001)).toBe(181);
  });
});

describe("isGatewayLiveProbeTimeout", () => {
  it("keeps missing terminal replies out of provider timeout skips", () => {
    expect(isGatewayLiveProbeTimeout("probe timeout after 90000ms (prompt)")).toBe(true);
    expect(isGatewayLiveProbeTimeout("terminal timeout after 90000ms (tool-read)")).toBe(false);
  });
});

describe("isGatewayLiveModelTimeout", () => {
  it("matches provider-attributed agent wait timeouts", () => {
    expect(
      isGatewayLiveModelTimeout(
        "minimax/MiniMax-M3: prompt: agent.wait timeout for runId=idem-1 (timeoutPhase=provider, providerStarted=true, stopReason=rpc, error=aborted)",
      ),
    ).toBe(true);
  });

  it("does not match wait-layer agent wait timeouts", () => {
    expect(
      isGatewayLiveModelTimeout(
        "minimax/MiniMax-M3: prompt: agent.wait timeout for runId=idem-1 (timeoutPhase=queue, providerStarted=false, stopReason=rpc, error=aborted)",
      ),
    ).toBe(false);
  });
});

describe("formatGatewayLiveAgentWaitFailure", () => {
  it("includes terminal attribution fields without requiring transcript text", () => {
    expect(
      formatGatewayLiveAgentWaitFailure({
        context: "anthropic prompt",
        runId: "run-1",
        result: {
          status: "timeout",
          timeoutPhase: "provider",
          providerStarted: true,
          stopReason: "rpc",
        },
      }).message,
    ).toContain(
      "anthropic prompt: agent.wait timeout for runId=run-1 (timeoutPhase=provider, providerStarted=true, stopReason=rpc)",
    );
  });
});

describe("isGatewayAgentWaitCompletedWithoutReply", () => {
  it("accepts the malformed completion envelope used by tool-only turns", () => {
    expect(isGatewayAgentWaitCompletedWithoutReply({ status: "error", error: " completed " })).toBe(
      true,
    );
  });

  it("rejects genuine agent errors and non-error completion envelopes", () => {
    expect(isGatewayAgentWaitCompletedWithoutReply({ status: "error", error: "aborted" })).toBe(
      false,
    );
    expect(isGatewayAgentWaitCompletedWithoutReply({ status: "ok", error: "completed" })).toBe(
      false,
    );
  });
});

describe("assertGatewayLiveDidNotSkipAllDueToTimeout", () => {
  it("allows all-skip runs when no timeout skip was involved", () => {
    expect(() =>
      assertGatewayLiveDidNotSkipAllDueToTimeout({
        label: "all-models",
        skippedCount: 2,
        timeoutSkippedCount: 0,
        total: 2,
      }),
    ).not.toThrow();
  });

  it("fails all-skip runs when timeout skips consumed the selected coverage", () => {
    expect(() =>
      assertGatewayLiveDidNotSkipAllDueToTimeout({
        label: "all-models",
        skippedCount: 1,
        timeoutSkippedCount: 1,
        total: 1,
      }),
    ).toThrow(/skipped all 1 live model/);
  });
});

describe("assertGatewayLiveCompletedSomeModels", () => {
  it("allows live sweeps with at least one successful model run", () => {
    expect(() =>
      assertGatewayLiveCompletedSomeModels({
        label: "all-models",
        passedCount: 1,
        skippedCount: 4,
        timeoutSkippedCount: 0,
        total: 5,
      }),
    ).not.toThrow();
  });

  it("fails live sweeps with no successful model runs", () => {
    expect(() =>
      assertGatewayLiveCompletedSomeModels({
        label: "all-models",
        passedCount: 0,
        skippedCount: 2,
        timeoutSkippedCount: 0,
        total: 2,
      }),
    ).toThrow(/completed zero successful live model run/);
  });
});

describe("assertGatewayLiveSelectedSomeModels", () => {
  it("allows unfiltered sweeps with no high-signal models", () => {
    expect(() =>
      assertGatewayLiveSelectedSomeModels({
        allowProviderDriftSkip: false,
        label: "all-models",
        modelFilter: null,
        providerFilter: null,
        total: 0,
        useSmall: false,
        useExplicit: false,
        wantedCount: 0,
      }),
    ).not.toThrow();
  });

  it("fails filtered sweeps that select no models", () => {
    expect(() =>
      assertGatewayLiveSelectedSomeModels({
        allowProviderDriftSkip: false,
        label: "all-models",
        modelFilter: null,
        providerFilter: new Set(["openai"]),
        total: 42,
        useSmall: false,
        useExplicit: false,
        wantedCount: 0,
      }),
    ).toThrow(/selected no high-signal live models/);
  });

  it("allows modern provider-drift skips for empty MiniMax provider sweeps", () => {
    expect(() =>
      assertGatewayLiveSelectedSomeModels({
        allowProviderDriftSkip: true,
        label: "all-models",
        modelFilter: null,
        providerFilter: new Set(["minimax", "minimax-portal"]),
        total: 0,
        useSmall: false,
        useExplicit: false,
        wantedCount: 0,
      }),
    ).not.toThrow();
  });
});

describe("assertGatewayLiveHasRunnableCandidates", () => {
  it("fails selected sweeps when auth lookup leaves no runnable candidates", () => {
    expect(() =>
      assertGatewayLiveHasRunnableCandidates({
        candidatesCount: 0,
        label: "all-models",
        skipped: [{ model: "openai/gpt-5.5", error: "missing auth profile" }],
      }),
    ).toThrow(/selected no runnable live model candidates/);
  });

  it("allows selected sweeps with runnable candidates", () => {
    expect(() =>
      assertGatewayLiveHasRunnableCandidates({
        candidatesCount: 1,
        label: "all-models",
        skipped: [],
      }),
    ).not.toThrow();
  });
});

describe("failGatewayLiveStartupCoverage", () => {
  it("fails startup timeouts instead of treating them as skipped live coverage", () => {
    expect(() =>
      failGatewayLiveStartupCoverage({
        label: "all-models",
        reason: "probe timeout after 90000ms (all-models: gateway-start)",
      }),
    ).toThrow(/gateway startup failed before live model coverage/);
  });
});

describe("resolveGatewayLiveSuiteTimeoutMs", () => {
  it("leaves uncapped explicit sweeps bounded by the unbounded live timeout", () => {
    expect(resolveGatewayLiveSuiteTimeoutMs(0)).toBe(GATEWAY_LIVE_UNBOUNDED_TIMEOUT_MS);
  });

  it("scales model-capped sweeps for multi-probe retries", () => {
    expect(resolveGatewayLiveSuiteTimeoutMs(4)).toBeGreaterThan(GATEWAY_LIVE_DEFAULT_TIMEOUT_MS);
  });

  it("caps very large model sweeps", () => {
    expect(resolveGatewayLiveSuiteTimeoutMs(999)).toBe(GATEWAY_LIVE_MAX_TIMEOUT_MS);
  });
});

describe("resolveGatewayLiveMaxModels", () => {
  const originalGatewayModels = process.env.OPENCLAW_LIVE_GATEWAY_MODELS;
  const originalGatewayMax = process.env.OPENCLAW_LIVE_GATEWAY_MAX_MODELS;
  const originalSharedMax = process.env.OPENCLAW_LIVE_MAX_MODELS;
  function restoreEnvValue(name: string, value: string | undefined): void {
    if (value === undefined) {
      deleteTestEnvValue(name);
    } else {
      setTestEnvValue(name, value);
    }
  }

  afterEach(() => {
    restoreEnvValue("OPENCLAW_LIVE_GATEWAY_MODELS", originalGatewayModels);
    restoreEnvValue("OPENCLAW_LIVE_GATEWAY_MAX_MODELS", originalGatewayMax);
    restoreEnvValue("OPENCLAW_LIVE_MAX_MODELS", originalSharedMax);
  });

  it("defaults modern gateway sweeps to the curated high-signal cap", () => {
    delete process.env.OPENCLAW_LIVE_GATEWAY_MODELS;
    delete process.env.OPENCLAW_LIVE_GATEWAY_MAX_MODELS;
    delete process.env.OPENCLAW_LIVE_MAX_MODELS;

    expect(resolveGatewayLiveMaxModels()).toBe(DEFAULT_HIGH_SIGNAL_LIVE_MODEL_LIMIT);
  });

  it("defaults small gateway sweeps to the curated small-model cap", () => {
    process.env.OPENCLAW_LIVE_GATEWAY_MODELS = "small";
    delete process.env.OPENCLAW_LIVE_GATEWAY_MAX_MODELS;
    delete process.env.OPENCLAW_LIVE_MAX_MODELS;

    expect(resolveGatewayLiveMaxModels()).toBe(DEFAULT_SMALL_LIVE_MODEL_LIMIT);
  });

  it("keeps explicit gateway model lists uncapped unless a cap is provided", () => {
    process.env.OPENCLAW_LIVE_GATEWAY_MODELS = "openai/gpt-5.5,anthropic/claude-opus-4-6";
    delete process.env.OPENCLAW_LIVE_GATEWAY_MAX_MODELS;
    delete process.env.OPENCLAW_LIVE_MAX_MODELS;

    expect(resolveGatewayLiveMaxModels()).toBe(0);

    process.env.OPENCLAW_LIVE_GATEWAY_MAX_MODELS = "2";
    expect(resolveGatewayLiveMaxModels()).toBe(2);
  });
});

function createGatewayLiveTestModel(provider: string, id: string): Model {
  return {
    provider,
    id,
    name: id,
    api: resolveExplicitLiveFallbackApi(provider),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
    reasoning: false,
  } as Model;
}

const EXPLICIT_LIVE_FALLBACK_API_BY_PROVIDER: Partial<Record<string, Api>> = {
  "amazon-bedrock": "bedrock-converse-stream",
};

const DEFAULT_BEDROCK_LIVE_REGION = "us-east-1";

function resolveExplicitLiveFallbackApi(provider: string): Api {
  return (
    EXPLICIT_LIVE_FALLBACK_API_BY_PROVIDER[normalizeProviderId(provider)] ?? "openai-responses"
  );
}

function resolveDefaultBedrockLiveBaseUrl(
  params: {
    cfg?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  } = {},
): string {
  const env = params.env ?? process.env;
  const region =
    resolveBedrockDiscoveryRegion(params.cfg) ??
    normalizeOptionalEnvValue(env.AWS_REGION) ??
    normalizeOptionalEnvValue(env.AWS_DEFAULT_REGION) ??
    resolveAwsProfileRegion(env) ??
    DEFAULT_BEDROCK_LIVE_REGION;
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

function resolveBedrockDiscoveryRegion(cfg: OpenClawConfig | undefined): string | undefined {
  const pluginConfig = cfg?.plugins?.entries?.["amazon-bedrock"]?.config;
  if (!isRecord(pluginConfig)) {
    return undefined;
  }
  const discoveryConfig = pluginConfig.discovery;
  if (!isRecord(discoveryConfig)) {
    return undefined;
  }
  const region = discoveryConfig.region;
  return typeof region === "string" ? normalizeOptionalEnvValue(region) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveAwsProfileRegion(env: NodeJS.ProcessEnv): string | undefined {
  const profile = normalizeOptionalEnvValue(env.AWS_PROFILE) ?? "default";
  const homeDir = normalizeOptionalEnvValue(env.HOME) ?? os.homedir();
  const credentialsRegion = readAwsProfileRegionFromFile(
    resolveAwsSharedFilePath(
      env.AWS_SHARED_CREDENTIALS_FILE,
      homeDir,
      path.join(".aws", "credentials"),
    ),
    profile,
    "credentials",
  );
  if (credentialsRegion) {
    return credentialsRegion;
  }
  return readAwsProfileRegionFromFile(
    resolveAwsSharedFilePath(env.AWS_CONFIG_FILE, homeDir, path.join(".aws", "config")),
    profile,
    "config",
  );
}

function resolveAwsSharedFilePath(
  configuredPath: string | undefined,
  homeDir: string,
  defaultRelativePath: string,
): string {
  const normalized = normalizeOptionalEnvValue(configuredPath);
  if (!normalized) {
    return path.join(homeDir, defaultRelativePath);
  }
  if (normalized === "~") {
    return homeDir;
  }
  if (normalized.startsWith("~/")) {
    return path.join(homeDir, normalized.slice(2));
  }
  return path.resolve(normalized);
}

function readAwsProfileRegionFromFile(
  filePath: string,
  profile: string,
  fileKind: "config" | "credentials",
): string | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    return parseAwsProfileRegion(readFileSync(filePath, "utf8"), profile, fileKind);
  } catch {
    return undefined;
  }
}

function parseAwsProfileRegion(
  contents: string,
  profile: string,
  fileKind: "config" | "credentials",
): string | undefined {
  let currentSection: string | undefined;
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = stripAwsSharedIniComment(rawLine).trim();
    if (!line) {
      continue;
    }
    const section = /^\[([^\]]+)\]$/u.exec(line);
    if (section) {
      currentSection = normalizeAwsProfileSection(section[1] ?? "", fileKind);
      continue;
    }
    if (currentSection !== profile) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim();
    if (key !== "region") {
      continue;
    }
    return normalizeOptionalEnvValue(value);
  }
  return undefined;
}

function stripAwsSharedIniComment(value: string): string {
  return value.split(/(^|\s)[;#]/u)[0] ?? "";
}

function normalizeAwsProfileSection(section: string, fileKind: "config" | "credentials"): string {
  const trimmed = section.trim();
  if (trimmed === "default" || fileKind === "credentials") {
    return trimmed;
  }
  const profileSection = /^profile\s+(?:"([^"]+)"|'([^']+)'|([\w@+.%:/-]+))$/u.exec(trimmed);
  return profileSection
    ? (profileSection[1] ?? profileSection[2] ?? profileSection[3] ?? "")
    : trimmed;
}

function normalizeOptionalEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim() || undefined;
  }
  return trimmed;
}

function createExplicitLiveFallbackModel(provider: string, id: string): Model {
  return {
    ...createGatewayLiveTestModel(provider, id),
    contextWindow: EXPLICIT_LIVE_FALLBACK_CONTEXT_WINDOW,
    maxTokens: 4_096,
  };
}

function createGatewayLiveTestRegistry(overrides: Partial<ModelRegistry>): ModelRegistry {
  return {
    find() {
      return undefined;
    },
    getAll() {
      return [];
    },
    getAvailable() {
      return [];
    },
    hasConfiguredAuth() {
      return true;
    },
    ...overrides,
  };
}

describe("resolveExplicitLiveModelCandidates", () => {
  it("uses targeted registry lookup for explicit provider/model filters", () => {
    const model = createGatewayLiveTestModel("xai", "grok-4.3");
    const matcher = createLiveTargetMatcher({
      providerFilter: new Set(["xai"]),
      modelFilter: new Set(["xai/grok-4.3"]),
      env: {},
    });
    const candidates = resolveExplicitLiveModelCandidates({
      modelRegistry: createGatewayLiveTestRegistry({
        find(provider, modelId) {
          expect(provider).toBe("xai");
          expect(modelId).toBe("grok-4.3");
          return model;
        },
        getAll() {
          throw new Error("explicit model lookup should not enumerate registry");
        },
      }),
      modelFilter: new Set(["xai/grok-4.3"]),
      providerFilter: new Set(["xai"]),
      targetMatcher: matcher,
    });

    expect(candidates).toEqual([model]);
  });

  it("normalizes retired Google Gemini refs before targeted lookup", () => {
    const model = createGatewayLiveTestModel("google", "gemini-3.1-pro-preview");
    const matcher = createLiveTargetMatcher({
      providerFilter: new Set(["google"]),
      modelFilter: new Set(["google/gemini-3-pro-preview"]),
      env: {},
    });
    const candidates = resolveExplicitLiveModelCandidates({
      modelRegistry: createGatewayLiveTestRegistry({
        find(provider, modelId) {
          expect(provider).toBe("google");
          expect(modelId).toBe("gemini-3.1-pro-preview");
          return model;
        },
        getAll() {
          throw new Error("explicit model lookup should not enumerate registry");
        },
      }),
      modelFilter: new Set(["google/gemini-3-pro-preview"]),
      providerFilter: new Set(["google"]),
      targetMatcher: matcher,
    });

    expect(candidates).toEqual([model]);
  });

  it("keeps provider-qualified explicit refs usable when the registry is empty", () => {
    const matcher = createLiveTargetMatcher({
      providerFilter: new Set(["openai"]),
      modelFilter: new Set(["openai/gpt-5.5"]),
      env: {},
    });
    const candidates = resolveExplicitLiveModelCandidates({
      modelRegistry: createGatewayLiveTestRegistry({
        find(provider, modelId) {
          expect(provider).toBe("openai");
          expect(modelId).toBe("gpt-5.5");
          return undefined;
        },
        getAll() {
          throw new Error("explicit model lookup should not enumerate registry");
        },
      }),
      modelFilter: new Set(["openai/gpt-5.5"]),
      providerFilter: new Set(["openai"]),
      targetMatcher: matcher,
    });

    if (!candidates) {
      throw new Error("expected explicit fallback candidates");
    }
    expect(candidates).toEqual([createExplicitLiveFallbackModel("openai", "gpt-5.5")]);
    expect(candidates[0]?.contextWindow).toBeGreaterThanOrEqual(4_000);
  });

  it("uses the Bedrock Converse API for explicit Bedrock fallback candidates", () => {
    const modelRef = "amazon-bedrock/global.anthropic.claude-sonnet-4-6";
    const matcher = createLiveTargetMatcher({
      providerFilter: new Set(["amazon-bedrock"]),
      modelFilter: new Set([modelRef]),
      env: {},
    });
    const candidates = resolveExplicitLiveModelCandidates({
      modelRegistry: createGatewayLiveTestRegistry({
        find(provider, modelId) {
          expect(provider).toBe("amazon-bedrock");
          expect(modelId).toBe("global.anthropic.claude-sonnet-4-6");
          return undefined;
        },
      }),
      modelFilter: new Set([modelRef]),
      providerFilter: new Set(["amazon-bedrock"]),
      targetMatcher: matcher,
    });

    expect(candidates?.[0]).toMatchObject({
      provider: "amazon-bedrock",
      id: "global.anthropic.claude-sonnet-4-6",
      api: "bedrock-converse-stream",
    });
  });

  it("falls back to enumeration for ambiguous model-only filters", () => {
    const matcher = createLiveTargetMatcher({
      providerFilter: null,
      modelFilter: new Set(["grok-4.3"]),
      env: {},
    });

    expect(
      resolveExplicitLiveModelCandidates({
        modelRegistry: createGatewayLiveTestRegistry({
          find() {
            throw new Error("ambiguous model-only lookup should not use direct find");
          },
          getAll() {
            return [];
          },
        }),
        modelFilter: new Set(["grok-4.3"]),
        providerFilter: null,
        targetMatcher: matcher,
      }),
    ).toBeNull();
  });
});

describe("providerScopedModelRegistryProviders", () => {
  it("uses curated high-signal providers for default modern sweeps", () => {
    expect(
      providerScopedModelRegistryProviders({
        providerList: undefined,
        useSmall: false,
        useExplicit: false,
        modelFilter: null,
        providerFilter: null,
      }),
    ).toEqual(getHighSignalLiveModelProviders());
  });

  it("intersects default modern sweeps with provider filters", () => {
    expect(
      providerScopedModelRegistryProviders({
        providerList: undefined,
        useSmall: false,
        useExplicit: false,
        modelFilter: null,
        providerFilter: new Set(["openai", "not-high-signal"]),
      }),
    ).toEqual(["openai"]);
  });

  it("uses curated small-model providers for small sweeps", () => {
    expect(
      providerScopedModelRegistryProviders({
        providerList: undefined,
        useSmall: true,
        useExplicit: false,
        modelFilter: null,
        providerFilter: null,
      }),
    ).toEqual(["lmstudio", "ollama", "openrouter", "sglang", "vllm", "zai"]);
  });

  it("intersects small gateway sweeps with provider filters", () => {
    expect(
      providerScopedModelRegistryProviders({
        providerList: undefined,
        useSmall: true,
        useExplicit: false,
        modelFilter: null,
        providerFilter: new Set(["ollama", "openai"]),
      }),
    ).toEqual(["ollama"]);
  });

  it("filters prioritized small refs before dynamic lookup", () => {
    expect(
      filterGatewayLiveModelRefsByProvider(
        listPrioritizedSmallLiveModelRefs(),
        new Set(["ollama"]),
      ),
    ).toEqual([{ provider: "ollama", id: "gemma3:4b" }]);
  });

  it("does not count small models outside a provider-scoped gateway sweep", () => {
    const matcher = createLiveTargetMatcher({
      providerFilter: new Set(["ollama"]),
      modelFilter: null,
      env: {},
    });

    expect(
      isWantedSmallGatewayLiveModel({
        model: createGatewayLiveTestModel("openrouter", "qwen/qwen3.5-9b"),
        targetMatcher: matcher,
      }),
    ).toBe(false);
    expect(
      isWantedSmallGatewayLiveModel({
        model: createGatewayLiveTestModel("ollama", "gemma3:4b"),
        targetMatcher: matcher,
      }),
    ).toBe(true);
  });

  it("uses explicit provider-qualified model refs without enumerating the full registry", () => {
    expect(
      providerScopedModelRegistryProviders({
        providerList: undefined,
        useSmall: false,
        useExplicit: true,
        modelFilter: new Set(["openai/gpt-5.2", "anthropic/claude-sonnet-4-6"]),
        providerFilter: null,
      }),
    ).toEqual(["anthropic", "openai"]);
  });

  it("uses a single provider filter for explicit model-only refs", () => {
    expect(
      providerScopedModelRegistryProviders({
        providerList: undefined,
        useSmall: false,
        useExplicit: true,
        modelFilter: new Set(["gpt-5.2"]),
        providerFilter: new Set(["openai"]),
      }),
    ).toEqual(["openai"]);
  });

  it("falls back to the full registry for ambiguous explicit model-only refs", () => {
    expect(
      providerScopedModelRegistryProviders({
        providerList: undefined,
        useSmall: false,
        useExplicit: true,
        modelFilter: new Set(["gpt-5.2"]),
        providerFilter: null,
      }),
    ).toBeUndefined();
  });
});

describe("resolveGatewayLiveModelThinkingLevel", () => {
  it("allows release lanes to lower gateway live thinking without smoke mode", () => {
    expect(resolveGatewayLiveThinkingLevel({ raw: "low", smoke: false })).toBe("low");
    expect(resolveGatewayLiveThinkingLevel({ raw: undefined, smoke: false })).toBe("high");
    expect(resolveGatewayLiveThinkingLevel({ raw: undefined, smoke: true })).toBe("low");
    expect(resolveGatewayLiveThinkingLevel({ raw: "wat", smoke: false })).toBe("high");
  });

  it("clamps requested thinking to levels supported by model metadata", () => {
    expect(
      resolveGatewayLiveModelThinkingLevel({
        cfg: {},
        model: {
          ...createGatewayLiveTestModel("example", "reasoning-model"),
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: null,
            xhigh: null,
          },
        },
        requestedLevel: "low",
      }),
    ).toBe("off");
  });

  it("does not let provider profiles override model-level thinking support", () => {
    expect(
      resolveGatewayLiveModelThinkingLevel({
        cfg: {},
        model: createGatewayLiveTestModel("openai", "gpt-5.5"),
        requestedLevel: "high",
      }),
    ).toBe("off");
  });
});

describe("buildLiveGatewayConfig", () => {
  it("pins selected live gateway models to the OpenClaw runtime", () => {
    const cfg = buildLiveGatewayConfig({
      cfg: {},
      candidates: [createGatewayLiveTestModel("openai", "gpt-5.5")],
      liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
      liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
    });

    expect(cfg.agents?.defaults?.models?.["openai/gpt-5.5"]).toEqual({
      agentRuntime: { id: "openclaw" },
    });
  });

  it("configures only the isolated live agent", () => {
    const cfg = buildLiveGatewayConfig({
      cfg: {
        agents: {
          list: [{ id: "ops", default: true }],
        },
        bindings: [{ agentId: "ops", match: { channel: "telegram" } }],
        broadcast: {
          strategy: "parallel",
          "release-test": ["ops"],
        },
      },
      candidates: [createGatewayLiveTestModel("openai", "gpt-5.5")],
      liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
      liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
    });

    expect(cfg.agents?.list).toEqual([
      {
        id: GATEWAY_LIVE_AGENT_ID,
        default: true,
        agentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
        workspace: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
        sandbox: { mode: "off" },
      },
    ]);
    expect(cfg.bindings).toBeUndefined();
    expect(cfg.broadcast).toBeUndefined();
  });

  it("replaces a configured live agent workspace with the isolated workspace", () => {
    const cfg = buildLiveGatewayConfig({
      cfg: {
        agents: {
          list: [
            {
              id: "Dev",
              default: true,
              agentDir: "/operator/agent",
              workspace: "/operator/workspace",
            },
          ],
        },
      },
      candidates: [createGatewayLiveTestModel("openai", "gpt-5.5")],
      liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
      liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
    });

    expect(cfg.agents?.list).toEqual([
      {
        id: GATEWAY_LIVE_AGENT_ID,
        default: true,
        agentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
        workspace: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
        sandbox: { mode: "off" },
      },
    ]);
  });

  it("keeps discovered live model metadata ahead of stale configured model rows", () => {
    const discovered = {
      ...createGatewayLiveTestModel("google", "gemini-3-flash-preview"),
      contextWindow: 128_000,
    };
    const cfg = buildLiveGatewayConfig({
      cfg: {
        models: {
          providers: {
            google: {
              api: "google-generative-ai",
              baseUrl: "https://generativelanguage.googleapis.com",
              models: [
                {
                  id: "gemini-3-flash-preview",
                  name: "gemini-3-flash-preview",
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_000,
                  maxTokens: 100,
                  reasoning: false,
                },
              ],
            },
          },
        },
      },
      candidates: [discovered],
      liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
      liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
    });

    expect(cfg.models?.providers?.google?.models?.[0]?.contextWindow).toBe(128_000);
  });

  it("keeps live provider request timeout aligned with the harness model budget", () => {
    const cfg = buildLiveGatewayConfig({
      cfg: {
        models: {
          providers: {
            google: {
              api: "google-generative-ai",
              baseUrl: "https://generativelanguage.googleapis.com",
              models: [],
              timeoutSeconds: 30,
            },
          },
        },
      },
      candidates: [createGatewayLiveTestModel("google", "gemini-3.1-pro-preview")],
      liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
      liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
    });

    expect(cfg.models?.providers?.google?.timeoutSeconds).toBeGreaterThanOrEqual(
      Math.ceil(GATEWAY_LIVE_MODEL_TIMEOUT_MS / 1_000),
    );
  });

  it("writes valid AWS SDK provider config for explicit Bedrock fallback models", () => {
    const previous = {
      awsRegion: process.env.AWS_REGION,
      awsDefaultRegion: process.env.AWS_DEFAULT_REGION,
      awsProfile: process.env.AWS_PROFILE,
      awsConfigFile: process.env.AWS_CONFIG_FILE,
      awsSharedCredentialsFile: process.env.AWS_SHARED_CREDENTIALS_FILE,
      home: process.env.HOME,
    };
    try {
      deleteTestEnvValue("AWS_REGION");
      deleteTestEnvValue("AWS_DEFAULT_REGION");
      deleteTestEnvValue("AWS_PROFILE");
      deleteTestEnvValue("AWS_CONFIG_FILE");
      deleteTestEnvValue("AWS_SHARED_CREDENTIALS_FILE");
      setTestEnvValue("HOME", path.join(os.tmpdir(), `openclaw-empty-aws-home-${randomUUID()}`));

      const cfg = buildLiveGatewayConfig({
        cfg: {},
        candidates: [
          createExplicitLiveFallbackModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-6"),
        ],
        liveAgentDir: GATEWAY_LIVE_CONFIG_TEST_AGENT_DIR,
        liveAgentWorkspaceDir: GATEWAY_LIVE_CONFIG_TEST_WORKSPACE,
      });

      expect(cfg.models?.providers?.["amazon-bedrock"]).toMatchObject({
        api: "bedrock-converse-stream",
        auth: "aws-sdk",
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        models: [
          {
            id: "global.anthropic.cl…13498 tokens truncated…record = compat as Record<string, unknown>;
  const thinkingFormat =
    typeof record.thinkingFormat === "string" ? record.thinkingFormat : undefined;
  const supportedReasoningEfforts =
    Array.isArray(record.supportedReasoningEfforts) &&
    record.supportedReasoningEfforts.every((value) => typeof value === "string")
      ? record.supportedReasoningEfforts
      : record.supportedReasoningEfforts === null
        ? null
        : undefined;
  return thinkingFormat || supportedReasoningEfforts !== undefined
    ? {
        ...(thinkingFormat ? { thinkingFormat } : {}),
        ...(supportedReasoningEfforts !== undefined ? { supportedReasoningEfforts } : {}),
      }
    : undefined;
}

function resolveGatewayLiveThinkingLevel(params: { raw?: string; smoke: boolean }): string {
  const raw = params.raw?.trim().toLowerCase();
  if (!raw) {
    return params.smoke ? "low" : "high";
  }
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(raw)
    ? raw
    : params.smoke
      ? "low"
      : "high";
}

function buildLiveGatewayConfig(params: {
  cfg: OpenClawConfig;
  candidates: Array<Model>;
  liveAgentDir: string;
  liveAgentWorkspaceDir: string;
  providerOverrides?: Record<string, ModelProviderConfig>;
}): OpenClawConfig {
  const providerOverrides = params.providerOverrides ?? {};
  const lmstudioProvider = params.cfg.models?.providers?.lmstudio;
  const baseProviders = params.cfg.models?.providers ?? {};
  const candidateProviders = buildLiveProviderConfigs({
    candidates: params.candidates,
    cfg: params.cfg,
  });
  const discoveredProviders = Object.fromEntries(
    Object.entries(candidateProviders).map(([provider, discovered]) => [
      provider,
      mergeLiveProviderConfig({ provider, base: baseProviders[provider], discovered }),
    ]),
  );
  const nextProviders = {
    ...baseProviders,
    ...discoveredProviders,
    ...(lmstudioProvider
      ? {
          lmstudio: {
            ...lmstudioProvider,
            api: "openai-completions",
          },
        }
      : {}),
    ...providerOverrides,
  };
  const providers = Object.keys(nextProviders).length > 0 ? nextProviders : baseProviders;
  const configuredAgents = [
    {
      id: GATEWAY_LIVE_AGENT_ID,
      default: true,
      agentDir: params.liveAgentDir,
      workspace: params.liveAgentWorkspaceDir,
      sandbox: { mode: "off" },
    },
  ] satisfies NonNullable<OpenClawConfig["agents"]>["list"];
  const baseModels = params.cfg.models;
  return {
    ...params.cfg,
    bindings: undefined,
    broadcast: undefined,
    agents: {
      ...params.cfg.agents,
      list: configuredAgents,
      defaults: {
        ...params.cfg.agents?.defaults,
        // Live tests should avoid Docker sandboxing so tool probes can
        // operate on the temporary probe files we create in the host workspace.
        sandbox: { mode: "off" },
        // This suite validates direct provider/API-key gateway behavior. OpenAI
        // agent models otherwise use the implicit Codex runtime, which tests a
        // different auth/runtime path and can hang until the model timeout.
        models: Object.fromEntries(
          params.candidates.map((m) => [
            `${m.provider}/${m.id}`,
            { agentRuntime: { id: "openclaw" as const } },
          ]),
        ),
      },
    },
    models:
      Object.keys(providers).length > 0
        ? ({ ...baseModels, providers } as ModelsConfig)
        : baseModels,
  };
}

async function sanitizeAuthConfig(params: {
  cfg: OpenClawConfig;
  agentDir: string;
}): Promise<OpenClawConfig["auth"] | undefined> {
  const auth = params.cfg.auth;
  if (!auth) {
    return auth;
  }
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });

  let profiles: NonNullable<OpenClawConfig["auth"]>["profiles"] | undefined;
  if (auth.profiles) {
    profiles = {};
    for (const [profileId, profile] of Object.entries(auth.profiles)) {
      if (!store.profiles[profileId]) {
        continue;
      }
      profiles[profileId] = profile;
    }
    if (Object.keys(profiles).length === 0) {
      profiles = undefined;
    }
  }

  let order: Record<string, string[]> | undefined;
  if (auth.order) {
    order = {};
    for (const [provider, ids] of Object.entries(auth.order)) {
      const filtered = ids.filter((id) => Boolean(store.profiles[id]));
      if (filtered.length === 0) {
        continue;
      }
      order[provider] = filtered;
    }
    if (Object.keys(order).length === 0) {
      order = undefined;
    }
  }

  if (!profiles && !order && !auth.cooldowns) {
    return undefined;
  }
  return {
    ...auth,
    profiles,
    order,
  };
}

function buildMinimaxProviderOverride(params: {
  cfg: OpenClawConfig;
  api: "openai-completions" | "anthropic-messages";
  baseUrl: string;
}): ModelProviderConfig | null {
  const existing = params.cfg.models?.providers?.minimax;
  if (!existing || !Array.isArray(existing.models) || existing.models.length === 0) {
    return null;
  }
  return {
    ...existing,
    api: params.api,
    baseUrl: params.baseUrl,
  };
}

async function runGatewayModelSuite(params: GatewayModelSuiteParams) {
  clearRuntimeConfigSnapshot();
  const runtimeEnv = enterProductionEnvForLiveRun();
  const previous = {
    configPath: process.env.OPENCLAW_CONFIG_PATH,
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
    skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
    skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
    skipCron: process.env.OPENCLAW_SKIP_CRON,
    skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
    disableBonjour: process.env.OPENCLAW_DISABLE_BONJOUR,
    logLevel: process.env.OPENCLAW_LOG_LEVEL,
    agentDir: process.env.OPENCLAW_AGENT_DIR,
    stateDir: process.env.OPENCLAW_STATE_DIR,
  };

  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
  if (QUIET_LIVE_LOGS) {
    process.env.OPENCLAW_DISABLE_BONJOUR = "1";
    process.env.OPENCLAW_LOG_LEVEL = "silent";
  }

  const token = `test-${randomUUID()}`;
  process.env.OPENCLAW_GATEWAY_TOKEN = token;
  const agentId = GATEWAY_LIVE_AGENT_ID;

  const hostAgentDir = resolveDefaultAgentDir(getRuntimeConfig());
  const hostStore = ensureAuthProfileStore(hostAgentDir, {
    allowKeychainPrompt: false,
  });
  const sanitizedStore = sanitizeAuthProfileStoreForLiveGateway({
    version: hostStore.version,
    profiles: { ...hostStore.profiles },
    // Keep selection state so the gateway picks the same known-good profiles
    // as the host (important when some profiles are rate-limited/disabled).
    order: hostStore.order ? { ...hostStore.order } : undefined,
    lastGood: hostStore.lastGood ? { ...hostStore.lastGood } : undefined,
    usageStats: hostStore.usageStats ? { ...hostStore.usageStats } : undefined,
  });
  const tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-state-"));
  setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
  const tempAgentDir: string | undefined = path.join(
    tempStateDir,
    "agents",
    DEFAULT_AGENT_ID,
    "agent",
  );
  saveAuthProfileStore(sanitizedStore, tempAgentDir);
  const tempSessionAgentDir = path.join(tempStateDir, "agents", agentId, "agent");
  if (tempSessionAgentDir !== tempAgentDir) {
    saveAuthProfileStore(sanitizedStore, tempSessionAgentDir);
  }
  setTestEnvValue("OPENCLAW_AGENT_DIR", tempAgentDir);

  const workspaceDir = path.join(tempStateDir, "workspace-dev");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(path.join(workspaceDir, ".openclaw"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, ".openclaw", "workspace-state.json"),
    `${JSON.stringify(
      {
        version: 1,
        setupCompletedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  await fs.rm(path.join(workspaceDir, "BOOTSTRAP.md"), { force: true });
  const nonceA = randomUUID();
  const nonceB = randomUUID();
  const toolProbePath = path.join(workspaceDir, `.openclaw-live-tool-probe.${nonceA}.txt`);
  await fs.writeFile(toolProbePath, `nonceA=${nonceA}\nnonceB=${nonceB}\n`);

  const agentDir = resolveDefaultAgentDir(params.cfg);
  const sanitizedCfg: OpenClawConfig = {
    ...params.cfg,
    auth: await sanitizeAuthConfig({ cfg: params.cfg, agentDir }),
  };
  const nextCfg = buildLiveGatewayConfig({
    cfg: sanitizedCfg,
    candidates: params.candidates,
    liveAgentDir: tempSessionAgentDir,
    liveAgentWorkspaceDir: workspaceDir,
    providerOverrides: params.providerOverrides,
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-"));
  const tempConfigPath = path.join(tempDir, "openclaw.json");
  await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
  setTestEnvValue("OPENCLAW_CONFIG_PATH", tempConfigPath);

  const liveProviders = nextCfg.models?.providers;
  if (liveProviders && Object.keys(liveProviders).length > 0) {
    const modelsPath = path.join(tempAgentDir, "models.json");
    await fs.mkdir(tempAgentDir, { recursive: true });
    await fs.writeFile(modelsPath, `${JSON.stringify({ providers: liveProviders }, null, 2)}\n`);
  }

  // Keep the broad live Docker suite on the impl entrypoint. The lazy public
  // boundary (`./server.js`) is covered elsewhere, but under Vitest's live Docker
  // worker this path can trip a Node module-status loader bug during startup.
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let client: GatewayClient | undefined;
  try {
    try {
      const port = await withGatewayLiveProbeTimeout(
        getFreeGatewayPort(),
        `${params.label}: gateway-port`,
      );
      server = await withGatewayLiveProbeTimeout(
        startGatewayServer(port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
        }),
        `${params.label}: gateway-start`,
      );

      client = await withGatewayLiveProbeTimeout(
        connectClient({
          url: `ws://127.0.0.1:${port}`,
          token,
        }),
        `${params.label}: gateway-connect`,
      );
    } catch (error) {
      const message = String(error);
      if (isGatewayLiveProbeTimeout(message)) {
        failGatewayLiveStartupCoverage({ label: params.label, reason: message });
      }
      throw error;
    }

    if (!server || !client) {
      failGatewayLiveStartupCoverage({
        label: params.label,
        reason: "gateway server/client did not initialize",
      });
    }
    logProgress(
      `[${params.label}] running ${params.candidates.length} models (thinking=${params.thinkingLevel})`,
    );
    logProgress(
      `[${params.label}] heartbeat=${Math.max(1, Math.round(GATEWAY_LIVE_HEARTBEAT_MS / 1_000))}s probe-timeout=${Math.max(1, Math.round(GATEWAY_LIVE_PROBE_TIMEOUT_MS / 1_000))}s agent-timeout=${Math.max(1, Math.round(GATEWAY_LIVE_AGENT_RUN_TIMEOUT_MS / 1_000))}s agent-wait=${Math.max(1, Math.round(GATEWAY_LIVE_AGENT_WAIT_TIMEOUT_MS / 1_000))}s model-timeout=${Math.max(1, Math.round(GATEWAY_LIVE_MODEL_TIMEOUT_MS / 1_000))}s transcript-timeout=${Math.max(1, Math.round(GATEWAY_LIVE_TRANSCRIPT_TIMEOUT_MS / 1_000))}s`,
    );
    const anthropicKeys = collectAnthropicApiKeys();
    if (anthropicKeys.length > 0) {
      process.env.ANTHROPIC_API_KEY = anthropicKeys[0];
      logProgress(`[${params.label}] anthropic keys loaded: ${anthropicKeys.length}`);
    }
    const failures: Array<{ model: string; error: string }> = [];
    let passedCount = 0;
    let skippedCount = 0;
    let timeoutSkippedCount = 0;
    const total = params.candidates.length;

    for (const [index, model] of params.candidates.entries()) {
      const modelKey = `${model.provider}/${model.id}`;
      const progressLabel = `[${params.label}] ${index + 1}/${total} ${modelKey}`;
      const thinkingLevel = resolveGatewayLiveModelThinkingLevel({
        cfg: params.cfg,
        model,
        requestedLevel: params.thinkingLevel,
      });
      if (thinkingLevel !== params.thinkingLevel) {
        logProgress(`${progressLabel}: thinking ${params.thinkingLevel} -> ${thinkingLevel}`);
      }
      // Use a separate session per model: live providers can finalize late after
      // skip/retry paths, and a reset on a reused key does not isolate those
      // delayed transcript writes from the next model probe.
      const sessionKey = `agent:${agentId}:${params.label}:model-${index + 1}`;

      const attemptMax =
        model.provider === "anthropic" && anthropicKeys.length > 0 ? anthropicKeys.length : 1;

      for (let attempt = 0; attempt < attemptMax; attempt += 1) {
        if (model.provider === "anthropic" && anthropicKeys.length > 0) {
          process.env.ANTHROPIC_API_KEY = anthropicKeys[attempt];
        }
        try {
          const modelResult = await withGatewayLiveModelTimeout<"done" | "skip">(
            (async () => {
              // Ensure session exists + override model for this run.
              // Reset between models: avoids cross-provider transcript incompatibilities
              // (notably OpenAI Responses requiring reasoning replay for function_call items).
              await withGatewayLiveSessionControlTimeout(
                client.request("sessions.reset", {
                  key: sessionKey,
                }),
                `${progressLabel}: sessions-reset`,
              );
              await withGatewayLiveSessionControlTimeout(
                client.request("sessions.patch", {
                  key: sessionKey,
                  model: modelKey,
                }),
                `${progressLabel}: sessions-patch`,
              );

              logProgress(`${progressLabel}: prompt`);
              let text = await requestGatewayAgentText({
                client,
                sessionKey,
                idempotencyKey: `idem-${randomUUID()}`,
                modelKey,
                message:
                  "Explain in 2-3 sentences how the JavaScript event loop handles microtasks vs macrotasks. Must mention both words: microtask and macrotask.",
                thinkingLevel,
                context: `${progressLabel}: prompt`,
              });
              if (!text) {
                logProgress(`${progressLabel}: empty response, retrying`);
                text = await requestGatewayAgentText({
                  client,
                  sessionKey,
                  idempotencyKey: `idem-${randomUUID()}-retry`,
                  modelKey,
                  message:
                    "Explain in 2-3 sentences how the JavaScript event loop handles microtasks vs macrotasks. Must mention both words: microtask and macrotask.",
                  thinkingLevel,
                  context: `${progressLabel}: prompt-retry`,
                });
              }
              if (
                !text &&
                shouldSkipEmptyResponseForLiveModel({
                  provider: model.provider,
                  allowNotFoundSkip: params.allowNotFoundSkip,
                })
              ) {
                logProgress(`${progressLabel}: skip (${model.provider} empty response)`);
                return "skip";
              }
              if (
                isEmptyStreamText(text) &&
                shouldSkipEmptyResponseForLiveModel({
                  provider: model.provider,
                  allowNotFoundSkip: params.allowNotFoundSkip,
                })
              ) {
                logProgress(`${progressLabel}: skip (${model.provider} empty response)`);
                return "skip";
              }
              if (isGoogleishProvider(model.provider) && isGoogleModelNotFoundText(text)) {
                // Catalog drift: model IDs can disappear or become unavailable on the API.
                // Treat as skip when scanning "all models" for Google.
                logProgress(`${progressLabel}: skip (google model not found)`);
                return "skip";
              }
              if (params.allowNotFoundSkip && isModelNotFoundErrorMessage(text)) {
                logProgress(`${progressLabel}: skip (model not found)`);
                return "skip";
              }
              assertNoReasoningTags({
                text,
                model: modelKey,
                phase: "prompt",
                label: params.label,
              });
              if (!isMeaningful(text) || !hasEventLoopPromptKeywords(text)) {
                logProgress(`${progressLabel}: prompt retry (weak answer)`);
                const retryText = await requestGatewayAgentText({
                  client,
                  sessionKey,
                  idempotencyKey: `idem-${randomUUID()}-keyword-retry`,
                  modelKey,
                  message:
                    "Answer in exactly two short sentences. Include the exact lowercase words microtask and macrotask. No bullets.",
                  thinkingLevel,
                  context: `${progressLabel}: prompt-keyword-retry`,
                });
                if (retryText) {
                  text = retryText;
                  assertNoReasoningTags({
                    text,
                    model: modelKey,
                    phase: "prompt-retry",
                    label: params.label,
                  });
                }
              }
              if (!isMeaningful(text)) {
                if (isGoogleishProvider(model.provider) && /gemini/i.test(model.id)) {
                  logProgress(`${progressLabel}: skip (google not meaningful)`);
                  return "skip";
                }
                throw new Error(`not meaningful: ${text}`);
              }
              if (!hasEventLoopPromptKeywords(text)) {
                throw new Error(`missing required keywords: ${text}`);
              }

              // Real tool invocation: force the agent to Read a local file and echo a nonce.
              logProgress(`${progressLabel}: tool-read`);
              const runIdTool = randomUUID();
              const maxToolReadAttempts = 3;
              // Known-variable models already skip after exhausted nonce misses.
              // Use the stricter follow-up prompts before conceding that coverage.
              const retryKnownToolNonceMiss = shouldSkipToolNonceProbeMissForLiveModel(modelKey);
              let toolText = "";
              for (
                let toolReadAttempt = 0;
                toolReadAttempt < maxToolReadAttempts;
                toolReadAttempt += 1
              ) {
                const strictReply = toolReadAttempt > 0;
                try {
                  toolText = await requestGatewayAgentText({
                    client,
                    sessionKey,
                    idempotencyKey: `idem-${runIdTool}-tool-${toolReadAttempt + 1}`,
                    modelKey,
                    message: strictReply
                      ? "OpenClaw live tool probe (local, safe): " +
                        `use the tool named \`read\` (or \`Read\`) with JSON arguments {"path":"${toolProbePath}"}. ` +
                        "Then reply with exactly the two nonce values from that file, separated by one space. No extra text."
                      : "OpenClaw live tool probe (local, safe): " +
                        `use the tool named \`read\` (or \`Read\`) with JSON arguments {"path":"${toolProbePath}"}. ` +
                        "Then reply with the two nonce values you read (include both).",
                    thinkingLevel,
                    context: `${progressLabel}: tool-read`,
                  });
                } catch (error) {
                  const message = String(error instanceof Error ? error.message : error);
                  if (
                    isTransientToolReadProbeErrorForLiveModel(message) &&
                    toolReadAttempt + 1 < maxToolReadAttempts
                  ) {
                    logProgress(
                      `${progressLabel}: tool-read retry (${toolReadAttempt + 2}/${maxToolReadAttempts}) transient provider failover`,
                    );
                    continue;
                  }
                  if (
                    isTransientToolReadProbeErrorForLiveModel(message) &&
                    shouldSkipToolNonceProbeMissForLiveModel(modelKey)
                  ) {
                    logProgress(`${progressLabel}: skip (${modelKey} tool-read provider failover)`);
                    return "skip";
                  }
                  throw error;
                }
                if (
                  isEmptyStreamText(toolText) &&
                  shouldSkipEmptyResponseForLiveModel({
                    provider: model.provider,
                    allowNotFoundSkip: params.allowNotFoundSkip,
                  })
                ) {
                  logProgress(`${progressLabel}: skip (${model.provider} empty response)`);
                  return "skip";
                }
                assertNoReasoningTags({
                  text: toolText,
                  model: modelKey,
                  phase: "tool-read",
                  label: params.label,
                });
                if (hasExpectedToolNonce(toolText, nonceA, nonceB)) {
                  break;
                }
                if (
                  shouldRetryToolReadProbe({
                    text: toolText,
                    nonceA,
                    nonceB,
                    provider: model.provider,
                    attempt: toolReadAttempt,
                    maxAttempts: maxToolReadAttempts,
                    retryKnownNonceMismatch: retryKnownToolNonceMiss,
                  })
                ) {
                  logProgress(
                    `${progressLabel}: tool-read retry (${toolReadAttempt + 2}/${maxToolReadAttempts}) tool output mismatch`,
                  );
                  continue;
                }
                throw new Error(`tool probe missing nonce: ${toolText}`);
              }
              if (!hasExpectedToolNonce(toolText, nonceA, nonceB)) {
                throw new Error(`tool probe missing nonce: ${toolText}`);
              }

              if (params.extraToolProbes) {
                logProgress(`${progressLabel}: tool-exec`);
                const nonceC = randomUUID();
                // Timeout wrappers do not cancel late tool runs, so keep provider-key attempts
                // isolated without putting a nonce-shaped UUID in the model-visible path.
                const toolWritePath = path.join(
                  tempDir,
                  `write-model-${index + 1}-attempt-${attempt + 1}.txt`,
                );
                const maxExecReadAttempts = 3;
                const retryKnownExecReadNonceMiss =
                  shouldSkipExecReadNonceMissForLiveModel(modelKey) || retryKnownToolNonceMiss;
                let execReadText = "";
                for (
                  let execReadAttempt = 0;
                  execReadAttempt < maxExecReadAttempts;
                  execReadAttempt += 1
                ) {
                  const strictReply = execReadAttempt > 0;
                  execReadText = await requestGatewayAgentText({
                    client,
                    sessionKey,
                    idempotencyKey: `idem-${runIdTool}-exec-read-${execReadAttempt + 1}`,
                    modelKey,
                    message: strictReply
                      ? "OpenClaw live tool probe (local, safe): " +
                        "use the tool named `exec` (or `Exec`) to run this command: " +
                        `mkdir -p "${tempDir}" && printf '%s' '${nonceC}' > "${toolWritePath}". ` +
                        `Then use the tool named \`read\` (or \`Read\`) with JSON arguments {"path":"${toolWritePath}"}. ` +
                        "Then reply with exactly the nonce text from that file. No extra text."
                      : "OpenClaw live tool probe (local, safe): " +
                        "use the tool named `exec` (or `Exec`) to run this command: " +
                        `mkdir -p "${tempDir}" && printf '%s' '${nonceC}' > "${toolWritePath}". ` +
                        `Then use the tool named \`read\` (or \`Read\`) with JSON arguments {"path":"${toolWritePath}"}. ` +
                        "Finally reply including the nonce text you read back.",
                    thinkingLevel,
                    context: `${progressLabel}: tool-exec`,
                  });
                  if (
                    isEmptyStreamText(execReadText) &&
                    shouldSkipEmptyResponseForLiveModel({
                      provider: model.provider,
                      allowNotFoundSkip: params.allowNotFoundSkip,
                    })
                  ) {
                    logProgress(`${progressLabel}: skip (${model.provider} empty response)`);
                    return "skip";
                  }
                  assertNoReasoningTags({
                    text: execReadText,
                    model: modelKey,
                    phase: "tool-exec",
                    label: params.label,
                  });
                  if (hasExpectedSingleNonce(execReadText, nonceC)) {
                    break;
                  }
                  if (
                    shouldRetryExecReadProbe({
                      text: execReadText,
                      nonce: nonceC,
                      provider: model.provider,
                      attempt: execReadAttempt,
                      maxAttempts: maxExecReadAttempts,
                      retryKnownNonceMismatch: retryKnownExecReadNonceMiss,
                    })
                  ) {
                    logProgress(
                      `${progressLabel}: tool-exec retry (${execReadAttempt + 2}/${maxExecReadAttempts}) tool output mismatch`,
                    );
                    continue;
                  }
                  throw new Error(`exec+read probe missing nonce: ${execReadText}`);
                }
                if (!hasExpectedSingleNonce(execReadText, nonceC)) {
                  throw new Error(`exec+read probe missing nonce: ${execReadText}`);
                }

                await fs.rm(toolWritePath, { force: true });
              }

              if (params.extraImageProbes && model.input?.includes("image")) {
                logProgress(`${progressLabel}: image`);
                // Shorter code => less OCR flake across providers, still tests image attachments end-to-end.
                const imageCode = randomImageProbeCode();
                const imageBase64 = renderCatNoncePngBase64(imageCode);
                const runIdImage = randomUUID();

                const imageText = await requestGatewayAgentText({
                  client,
                  sessionKey,
                  idempotencyKey: `idem-${runIdImage}-image`,
                  modelKey,
                  message:
                    "Look at the attached image. Reply with exactly two tokens separated by a single space: " +
                    "(1) the animal shown or written in the image, lowercase; " +
                    "(2) the code printed in the image, uppercase. No extra text.",
                  attachments: [
                    {
                      mimeType: "image/png",
                      fileName: `probe-${runIdImage}.png`,
                      content: imageBase64,
                    },
                  ],
                  thinkingLevel,
                  context: `${progressLabel}: image`,
                });
                if (
                  isEmptyStreamText(imageText) &&
                  shouldSkipEmptyResponseForLiveModel({
                    provider: model.provider,
                    allowNotFoundSkip: params.allowNotFoundSkip,
                  })
                ) {
                  logProgress(`${progressLabel}: image skip (${model.provider} empty response)`);
                } else {
                  assertNoReasoningTags({
                    text: imageText,
                    model: modelKey,
                    phase: "image",
                    label: params.label,
                  });
                  if (!/\bcat\b/i.test(imageText)) {
                    logProgress(`${progressLabel}: image skip (missing 'cat')`);
                  } else {
                    const candidates = imageText.toUpperCase().match(/[A-Z0-9]{6,20}/g) ?? [];
                    const bestDistance = candidates.reduce((best, cand) => {
                      if (Math.abs(cand.length - imageCode.length) > 2) {
                        return best;
                      }
                      return Math.min(best, editDistance(cand, imageCode));
                    }, Number.POSITIVE_INFINITY);
                    if (!(bestDistance <= 3)) {
                      logProgress(`${progressLabel}: image skip (code mismatch)`);
                    }
                  }
                }
              }

              if (
                (model.provider === "openai" && model.api === "openai-responses") ||
                (model.provider === "openai" && model.api === "openai-chatgpt-responses")
              ) {
                logProgress(`${progressLabel}: tool-only regression`);
                const runId2 = randomUUID();
                const firstText = await requestGatewayAgentText({
                  client,
                  sessionKey,
                  idempotencyKey: `idem-${runId2}-1`,
                  modelKey,
                  message: `Call the tool named \`read\` (or \`Read\`) on "${toolProbePath}". Do not write any other text.`,
                  thinkingLevel,
                  context: `${progressLabel}: tool-only-regression-first`,
                  assistantText: "optional",
                });
                assertNoReasoningTags({
                  text: firstText,
                  model: modelKey,
                  phase: "tool-only",
                  label: params.label,
                });

                const reply = await requestGatewayAgentText({
                  client,
                  sessionKey,
                  idempotencyKey: `idem-${runId2}-2`,
                  modelKey,
                  message: `Now answer: what are the values of nonceA and nonceB in "${toolProbePath}"? Reply with exactly: ${nonceA} ${nonceB}.`,
                  thinkingLevel,
                  context: `${progressLabel}: tool-only-regression-second`,
                });
                assertNoReasoningTags({
                  text: reply,
                  model: modelKey,
                  phase: "tool-only-followup",
                  label: params.label,
                });
                if (!reply.includes(nonceA) || !reply.includes(nonceB)) {
                  throw new Error(`unexpected reply: ${reply}`);
                }
              }

              if (model.provider === "anthropic") {
                await runAnthropicRefusalProbe({
                  client,
                  sessionKey,
                  modelKey,
                  label: progressLabel,
                  thinkingLevel,
                });
              }
              return "done";
            })(),
            `${progressLabel}: model`,
          );
          if (modelResult === "skip") {
            skippedCount += 1;
            break;
          }
          passedCount += 1;
          logProgress(`${progressLabel}: done`);
          break;
        } catch (err) {
          const message = String(err);
          if (
            model.provider === "anthropic" &&
            isLiveRateLimitDrift(message) &&
            attempt + 1 < attemptMax
          ) {
            logProgress(`${progressLabel}: rate limit, retrying with next key`);
            continue;
          }
          if (model.provider === "anthropic" && isLiveRateLimitDrift(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (anthropic rate limit)`);
            break;
          }
          if (model.provider === "anthropic" && isLiveBillingDrift(message)) {
            if (attempt + 1 < attemptMax) {
              logProgress(`${progressLabel}: billing issue, retrying with next key`);
              continue;
            }
            logProgress(`${progressLabel}: skip (anthropic billing)`);
            break;
          }
          if (
            model.provider === "anthropic" &&
            isEmptyStreamText(message) &&
            attempt + 1 < attemptMax
          ) {
            logProgress(`${progressLabel}: empty response, retrying with next key`);
            continue;
          }
          if (model.provider === "anthropic" && isEmptyStreamText(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (anthropic empty response)`);
            break;
          }
          if (model.provider === "anthropic" && isAnthropicModelUnavailableDrift(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (anthropic model unavailable)`);
            break;
          }
          if (
            isEmptyStreamText(message) &&
            shouldSkipEmptyResponseForLiveModel({
              provider: model.provider,
              allowNotFoundSkip: params.allowNotFoundSkip,
            })
          ) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (${model.provider} empty response)`);
            break;
          }
          if (isGoogleishProvider(model.provider) && isLiveRateLimitDrift(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (google rate limit)`);
            break;
          }
          const driftSkip = shouldSkipLiveProviderDrift({
            error: message,
            allowAuth: true,
            allowBilling: true,
            allowProviderUnavailable: true,
          });
          if (driftSkip) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (${driftSkip.label})`);
            break;
          }
          if (
            (model.provider === "minimax" ||
              model.provider === "opencode" ||
              model.provider === "opencode-go" ||
              model.provider === "zai") &&
            isLiveRateLimitDrift(message)
          ) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (rate limit)`);
            break;
          }
          if (isAudioOnlyModelErrorMessage(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (audio-only model)`);
            break;
          }
          if (isUnsupportedReasoningEffortErrorMessage(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (reasoning unsupported)`);
            break;
          }
          if (isUnsupportedThinkingToggleErrorMessage(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (thinking toggle unsupported)`);
            break;
          }
          if (model.provider === "openrouter" && isPromptProbeMiss(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (openrouter prompt probe miss)`);
            break;
          }
          if (params.allowNotFoundSkip && isModelNotFoundErrorMessage(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (model not found)`);
            break;
          }
          if (
            model.provider === "anthropic" &&
            isGatewayLiveProbeTimeout(message) &&
            attempt + 1 < attemptMax
          ) {
            logProgress(`${progressLabel}: probe timeout, retrying with next key`);
            continue;
          }
          if (isGatewayLiveProbeTimeout(message)) {
            skippedCount += 1;
            timeoutSkippedCount += 1;
            logProgress(`${progressLabel}: skip (probe timeout)`);
            break;
          }
          if (isGatewayLiveModelTimeout(message)) {
            skippedCount += 1;
            timeoutSkippedCount += 1;
            logProgress(`${progressLabel}: skip (model timeout)`);
            break;
          }
          // OpenAI Codex refresh tokens can become single-use; skip instead of failing all live tests.
          if (model.provider === "openai" && isRefreshTokenReused(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (codex refresh token reused)`);
            break;
          }
          if (model.provider === "openai" && isAccountIdExtractionError(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (codex account id extraction)`);
            break;
          }
          if (model.provider === "openai" && isChatGPTUsageLimitErrorMessage(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (chatgpt usage limit)`);
            break;
          }
          if (model.provider === "openai" && isInstructionsRequiredError(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (instructions required)`);
            break;
          }
          if (model.provider === "openai" && isOpenAIReasoningSequenceError(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (openai reasoning sequence error)`);
            break;
          }
          if (model.provider === "openai" && isToolNonceRefusal(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (tool probe refusal)`);
            break;
          }
          if (
            isExecReadNonceProbeMiss(message) &&
            shouldSkipExecReadNonceMissForLiveModel(modelKey)
          ) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (exec/read workspace isolation)`);
            break;
          }
          if (shouldSkipToolNonceProbeMissForLiveModel(modelKey) && isToolNonceProbeMiss(message)) {
            skippedCount += 1;
            const probe = isExecReadNonceProbeMiss(message) ? "exec/read" : "tool-read";
            logProgress(`${progressLabel}: skip (${modelKey} ${probe} nonce miss)`);
            break;
          }
          if (isMissingProfileError(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (missing auth profile)`);
            break;
          }
          if (model.provider === "ollama" && isOllamaUnavailableErrorMessage(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (ollama unavailable)`);
            break;
          }
          if (params.label.startsWith("minimax-")) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (minimax endpoint error)`);
            break;
          }
          logProgress(`${progressLabel}: failed`);
          failures.push({ model: modelKey, error: message });
          break;
        }
      }
    }

    if (failures.length > 0) {
      const preview = formatFailurePreview(failures, 20);
      throw new Error(
        `gateway live model failures (${failures.length}, showing ${Math.min(failures.length, 20)}):\n${preview}`,
      );
    }
    assertGatewayLiveCompletedSomeModels({
      label: params.label,
      passedCount,
      skippedCount,
      timeoutSkippedCount,
      total,
    });
  } finally {
    clearRuntimeConfigSnapshot();
    restoreProductionEnvForLiveRun(runtimeEnv);
    client?.stop();
    if (server) {
      await server.close({ reason: "live test complete" });
    }
    await fs.rm(toolProbePath, { force: true });
    // Give the filesystem a short retry window while agent/runtime teardown
    // releases handles inside these temporary live-test directories.
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (tempAgentDir) {
      await fs.rm(tempAgentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }

    restoreOptionalEnv("OPENCLAW_CONFIG_PATH", previous.configPath);
    restoreOptionalEnv("OPENCLAW_GATEWAY_TOKEN", previous.token);
    restoreOptionalEnv("OPENCLAW_SKIP_CHANNELS", previous.skipChannels);
    restoreOptionalEnv("OPENCLAW_SKIP_GMAIL_WATCHER", previous.skipGmail);
    restoreOptionalEnv("OPENCLAW_SKIP_CRON", previous.skipCron);
    restoreOptionalEnv("OPENCLAW_SKIP_CANVAS_HOST", previous.skipCanvas);
    restoreOptionalEnv("OPENCLAW_DISABLE_BONJOUR", previous.disableBonjour);
    restoreOptionalEnv("OPENCLAW_LOG_LEVEL", previous.logLevel);
    restoreOptionalEnv("OPENCLAW_AGENT_DIR", previous.agentDir);
    restoreOptionalEnv("OPENCLAW_STATE_DIR", previous.stateDir);
  }
}

describeLive("gateway live (dev agent, profile keys)", () => {
  it(
    "runs meaningful prompts across models with available keys",
    async () =>
      await withSuppressedGatewayLiveWarnings(async () => {
        const providerList = providerFilterList();
        const providerLog = providerList?.join(",") ?? "all";
        logProgress(`[all-models] discover candidates providers=${providerLog}`);
        logProgress("[all-models] loading config");
        clearRuntimeConfigSnapshot();
        const cfg = await withGatewayLiveSetupTimeout(
          Promise.resolve().then(() => getRuntimeConfig()),
          "[all-models] load config",
        );
        const workspaceDir = resolveAgentWorkspaceDir(cfg, DEFAULT_AGENT_ID);
        logProgress("[all-models] preparing models.json");
        const modelsJsonResult = await withGatewayLiveSetupTimeout(
          ensureOpenClawModelsJson(cfg, undefined, {
            workspaceDir,
            ...(providerList ? { providerDiscoveryProviderIds: providerList } : {}),
          }),
          "[all-models] prepare models.json",
        );
        const agentDir = modelsJsonResult.agentDir;

        const rawModels = process.env.OPENCLAW_LIVE_GATEWAY_MODELS?.trim();
        const useModern = !rawModels || rawModels === "modern" || rawModels === "all";
        const useSmall = rawModels === "small";
        const useExplicit = Boolean(rawModels) && !useModern && !useSmall;
        const filter = useExplicit ? parseFilter(rawModels) : null;
        const providerScopedModelProviders = providerScopedModelRegistryProviders({
          providerList,
          useSmall,
          useExplicit,
          modelFilter: filter,
          providerFilter: PROVIDERS,
        });
        let authProfileStore: AuthProfileStore | undefined;
        let modelRegistry: LiveModelRegistry;
        let all: Array<Model>;
        if (providerScopedModelProviders) {
          logProgress("[all-models] loading provider-scoped model refs");
          all = await withGatewayLiveSetupTimeout(
            loadProviderScopedModels({ agentDir, providerList: providerScopedModelProviders }),
            "[all-models] load provider-scoped model refs",
          );
          if (all.length > 0) {
            modelRegistry = createStaticLiveModelRegistry(all);
          } else {
            logProgress("[all-models] provider-scoped model refs empty; loading auth profiles");
            const authBacked = await loadAuthBackedLiveModelRegistry({
              agentDir,
              cfg,
              providerList: providerScopedModelProviders,
            });
            authProfileStore = authBacked.authProfileStore;
            modelRegistry = authBacked.modelRegistry;
            all = authBacked.all;
          }
        } else {
          logProgress("[all-models] loading auth profiles");
          const authBacked = await loadAuthBackedLiveModelRegistry({ agentDir, cfg, providerList });
          authProfileStore = authBacked.authProfileStore;
          modelRegistry = authBacked.modelRegistry;
          all = authBacked.all;
        }
        if (useSmall) {
          const augmented = await withGatewayLiveSetupTimeout(
            appendPrioritizedDynamicLiveModels({
              models: all,
              config: cfg,
              agentDir,
              workspaceDir,
              env: process.env,
              modelRegistry,
              refs: filterGatewayLiveModelRefsByProvider(
                listPrioritizedSmallLiveModelRefs(),
                PROVIDERS,
              ),
            }),
            "[all-models] load dynamic small model refs",
          );
          if (augmented.added.length > 0) {
            logProgress(
              `[all-models] loaded ${augmented.added.length} prioritized dynamic small model refs`,
            );
            all = augmented.models;
            modelRegistry = createStaticLiveModelRegistry(all);
          }
        }
        const maxModels = GATEWAY_LIVE_MAX_MODELS;
        const targetMatcher = createLiveTargetMatcher({
          providerFilter: PROVIDERS,
          modelFilter: filter,
          config: cfg,
          env: process.env,
        });
        let wanted = useExplicit
          ? resolveExplicitLiveModelCandidates({
              modelRegistry,
              modelFilter: filter,
              providerFilter: PROVIDERS,
              targetMatcher,
            })
          : null;
        if (!wanted) {
          wanted = filter
            ? all.filter((m) => targetMatcher.matchesModel(m.provider, m.id))
            : useSmall
              ? all.filter((m) => isWantedSmallGatewayLiveModel({ model: m, targetMatcher }))
              : all.filter(
                  (m) =>
                    !shouldExcludeProviderFromDefaultHighSignalLiveSweep({
                      provider: m.provider,
                      useExplicitModels: useExplicit,
                      providerFilter: PROVIDERS,
                      config: cfg,
                      env: process.env,
                    }) && isHighSignalLiveModelRef({ provider: m.provider, id: m.id }),
                );
        }
        logProgress(`[all-models] wanted=${wanted.length} total=${all.length}`);
        assertGatewayLiveSelectedSomeModels({
          allowProviderDriftSkip: useModern || useSmall,
          label: "all-models",
          modelFilter: filter,
          providerFilter: PROVIDERS,
          total: all.length,
          useSmall,
          useExplicit,
          wantedCount: wanted.length,
        });

        const candidates: Array<Model> = [];
        const skipped: Array<{ model: string; error: string }> = [];
        for (const model of wanted) {
          if (shouldSuppressBuiltInModel({ provider: model.provider, id: model.id })) {
            continue;
          }
          if (!targetMatcher.matchesProvider(model.provider)) {
            continue;
          }
          const modelRef = `${model.provider}/${model.id}`;
          try {
            const apiKeyInfo = await withGatewayLiveSetupTimeout(
              getApiKeyForModel({
                model,
                cfg,
                store: authProfileStore,
                agentDir,
                workspaceDir,
                credentialPrecedence: LIVE_CREDENTIAL_PRECEDENCE,
              }),
              `[all-models] auth ${modelRef}`,
              GATEWAY_LIVE_PROBE_TIMEOUT_MS,
            );
            if (REQUIRE_PROFILE_KEYS && !apiKeyInfo.source.startsWith("profile:")) {
              skipped.push({
                model: modelRef,
                error: `non-profile credential source: ${apiKeyInfo.source}`,
              });
              continue;
            }
            candidates.push(model);
          } catch (error) {
            skipped.push({ model: modelRef, error: String(error) });
          }
        }
        logProgress(`[all-models] candidates=${candidates.length} skipped=${skipped.length}`);

        if (candidates.length === 0) {
          if (skipped.length > 0) {
            logProgress(
              `[all-models] auth lookup skipped candidates:\n${formatFailurePreview(skipped, 8)}`,
            );
          }
        }
        assertGatewayLiveHasRunnableCandidates({
          candidatesCount: candidates.length,
          label: "all-models",
          skipped,
        });
        const selectCandidates = useSmall ? selectSmallLiveItems : selectHighSignalLiveItems;
        const selectedCandidates = selectCandidates(
          candidates,
          maxModels > 0 ? maxModels : candidates.length,
          (model) => ({ provider: model.provider, id: model.id }),
          (model) => model.provider,
        );
        logProgress(
          `[all-models] selection=${useExplicit ? "explicit" : useSmall ? "small" : "high-signal"}`,
        );
        if (selectedCandidates.length < candidates.length) {
          logProgress(
            `[all-models] capped to ${selectedCandidates.length}/${candidates.length} via OPENCLAW_LIVE_GATEWAY_MAX_MODELS=${maxModels}`,
          );
        }
        expect(selectedCandidates.length).toBeGreaterThan(0);
        const imageCandidates = selectedCandidates.filter((m) => m.input?.includes("image"));
        if (imageCandidates.length === 0) {
          logProgress("[all-models] no image-capable models selected; image probe will be skipped");
        }
        await runGatewayModelSuite({
          label: "all-models",
          cfg,
          candidates: selectedCandidates,
          allowNotFoundSkip: useModern || useSmall,
          extraToolProbes: ENABLE_EXTRA_TOOL_PROBES,
          extraImageProbes: ENABLE_EXTRA_IMAGE_PROBES,
          thinkingLevel: THINKING_LEVEL,
        });

        const minimaxCandidates = selectedCandidates.filter(
          (model) => model.provider === "minimax",
        );
        if (minimaxCandidates.length === 0) {
          logProgress("[minimax] no candidates with keys; skipping dual endpoint probes");
          return;
        }

        const minimaxAnthropic = buildMinimaxProviderOverride({
          cfg,
          api: "anthropic-messages",
          baseUrl: "https://api.minimax.io/anthropic",
        });
        if (minimaxAnthropic) {
          await runGatewayModelSuite({
            label: "minimax-anthropic",
            cfg,
            candidates: minimaxCandidates,
            allowNotFoundSkip: useModern,
            extraToolProbes: ENABLE_EXTRA_TOOL_PROBES,
            extraImageProbes: ENABLE_EXTRA_IMAGE_PROBES,
            thinkingLevel: THINKING_LEVEL,
            providerOverrides: { minimax: minimaxAnthropic },
          });
        } else {
          logProgress("[minimax-anthropic] missing minimax provider config; skipping");
        }
      }),
    GATEWAY_LIVE_SUITE_TIMEOUT_MS,
  );

  it("z.ai fallback handles anthropic tool history", async () => {
    if (!ZAI_FALLBACK) {
      return;
    }
    clearRuntimeConfigSnapshot();
    const runtimeEnv = enterProductionEnvForLiveRun();
    const previous = {
      configPath: process.env.OPENCLAW_CONFIG_PATH,
      token: process.env.OPENCLAW_GATEWAY_TOKEN,
      skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
      skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
      skipCron: process.env.OPENCLAW_SKIP_CRON,
      skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
      agentDir: process.env.OPENCLAW_AGENT_DIR,
      stateDir: process.env.OPENCLAW_STATE_DIR,
    };

    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
    process.env.OPENCLAW_SKIP_CRON = "1";
    process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";

    const token = `test-${randomUUID()}`;
    process.env.OPENCLAW_GATEWAY_TOKEN = token;

    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    let client: GatewayClient | undefined;
    let toolProbePath: string | undefined;
    let tempDir: string | undefined;
    let tempStateDir: string | undefined;
    try {
      const cfg = getRuntimeConfig();
      await ensureOpenClawModelsJson(cfg);

      const agentDir = resolveDefaultAgentDir(cfg);
      const hostStore = ensureAuthProfileStore(agentDir, {
        allowKeychainPrompt: false,
      });
      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir);
      const anthropic = modelRegistry.find("anthropic", "claude-opus-4-6") as Model | null;
      const zai = modelRegistry.find("zai", "glm-5.1") as Model | null;

      if (!anthropic || !zai) {
        return;
      }
      try {
        await getApiKeyForModel({
          model: anthropic,
          cfg,
          credentialPrecedence: LIVE_CREDENTIAL_PRECEDENCE,
        });
        await getApiKeyForModel({
          model: zai,
          cfg,
          credentialPrecedence: LIVE_CREDENTIAL_PRECEDENCE,
        });
      } catch {
        return;
      }

      const agentId = GATEWAY_LIVE_AGENT_ID;
      tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-zai-state-"));
      setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
      const workspaceDir = path.join(tempStateDir, "workspace-dev");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(path.join(workspaceDir, ".openclaw"), { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, ".openclaw", "workspace-state.json"),
        `${JSON.stringify(
          {
            version: 1,
            setupCompletedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
      );
      const nonceA = randomUUID();
      const nonceB = randomUUID();
      toolProbePath = path.join(workspaceDir, `.openclaw-live-zai-fallback.${nonceA}.txt`);
      await fs.writeFile(toolProbePath, `nonceA=${nonceA}\nnonceB=${nonceB}\n`);

      const sanitizedStore = sanitizeAuthProfileStoreForLiveGateway({
        version: hostStore.version,
        profiles: { ...hostStore.profiles },
        order: hostStore.order ? { ...hostStore.order } : undefined,
        lastGood: hostStore.lastGood ? { ...hostStore.lastGood } : undefined,
        usageStats: hostStore.usageStats ? { ...hostStore.usageStats } : undefined,
      });
      const tempAgentDir = path.join(tempStateDir, "agents", agentId, "agent");
      saveAuthProfileStore(sanitizedStore, tempAgentDir);
      setTestEnvValue("OPENCLAW_AGENT_DIR", tempAgentDir);

      const sanitizedCfg: OpenClawConfig = {
        ...cfg,
        auth: await sanitizeAuthConfig({ cfg, agentDir }),
      };
      const nextCfg = buildLiveGatewayConfig({
        cfg: sanitizedCfg,
        candidates: [anthropic, zai],
        liveAgentDir: tempAgentDir,
        liveAgentWorkspaceDir: workspaceDir,
      });
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-zai-"));
      const tempConfigPath = path.join(tempDir, "openclaw.json");
      await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", tempConfigPath);
      clearRuntimeConfigSnapshot();

      const liveProviders = nextCfg.models?.providers;
      if (liveProviders && Object.keys(liveProviders).length > 0) {
        await fs.mkdir(tempAgentDir, { recursive: true });
        await fs.writeFile(
          path.join(tempAgentDir, "models.json"),
          `${JSON.stringify({ providers: liveProviders }, null, 2)}\n`,
        );
      }

      try {
        const port = await withGatewayLiveProbeTimeout(
          getFreeGatewayPort(),
          "zai-fallback: gateway-port",
        );
        server = await withGatewayLiveProbeTimeout(
          startGatewayServer(port, {
            bind: "loopback",
            auth: { mode: "token", token },
            controlUiEnabled: false,
          }),
          "zai-fallback: gateway-start",
        );

        client = await withGatewayLiveProbeTimeout(
          connectClient({
            url: `ws://127.0.0.1:${port}`,
            token,
          }),
          "zai-fallback: gateway-connect",
        );
      } catch (error) {
        const message = String(error);
        if (isGatewayLiveProbeTimeout(message)) {
          failGatewayLiveStartupCoverage({ label: "zai-fallback", reason: message });
        }
        throw error;
      }

      if (!server || !client) {
        failGatewayLiveStartupCoverage({
          label: "zai-fallback",
          reason: "gateway server/client did not initialize",
        });
      }

      const sessionKey = `agent:${agentId}:live-zai-fallback`;

      await withGatewayLiveSessionControlTimeout(
        client.request("sessions.patch", {
          key: sessionKey,
          model: "anthropic/claude-opus-4-6",
        }),
        "zai-fallback: sessions-patch-anthropic",
      );
      await withGatewayLiveSessionControlTimeout(
        client.request("sessions.reset", {
          key: sessionKey,
        }),
        "zai-fallback: sessions-reset",
      );

      const toolText = await requestGatewayAgentText({
        client,
        sessionKey,
        idempotencyKey: `idem-${randomUUID()}-tool`,
        modelKey: "anthropic/claude-opus-4-6",
        message:
          `Call the tool named \`read\` (or \`Read\` if \`read\` is unavailable) with JSON arguments {"path":"${toolProbePath}"}. ` +
          `Then reply with exactly: ${nonceA} ${nonceB}. No extra text.`,
        thinkingLevel: THINKING_LEVEL,
        context: "zai-fallback: tool-probe",
      });
      assertNoReasoningTags({
        text: toolText,
        model: "anthropic/claude-opus-4-6",
        phase: "zai-fallback-tool",
        label: "zai-fallback",
      });
      if (!toolText.includes(nonceA) || !toolText.includes(nonceB)) {
        throw new Error(`anthropic tool probe missing nonce: ${toolText}`);
      }

      await withGatewayLiveSessionControlTimeout(
        client.request("sessions.patch", {
          key: sessionKey,
          model: "zai/glm-5.1",
        }),
        "zai-fallback: sessions-patch-zai",
      );

      const followupText = await requestGatewayAgentText({
        client,
        sessionKey,
        idempotencyKey: `idem-${randomUUID()}-followup`,
        modelKey: "zai/glm-5.1",
        message:
          `What are the values of nonceA and nonceB in "${toolProbePath}"? ` +
          `Reply with exactly: ${nonceA} ${nonceB}.`,
        thinkingLevel: THINKING_LEVEL,
        context: "zai-fallback: followup",
      });
      assertNoReasoningTags({
        text: followupText,
        model: "zai/glm-5.1",
        phase: "zai-fallback-followup",
        label: "zai-fallback",
      });
      if (!followupText.includes(nonceA) || !followupText.includes(nonceB)) {
        throw new Error(`zai followup missing nonce: ${followupText}`);
      }
    } finally {
      clearRuntimeConfigSnapshot();
      restoreProductionEnvForLiveRun(runtimeEnv);
      client?.stop();
      if (server) {
        await server.close({ reason: "live test complete" });
      }
      if (toolProbePath) {
        await fs.rm(toolProbePath, { force: true });
      }
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
      if (tempStateDir) {
        await fs.rm(tempStateDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        });
      }

      restoreOptionalEnv("OPENCLAW_CONFIG_PATH", previous.configPath);
      restoreOptionalEnv("OPENCLAW_GATEWAY_TOKEN", previous.token);
      restoreOptionalEnv("OPENCLAW_SKIP_CHANNELS", previous.skipChannels);
      restoreOptionalEnv("OPENCLAW_SKIP_GMAIL_WATCHER", previous.skipGmail);
      restoreOptionalEnv("OPENCLAW_SKIP_CRON", previous.skipCron);
      restoreOptionalEnv("OPENCLAW_SKIP_CANVAS_HOST", previous.skipCanvas);
      restoreOptionalEnv("OPENCLAW_AGENT_DIR", previous.agentDir);
      restoreOptionalEnv("OPENCLAW_STATE_DIR", previous.stateDir);
    }
  }, 180_000);
});
