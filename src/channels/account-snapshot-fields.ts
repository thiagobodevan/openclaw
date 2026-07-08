/**
 * Status-safe channel account projection helpers for CLI, status APIs, and plugin SDK callers.
 * This file is the redaction boundary between runtime account objects and public snapshots.
 */
import { stripUrlUserInfo } from "@openclaw/net-policy/url-userinfo";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { isRecord } from "../utils.js";
import { asBoolean } from "../utils/boolean.js";
import type { ChannelAccountStatus } from "./plugins/types.core.js";

const CREDENTIAL_STATUS_KEYS = [
  "tokenStatus",
  "botTokenStatus",
  "appTokenStatus",
  "signingSecretStatus",
  "userTokenStatus",
] as const;

type CredentialStatusKey = (typeof CREDENTIAL_STATUS_KEYS)[number];

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  return asBoolean(record[key]);
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return asFiniteNumber(value);
}

function readNullableNumber(
  record: Record<string, unknown>,
  key: string,
): number | null | undefined {
  if (record[key] === null) {
    return null;
  }
  return readNumber(record, key);
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = normalizeStringEntries(
    value.map((entry) => (typeof entry === "string" || typeof entry === "number" ? entry : "")),
  );
  return normalized.length > 0 ? normalized : undefined;
}

function readLastDisconnect(
  record: Record<string, unknown>,
): ChannelAccountStatus["lastDisconnect"] | undefined {
  const value = record.lastDisconnect;
  if (value === null || typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const at = readNumber(value, "at");
  if (at === undefined) {
    return undefined;
  }
  const status = readNumber(value, "status");
  const error = normalizeOptionalString(value.error);
  const loggedOut = readBoolean(value, "loggedOut");
  return {
    at,
    ...(status !== undefined ? { status } : {}),
    ...(error ? { error } : {}),
    ...(loggedOut !== undefined ? { loggedOut } : {}),
  };
}

function readCredentialStatus(record: Record<string, unknown>, key: CredentialStatusKey) {
  const value = record[key];
  return value === "available" || value === "configured_unavailable" || value === "missing"
    ? value
    : undefined;
}

function setSnapshotField<Key extends keyof ChannelAccountStatus>(
  snapshot: Partial<ChannelAccountStatus>,
  key: Key,
  value: ChannelAccountStatus[Key] | undefined,
) {
  if (value !== undefined) {
    Object.assign(snapshot, { [key]: value });
  }
}

/**
 * Infers whether any known credential status makes an account configured.
 *
 * Status commands need this metadata for "configured but unavailable" accounts without reading
 * raw credentials from runtime-only helpers.
 */
export function resolveConfiguredFromCredentialStatuses(account: unknown): boolean | undefined {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return undefined;
  }
  let sawCredentialStatus = false;
  for (const key of CREDENTIAL_STATUS_KEYS) {
    const status = readCredentialStatus(record, key);
    if (!status) {
      continue;
    }
    sawCredentialStatus = true;
    if (status !== "missing") {
      return true;
    }
  }
  return sawCredentialStatus ? false : undefined;
}

/** Infers configured state only from the credential status keys required by a channel. */
export function resolveConfiguredFromRequiredCredentialStatuses(
  account: unknown,
  requiredKeys: CredentialStatusKey[],
): boolean | undefined {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return undefined;
  }
  let sawCredentialStatus = false;
  for (const key of requiredKeys) {
    const status = readCredentialStatus(record, key);
    if (!status) {
      continue;
    }
    sawCredentialStatus = true;
    if (status === "missing") {
      return false;
    }
  }
  return sawCredentialStatus ? true : undefined;
}

/** Returns true when a credential exists but cannot be resolved at status-render time. */
export function hasConfiguredUnavailableCredentialStatus(account: unknown): boolean {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return false;
  }
  return CREDENTIAL_STATUS_KEYS.some(
    (key) => readCredentialStatus(record, key) === "configured_unavailable",
  );
}

/** Returns true when account data contains a resolved credential value or available status. */
export function hasResolvedCredentialValue(account: unknown): boolean {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return false;
  }
  return (
    ["token", "botToken", "appToken", "signingSecret", "userToken"].some((key) => {
      return normalizeOptionalString(record[key]) !== undefined;
    }) || CREDENTIAL_STATUS_KEYS.some((key) => readCredentialStatus(record, key) === "available")
  );
}

/** Projects credential source/status metadata while omitting raw credential values. */
export function projectCredentialSnapshotFields(
  account: unknown,
): Pick<
  Partial<ChannelAccountStatus>,
  | "tokenSource"
  | "botTokenSource"
  | "appTokenSource"
  | "signingSecretSource"
  | "tokenStatus"
  | "botTokenStatus"
  | "appTokenStatus"
  | "signingSecretStatus"
  | "userTokenStatus"
