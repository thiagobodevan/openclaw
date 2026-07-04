import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";

/** Deep-merge TTS config layers while treating undefined fields as absent overrides. */
export function mergeTtsConfigValues(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) {
    return override === undefined ? base : override;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isBlockedObjectKey(key) || value === undefined) {
      continue;
    }
    const existing = result[key];
    result[key] = key in result ? mergeTtsConfigValues(existing, value) : value;
  }
  return result;
}
