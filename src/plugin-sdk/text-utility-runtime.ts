// Focused low-level text/runtime helpers used by bundled plugins.

export {
  CONFIG_DIR,
  clamp,
  clampInt,
  clampNumber,
  displayPath,
  displayString,
  ensureDir,
  escapeRegExp,
  normalizeE164,
  resolveConfigDir,
  resolveHomeDir,
  resolveUserPath,
  safeParseJson,
  shortenHomeInString,
  shortenHomePath,
  sleep,
  sliceUtf16Safe,
  truncateUtf16Safe,
} from "../utils.js";
export { pathExists } from "../infra/fs-safe.js";
export { fetchWithTimeout } from "../utils/fetch-timeout.js";
export { withTimeout } from "../utils/with-timeout.js";
