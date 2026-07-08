// Channel status tests cover the public snapshot redaction boundary.
import { describe, expect, it } from "vitest";
import { buildChannelAccountSnapshotFromAccount } from "./status.js";
import type { ChannelPlugin } from "./types.plugin.js";

describe("buildChannelAccountSnapshotFromAccount", () => {
  it("projects plugin contributions through the public status contract", async () => {
    const plugin = {
      id: "line",
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({}),
      },
      status: {
        buildAccountSnapshot: () => ({
          accountId: "default",
          configured: true,
          running: true,
          tokenSource: "config",
          probe: { ok: true },
          channelAccessToken: "line-token",
          channelSecret: "line-secret",
          webhookUrl: "https://example.test/secret-hook",
        }),
      },
    } as unknown as ChannelPlugin<Record<string, unknown>>;

    const snapshot = await buildChannelAccountSnapshotFromAccount({
      plugin,
      cfg: {},
      accountId: "default",
      account: {},
      probe: { ok: true, token: "raw-probe-token" },
    });

    expect(snapshot).toEqual({
      accountId: "default",
      configured: true,
      running: true,
      tokenSource: "config",
      probe: { ok: true },
    });
    expect(snapshot).not.toHaveProperty("channelAccessToken");
    expect(snapshot).not.toHaveProperty("channelSecret");
    expect(snapshot).not.toHaveProperty("webhookUrl");
  });

  it("falls back to probe input when a custom snapshot omits it", async () => {
    const plugin = {
      id: "sms",
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({}),
      },
      status: {
        buildAccountSnapshot: () => ({ accountId: "default", configured: true }),
      },
    } as unknown as ChannelPlugin<Record<string, unknown>>;

    const snapshot = await buildChannelAccountSnapshotFromAccount({
      plugin,
      cfg: {},
      accountId: "default",
      account: {},
      probe: { ok: true },
    });

    expect(snapshot.probe).toEqual({ ok: true });
  });
});
