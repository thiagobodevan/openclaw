import { describe, expect, it } from "vitest";
import {
  hasInlineMediaData,
  isCanonicalImageBlock,
  isImageLabeledBlock,
  readMediaMimeType,
} from "./media-blocks.js";

describe("media-blocks vocabulary", () => {
  it("classifies image-labeled blocks regardless of payload", () => {
    expect(isImageLabeledBlock({ type: "image" })).toBe(true);
    expect(isImageLabeledBlock({ type: "image", data: "aW1n", mimeType: "image/png" })).toBe(true);
    expect(isImageLabeledBlock({ type: "text", text: "hi" })).toBe(false);
    expect(isImageLabeledBlock(null)).toBe(false);
  });

  it("requires string data and mimeType for the canonical image shape", () => {
    expect(isCanonicalImageBlock({ type: "image", data: "aW1n", mimeType: "image/png" })).toBe(
      true,
    );
    // Empty data still matches the canonical shape; payload validity is the
    // sanitizers' concern, not classification's.
    expect(isCanonicalImageBlock({ type: "image", data: "", mimeType: "image/png" })).toBe(true);
    expect(isCanonicalImageBlock({ type: "image", mimeType: "image/png" })).toBe(false);
    expect(isCanonicalImageBlock({ type: "image", data: "aW1n" })).toBe(false);
  });

  it("requires a non-empty inline payload for renderability", () => {
    expect(hasInlineMediaData({ type: "image", data: "aW1n", mimeType: "image/png" })).toBe(true);
    expect(hasInlineMediaData({ type: "image", data: "", mimeType: "image/png" })).toBe(false);
    expect(hasInlineMediaData({ type: "image", data: "   ", mimeType: "image/png" })).toBe(false);
    expect(hasInlineMediaData({ type: "image", source: { data: "aW1n" } })).toBe(false);
  });

  it("reads the first non-empty MIME key spelling", () => {
    expect(readMediaMimeType({ mimeType: "image/png" })).toBe("image/png");
    expect(readMediaMimeType({ media_type: "image/webp" })).toBe("image/webp");
    expect(readMediaMimeType({ contentType: "audio/mpeg" })).toBe("audio/mpeg");
    expect(readMediaMimeType({ mimeType: " " })).toBeUndefined();
    expect(readMediaMimeType("image/png")).toBeUndefined();
  });
});
