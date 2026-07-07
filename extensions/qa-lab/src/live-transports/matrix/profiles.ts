export const MATRIX_QA_RELEASE_SCENARIO_IDS = [
  "channel-chat-baseline",
  "matrix-allowlist-hot-reload",
] as const;

export const MATRIX_QA_PORTABLE_SCENARIO_IDS = [
  "channel-mention-gating",
  "channel-sender-allowlist",
  "channel-multi-actor-ordering",
  "channel-secondary-conversation-isolation",
  "channel-top-level-reply-shape",
  "dm-chat-baseline",
  "dm-per-room-session",
  "dm-shared-session",
  "matrix-dm-thread-reply-override",
  "thread-follow-up",
  "matrix-thread-root-preservation",
  "matrix-thread-nested-reply-shape",
  "thread-isolation",
  "thread-reply-override",
  "subagent-thread-spawn",
  "matrix-mxid-prefixed-command-block",
  "matrix-secondary-room-open-trigger",
  "matrix-room-partial-streaming-preview",
  "matrix-room-quiet-streaming-preview",
  "matrix-room-image-understanding-attachment",
  "matrix-attachment-only-ignored",
  "matrix-unsupported-media-safe",
] as const;

export const MATRIX_QA_TRANSPORT_SCENARIO_IDS = [
  ...MATRIX_QA_RELEASE_SCENARIO_IDS,
  ...MATRIX_QA_PORTABLE_SCENARIO_IDS,
  "matrix-restart-resume",
  "matrix-restart-replay-dedupe",
  "matrix-post-restart-room-continue",
] as const;

export const MATRIX_QA_ALL_SCENARIO_IDS = MATRIX_QA_TRANSPORT_SCENARIO_IDS;

const MATRIX_QA_PROFILE_SCENARIO_IDS = {
  all: MATRIX_QA_TRANSPORT_SCENARIO_IDS,
  fast: MATRIX_QA_RELEASE_SCENARIO_IDS,
  release: MATRIX_QA_RELEASE_SCENARIO_IDS,
  transport: MATRIX_QA_TRANSPORT_SCENARIO_IDS,
} as const;

export type MatrixQaProfile = keyof typeof MATRIX_QA_PROFILE_SCENARIO_IDS;

export function resolveMatrixQaScenarioIds(params: {
  profile?: string;
  scenarioIds?: readonly string[];
}): string[] {
  if (params.scenarioIds && params.scenarioIds.length > 0) {
    return [...params.scenarioIds];
  }
  const profile = params.profile?.trim() || "all";
  if (!(profile in MATRIX_QA_PROFILE_SCENARIO_IDS)) {
    throw new Error(
      `Unknown QA Lab Matrix profile "${profile}". Expected one of: all, fast, release, transport.`,
    );
  }
  return [...MATRIX_QA_PROFILE_SCENARIO_IDS[profile as MatrixQaProfile]];
}
