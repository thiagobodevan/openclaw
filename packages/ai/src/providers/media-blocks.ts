import { isRecord } from "@openclaw/normalization-core/record-coerce";

/**
 * Single source of truth for the media content-block vocabulary shared by
 * provider conversion (tool-result-text.ts and the per-provider converters),
 * replay-time image sanitization (src/agents/tool-images.ts), and session
 * repair. Consumers must not grow their own structural definitions of what
 * counts as a media block — divergent local predicates are how payload-less
 * husks slipped between layers in the #98673 issue cluster.
 */

export const IMAGE_TOOL_RESULT_TYPES = new Set(["image", "image_url", "input_image"]);
export const AUDIO_TOOL_RESULT_TYPES = new Set(["audio", "input_audio", "output_audio"]);
export const MEDIA_ONLY_TOOL_RESULT_TYPES = new Set([
  ...IMAGE_TOOL_RESULT_TYPES,
  ...AUDIO_TOOL_RESULT_TYPES,
]);

export const MEDIA_MIME_KEY_CANDIDATES = [
  "mimeType",
  "mime_type",
  "mediaType",
  "media_type",
  "contentType",
  "content_type",
] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** First non-empty MIME-ish string among the known key spellings. */
export function readMediaMimeType(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of MEDIA_MIME_KEY_CANDIDATES) {
    const mimeType = value[key];
    if (typeof mimeType === "string" && mimeType.trim().length > 0) {
      return mimeType;
    }
  }
  return undefined;
}

/** Block labeled as a canonical image, regardless of payload validity. */
export function isImageLabeledBlock(
  block: unknown,
): block is Record<string, unknown> & { type: "image" } {
  return (
    Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "image"
  );
}

/**
 * Block matching the canonical `ImageContent` shape: `type: "image"` with
 * string `data` and `mimeType`. Payload validity (non-empty, well-formed
 * base64) is intentionally not checked here — sanitizers own that.
 */
export function isCanonicalImageBlock(
  block: unknown,
): block is Record<string, unknown> & { type: "image"; data: string; mimeType: string } {
  if (!isImageLabeledBlock(block)) {
    return false;
  }
  return typeof block.data === "string" && typeof block.mimeType === "string";
}

/**
 * True when a media-shaped block carries a payload in one of the canonical or
 * provider wire shapes:
 * - `data` — canonical inline base64 (ImageContent/audio blocks)
 * - `image_url` string, or `image_url.url` (OpenAI chat completions)
 * - `file_id` — file reference (OpenAI Responses)
 * - `source.data` / `source.url` (Anthropic)
 * - `input_audio.data` / `audio.data`, or string-valued `input_audio` /
 *   `audio` / `audio_url` (OpenAI-style audio)
 * - `url` — by-reference media
 *
 * This is deliberately broader than {@link hasInlineMediaData}: it decides
 * husk vs genuine media, not renderability. A genuine non-canonical block is
 * excluded from replay text (never stringified — nested payloads must not
 * leak) even though converters cannot inline it.
 */
export function hasMediaPayload(block: unknown): boolean {
  if (!isRecord(block)) {
    return false;
  }
  if (
    isNonEmptyString(block.data) ||
    isNonEmptyString(block.url) ||
    isNonEmptyString(block.file_id) ||
    isNonEmptyString(block.audio_url)
  ) {
    return true;
  }
  const imageUrl = block.image_url;
  if (isNonEmptyString(imageUrl) || (isRecord(imageUrl) && isNonEmptyString(imageUrl.url))) {
    return true;
  }
  const source = block.source;
  if (isRecord(source) && (isNonEmptyString(source.data) || isNonEmptyString(source.url))) {
    return true;
  }
  const inputAudio = block.input_audio;
  if (isNonEmptyString(inputAudio) || (isRecord(inputAudio) && isNonEmptyString(inputAudio.data))) {
    return true;
  }
  const audio = block.audio;
  if (isNonEmptyString(audio) || (isRecord(audio) && isNonEmptyString(audio.data))) {
    return true;
  }
  return false;
}

/**
 * True when a canonical media block carries inline base64 `data` that provider
 * converters can embed directly (Anthropic `source`, data-URI `image_url`,
 * Gemini `inlineData`). Converters must not emit a native media part from a
 * block that fails this check — an empty payload produces an invalid part the
 * provider API rejects.
 *
 * Narrower than {@link hasMediaPayload} on purpose: a genuine wire-shaped
 * block (e.g. Anthropic `source.data`) is not inlinable by the canonical
 * converters, so it is excluded from text and skipped at emission rather than
 * emitted as an invalid part with an empty top-level payload.
 */
export function hasInlineMediaData(block: unknown): boolean {
  return isRecord(block) && isNonEmptyString(block.data);
}
