// Covers the chat.history final byte-budget fallback, including the sentinel
// that prevents an empty (blank) transcript from being returned to the dashboard,
// and the head-preserving byte cap used by afterSeq catch-up pages.
import { describe, expect, it } from "vitest";
import { capCursorChatHistoryMessagesKeepOldest, enforceChatHistoryFinalBudget } from "./chat.js";

type DisplayMessage = {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
};

function firstText(messages: unknown[]): string {
  const msg = messages[0] as DisplayMessage | undefined;
  return msg?.content?.[0]?.text ?? "";
}

describe("enforceChatHistoryFinalBudget", () => {
  it("passes through history that already fits the budget", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const result = enforceChatHistoryFinalBudget({ messages, maxBytes: 1_000_000 });
    expect(result.messages).toEqual(messages);
  });

  it("returns the empty array unchanged for empty input", () => {
    const result = enforceChatHistoryFinalBudget({ messages: [], maxBytes: 10 });
    expect(result.messages).toEqual([]);
  });

  it("keeps just the last message when the full set is over budget but the last fits", () => {
    const big = { role: "user", content: [{ type: "text", text: "x".repeat(4000) }] };
    const last = { role: "assistant", content: [{ type: "text", text: "ok" }] };
    const result = enforceChatHistoryFinalBudget({ messages: [big, last], maxBytes: 2_000 });
    // The same last-message reference survives so callers can detect which
    // originals were omitted by identity.
    expect(result.messages).toEqual([last]);
    expect(result.messages[0]).toBe(last);
  });

  it("falls back to a small placeholder when even the last message is too large", () => {
    const last = {
      role: "assistant",
      timestamp: 1,
      content: [{ type: "text", text: "y".repeat(4000) }],
      __openclaw: { id: "abc", seq: 7 },
    };
    const result = enforceChatHistoryFinalBudget({ messages: [last], maxBytes: 2_000 });
    expect(result.messages).toHaveLength(1);
    expect(firstText(result.messages)).toContain("chat.history omitted: message too large");
    // The placeholder is a new object, not the oversized original.
    expect(result.messages[0]).not.toBe(last);
  });

  it("returns a metadata-free sentinel (never an empty transcript) when even the placeholder is over budget", () => {
    // A pathological message whose oversized-placeholder copy is itself too
    // large because it carries very large transcript metadata.
    const hugeId = "z".repeat(4000);
    const message = {
      role: "user",
      timestamp: 1,
      content: [{ type: "text", text: "hi" }],
      __openclaw: { id: hugeId, seq: 1 },
    };
    const result = enforceChatHistoryFinalBudget({ messages: [message], maxBytes: 1_000 });

    // The critical guarantee: the dashboard never receives an empty history.
    expect(result.messages).toHaveLength(1);
    expect(firstText(result.messages)).toContain("chat.history unavailable");
    // The sentinel does not carry the oversized source metadata.
    expect((result.messages[0] as Record<string, unknown>)["__openclaw"]).toBeUndefined();
  });
});

describe("capCursorChatHistoryMessagesKeepOldest", () => {
  const row = (seq: number, text: string) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    __openclaw: { seq },
  });
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

  it("passes through pages that already fit the budget", () => {
    const messages = [row(1, "hello"), row(2, "hi")];
    const result = capCursorChatHistoryMessagesKeepOldest({ messages, maxBytes: 1_000_000 });
    expect(result.messages).toEqual(messages);
  });

  it("keeps the oldest rows when trimming, not the newest", () => {
    const oldest = row(1, "a".repeat(80));
    const newer = row(2, "b".repeat(80));
    const newest = row(3, "c".repeat(80));
    const maxBytes = 2 + bytes(oldest) + 1 + Math.floor(bytes(newer) / 2);
    const result = capCursorChatHistoryMessagesKeepOldest({
      messages: [oldest, newer, newest],
      maxBytes,
    });
    expect(result.messages).toEqual([oldest]);
    expect(result.messages[0]).toBe(oldest);
  });

  it("delivers the whole first seq group even when it exceeds the budget", () => {
    // One raw transcript entry fanned into three mirror rows sharing seq 1.
    const group = [row(1, "a".repeat(80)), row(1, "b".repeat(80)), row(1, "c".repeat(80))];
    const next = row(2, "d".repeat(80));
    // Budget admits ~1.5 rows: the boundary lands inside the first group. A
    // partial group would advance the cursor past the raw entry and lose the
    // remaining mirror rows, so the whole group ships as one oversized page.
    const maxBytes = bytes(group[0]) + Math.floor(bytes(group[1]) / 2);
    const result = capCursorChatHistoryMessagesKeepOldest({
      messages: [...group, next],
      maxBytes,
    });
    expect(result.messages).toEqual(group);
  });

  it("trims at the previous group boundary when the budget splits a later group", () => {
    const first = row(1, "a".repeat(80));
    const group2 = [row(2, "b".repeat(80)), row(2, "c".repeat(80))];
    // Budget admits the first row plus one row of group 2: the cut retreats to
    // the group boundary so group 2 is re-delivered whole on the next page.
    const maxBytes = 2 + bytes(first) + 1 + bytes(group2[0]) + 1 + Math.floor(bytes(group2[1]) / 2);
    const result = capCursorChatHistoryMessagesKeepOldest({
      messages: [first, ...group2],
      maxBytes,
    });
    expect(result.messages).toEqual([first]);
  });
});