> {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return {};
  }
  const tokenSource = normalizeOptionalString(record.tokenSource);
  const botTokenSource = normalizeOptionalString(record.botTokenSource);
  const appTokenSource = normalizeOptionalString(record.appTokenSource);
  const signingSecretSource = normalizeOptionalString(record.signingSecretSource);

  // Only project source/status fields. Token-like values stay out of account snapshots even when
  // callers pass full runtime account objects.
  return {
    ...(tokenSource ? { tokenSource } : {}),
    ...(botTokenSource ? { botTokenSource } : {}),
    ...(appTokenSource ? { appTokenSource } : {}),
    ...(signingSecretSource ? { signingSecretSource } : {}),
    ...(readCredentialStatus(record, "tokenStatus")
      ? { tokenStatus: readCredentialStatus(record, "tokenStatus") }
      : {}),
    ...(readCredentialStatus(record, "botTokenStatus")
      ? { botTokenStatus: readCredentialStatus(record, "botTokenStatus") }
      : {}),
    ...(readCredentialStatus(record, "appTokenStatus")
      ? { appTokenStatus: readCredentialStatus(record, "appTokenStatus") }
      : {}),
    ...(readCredentialStatus(record, "signingSecretStatus")
      ? { signingSecretStatus: readCredentialStatus(record, "signingSecretStatus") }
      : {}),
    ...(readCredentialStatus(record, "userTokenStatus")
      ? { userTokenStatus: readCredentialStatus(record, "userTokenStatus") }
      : {}),
  };
}

/**
 * Projects status-safe account fields for read-only channel/account snapshots.
 *
 * This is the boundary between runtime account objects and status renderers; keep it explicit so
 * new channel fields do not accidentally expose webhook URLs or raw credentials.
 */
export function projectSafeChannelAccountSnapshotFields(
  account: unknown,
): Partial<ChannelAccountStatus> {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return {};
  }
  const snapshot = projectCredentialSnapshotFields(account);
  setSnapshotField(snapshot, "name", normalizeOptionalString(record.name));
  setSnapshotField(snapshot, "enabled", readBoolean(record, "enabled"));
  setSnapshotField(snapshot, "configured", readBoolean(record, "configured"));
  setSnapshotField(snapshot, "linked", readBoolean(record, "linked"));
  setSnapshotField(snapshot, "running", readBoolean(record, "running"));
  setSnapshotField(snapshot, "connected", readBoolean(record, "connected"));
  setSnapshotField(snapshot, "restartPending", readBoolean(record, "restartPending"));
  setSnapshotField(snapshot, "reconnectAttempts", readNumber(record, "reconnectAttempts"));
  setSnapshotField(snapshot, "lastConnectedAt", readNullableNumber(record, "lastConnectedAt"));
  setSnapshotField(snapshot, "lastDisconnect", readLastDisconnect(record));
  for (const key of [
    "lastInboundAt",
    "lastOutboundAt",
    "lastMessageAt",
    "lastEventAt",
    "lastTransportActivityAt",
    "lastStartAt",
    "lastStopAt",
    "lastRunActivityAt",
    "lastProbeAt",
  ] as const) {
    setSnapshotField(snapshot, key, readNullableNumber(record, key));
  }
  setSnapshotField(
    snapshot,
    "lastError",
    record.lastError === null ? null : normalizeOptionalString(record.lastError),
  );
  setSnapshotField(snapshot, "statusState", normalizeOptionalString(record.statusState));
  setSnapshotField(snapshot, "healthState", normalizeOptionalString(record.healthState));
  setSnapshotField(snapshot, "terminalDisconnect", readBoolean(record, "terminalDisconnect"));
  setSnapshotField(snapshot, "busy", readBoolean(record, "busy"));
  setSnapshotField(snapshot, "activeRuns", readNumber(record, "activeRuns"));
  setSnapshotField(snapshot, "mode", normalizeOptionalString(record.mode));
  setSnapshotField(snapshot, "dmPolicy", normalizeOptionalString(record.dmPolicy));
  setSnapshotField(snapshot, "allowFrom", readStringArray(record, "allowFrom"));
  for (const key of ["credentialSource", "secretSource", "audienceType", "audience"] as const) {
    setSnapshotField(snapshot, key, normalizeOptionalString(record[key]));
  }
  const baseUrl = normalizeOptionalString(record.baseUrl);
  // Base URLs are useful diagnostics, but embedded userinfo would expose credentials.
  setSnapshotField(snapshot, "baseUrl", baseUrl ? stripUrlUserInfo(baseUrl) : undefined);
  setSnapshotField(
    snapshot,
    "allowUnmentionedGroups",
    readBoolean(record, "allowUnmentionedGroups"),
  );
  setSnapshotField(snapshot, "cliPath", normalizeOptionalString(record.cliPath));
  setSnapshotField(snapshot, "dbPath", normalizeOptionalString(record.dbPath));
  setSnapshotField(snapshot, "port", readNullableNumber(record, "port"));
  setSnapshotField(snapshot, "application", record.application);
  setSnapshotField(snapshot, "bot", record.bot);
  setSnapshotField(
    snapshot,
    "publicKey",
    record.publicKey === null ? null : normalizeOptionalString(record.publicKey),
  );
  setSnapshotField(snapshot, "profile", record.profile);
  return snapshot;
}
