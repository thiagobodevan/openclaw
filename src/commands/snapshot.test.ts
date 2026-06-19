import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import {
  snapshotCreateCommand,
  snapshotListCommand,
  snapshotRestoreCommand,
  snapshotVerifyCommand,
} from "./snapshot.js";

let workspaceDir: string;
let previousOpenClawStateDir: string | undefined;

describe("snapshot cli", () => {
  beforeEach(async () => {
    previousOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
    workspaceDir = await fs.mkdtemp(path.join(tmpdir(), "snapshot-cli-"));
  });

  afterEach(async () => {
    if (previousOpenClawStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousOpenClawStateDir;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("creates, lists, verifies, and restores a SQLite snapshot", async () => {
    const runtime = createRuntimeCapture();
    const dbPath = path.join(workspaceDir, "source.sqlite");
    const repositoryPath = path.join(workspaceDir, "snapshots");
    const restorePath = path.join(workspaceDir, "restore", "source.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA user_version = 12;
        CREATE TABLE entries (value TEXT NOT NULL);
        INSERT INTO entries (value) VALUES ('from-cli');
      `);
    } finally {
      db.close();
    }

    await expect(
      snapshotCreateCommand(
        {
          db: dbPath,
          repository: repositoryPath,
          id: "cli-db",
          kind: "test",
          json: true,
        },
        runtime,
      ),
    ).resolves.toBe(0);
    const createReport = JSON.parse(runtime.logs.shift() ?? "{}") as {
      snapshotPath?: string;
      manifest?: { database?: { id?: string; kind?: string; userVersion?: number } };
    };
    expect(createReport.snapshotPath).toBeTruthy();
    expect(createReport.manifest?.database).toMatchObject({
      id: "cli-db",
      kind: "test",
      userVersion: 12,
    });

    await expect(
      snapshotListCommand({ repository: repositoryPath, json: true }, runtime),
    ).resolves.toBe(0);
    const listReport = JSON.parse(runtime.logs.shift() ?? "{}") as {
      snapshots?: unknown[];
    };
    expect(listReport.snapshots).toHaveLength(1);

    await expect(
      snapshotVerifyCommand(createReport.snapshotPath ?? "", { json: true }, runtime),
    ).resolves.toBe(0);
    const verifyReport = JSON.parse(runtime.logs.shift() ?? "{}") as {
      ok?: boolean;
      integrityCheck?: string[];
    };
    expect(verifyReport).toMatchObject({ ok: true, integrityCheck: ["ok"] });

    await expect(
      snapshotRestoreCommand(
        createReport.snapshotPath ?? "",
        { target: restorePath, json: true },
        runtime,
      ),
    ).resolves.toBe(0);
    const restoreReport = JSON.parse(runtime.logs.shift() ?? "{}") as {
      ok?: boolean;
      targetPath?: string;
    };
    expect(restoreReport).toMatchObject({ ok: true, targetPath: restorePath });
    expect(runtime.errors).toEqual([]);

    const restored = new DatabaseSync(restorePath, { readOnly: true });
    try {
      expect(restored.prepare("SELECT value FROM entries").all()).toEqual([{ value: "from-cli" }]);
    } finally {
      restored.close();
    }
  });

  it("returns command usage errors without throwing", async () => {
    const runtime = createRuntimeCapture();

    await expect(snapshotCreateCommand({ repository: workspaceDir }, runtime)).resolves.toBe(2);

    expect(runtime.logs).toEqual([]);
    expect(runtime.errors).toEqual([
      "Missing snapshot source. Provide one of --db <path>, --target global, or --agent <id>.",
    ]);
  });

  it("creates a snapshot from the named global OpenClaw database", async () => {
    const runtime = createRuntimeCapture();
    const stateDir = path.join(workspaceDir, "state-root");
    const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
    const repositoryPath = path.join(workspaceDir, "snapshots");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await createSqliteDatabase(dbPath, "from-global");

    await expect(
      snapshotCreateCommand({ target: "global", repository: repositoryPath, json: true }, runtime),
    ).resolves.toBe(0);

    const createReport = JSON.parse(runtime.logs.shift() ?? "{}") as {
      snapshotPath?: string;
      manifest?: { database?: { id?: string; kind?: string } };
    };
    expect(createReport.snapshotPath).toBeTruthy();
    expect(createReport.manifest?.database).toMatchObject({
      id: "global",
      kind: "global-control-plane",
    });
    expect(runtime.errors).toEqual([]);
  });

  it("creates a snapshot from the named per-agent OpenClaw database", async () => {
    const runtime = createRuntimeCapture();
    const stateDir = path.join(workspaceDir, "state-root");
    const dbPath = path.join(stateDir, "agents", "ops-team", "agent", "openclaw-agent.sqlite");
    const repositoryPath = path.join(workspaceDir, "snapshots");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await createSqliteDatabase(dbPath, "from-agent");

    await expect(
      snapshotCreateCommand({ agent: "Ops Team", repository: repositoryPath, json: true }, runtime),
    ).resolves.toBe(0);

    const createReport = JSON.parse(runtime.logs.shift() ?? "{}") as {
      snapshotPath?: string;
      manifest?: { database?: { id?: string; kind?: string } };
    };
    expect(createReport.snapshotPath).toBeTruthy();
    expect(createReport.manifest?.database).toMatchObject({
      id: "agent:ops-team",
      kind: "agent-data-plane",
    });
    expect(runtime.errors).toEqual([]);
  });

  it("rejects ambiguous snapshot source selectors", async () => {
    const runtime = createRuntimeCapture();

    await expect(
      snapshotCreateCommand(
        { db: "/tmp/source.sqlite", target: "global", repository: workspaceDir },
        runtime,
      ),
    ).resolves.toBe(2);

    expect(runtime.logs).toEqual([]);
    expect(runtime.errors).toEqual([
      "Choose only one snapshot source: --db, --target, or --agent.",
    ]);
  });
});

async function createSqliteDatabase(dbPath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE entries (value TEXT NOT NULL);
    `);
    db.prepare("INSERT INTO entries (value) VALUES (?)").run(value);
  } finally {
    db.close();
  }
}

function createRuntimeCapture(): RuntimeEnv & {
  readonly logs: string[];
  readonly errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log(value) {
      logs.push(String(value));
    },
    error(value) {
      errors.push(String(value));
    },
    exit(code) {
      throw new Error(`exit ${code}`);
    },
  };
}
