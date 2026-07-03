import { describe, expect, it } from "vitest";
import { toPosixPathSeparators } from "../../scripts/lib/path-normalization.mjs";

describe("toPosixPathSeparators", () => {
  it.each([
    ["", ""],
    ["relative/path", "relative/path"],
    ["relative\\path\\..\\file", "relative/path/../file"],
    ["/", "/"],
    ["C:\\", "C:/"],
    ["C:\\Users\\Alice\\File.TXT", "C:/Users/Alice/File.TXT"],
    ["\\\\server\\share\\folder\\", "//server/share/folder/"],
  ])("normalizes separators without changing other path semantics: %s", (input, expected) => {
    expect(toPosixPathSeparators(input)).toBe(expected);
  });
});
