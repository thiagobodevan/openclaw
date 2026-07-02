import { beforeEach, describe, expect, it } from "vitest";
import {
  isConfiguredOrLiveOwnedSessionTarget,
  isLiveOwnedSessionTarget,
} from "./session-target-identity.js";
import { addSubagentRunForTests, resetSubagentRegistryForTests } from "./subagent-registry.js";

const parentSessionKey = "agent:main:main";
const childSessionKey = "agent:removed-service:subagent:child";

function addChildRun(overrides: { endedAt?: number; startedAt?: number } = {}) {
  const createdAt = overrides.startedAt ?? Date.now();
  addSubagentRunForTests({
    runId: "run-removed-service-child",
    childSessionKey,
    requesterSessionKey: parentSessionKey,
    requesterDisplayKey: "main",
    task: "child task",
    cleanup: "keep",
    createdAt,
    startedAt: createdAt,
    ...overrides,
  });
}

describe("session target identity", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
  });

  it("admits an unconfigured target only while it is a live child owned by the requester", () => {
    addChildRun();

    expect(
      isConfiguredOrLiveOwnedSessionTarget({
        cfg: { agents: { list: [{ id: "main", default: true }] } },
        requesterSessionKey: parentSessionKey,
        targetSessionKey: childSessionKey,
      }),
    ).toBe(true);
    expect(
      isLiveOwnedSessionTarget({
        requesterSessionKey: "agent:other:main",
        targetSessionKey: childSessionKey,
      }),
    ).toBe(false);
  });

  it("admits a legacy implicit-registry target while an explicit binding owns it", () => {
    expect(
      isConfiguredOrLiveOwnedSessionTarget({
        cfg: {
          bindings: [
            {
              agentId: "team-ops",
              match: { channel: "discord", guildId: "guild-1" },
            },
          ],
        },
        requesterSessionKey: parentSessionKey,
        targetSessionKey: "agent:team-ops:discord:channel:ops",
      }),
    ).toBe(true);
    expect(
      isConfiguredOrLiveOwnedSessionTarget({
        cfg: {},
        requesterSessionKey: parentSessionKey,
        targetSessionKey: "agent:team-ops:discord:channel:ops",
      }),
    ).toBe(false);
  });

  it.each([
    { name: "ended", endedAt: Date.now() - 1_000, startedAt: Date.now() - 2_000 },
    { name: "stale", startedAt: Date.now() - 3 * 60 * 60 * 1_000 },
  ])("rejects an unconfigured $name child", ({ endedAt, startedAt }) => {
    addChildRun({ endedAt, startedAt });

    expect(
      isConfiguredOrLiveOwnedSessionTarget({
        cfg: { agents: { list: [{ id: "main", default: true }] } },
        requesterSessionKey: parentSessionKey,
        targetSessionKey: childSessionKey,
      }),
    ).toBe(false);
  });
});
