// Register backup tests cover backup command registration and option wiring.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBackupCommand } from "./register.backup.js";

const mocks = vi.hoisted(() => ({
  backupCreateCommand: vi.fn(),
  backupVerifyCommand: vi.fn(),
  snapshotCreateCommand: vi.fn(),
  snapshotListCommand: vi.fn(),
  snapshotRestoreCommand: vi.fn(),
  snapshotVerifyCommand: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const backupCreateCommand = mocks.backupCreateCommand;
const backupVerifyCommand = mocks.backupVerifyCommand;
const snapshotCreateCommand = mocks.snapshotCreateCommand;
const snapshotListCommand = mocks.snapshotListCommand;
const snapshotRestoreCommand = mocks.snapshotRestoreCommand;
const snapshotVerifyCommand = mocks.snapshotVerifyCommand;
const runtime = mocks.runtime;

vi.mock("../../commands/backup.js", () => ({
  backupCreateCommand: mocks.backupCreateCommand,
}));

vi.mock("../../commands/backup-verify.js", () => ({
  backupVerifyCommand: mocks.backupVerifyCommand,
}));

vi.mock("../../commands/snapshot.js", () => ({
  snapshotCreateCommand: mocks.snapshotCreateCommand,
  snapshotListCommand: mocks.snapshotListCommand,
  snapshotRestoreCommand: mocks.snapshotRestoreCommand,
  snapshotVerifyCommand: mocks.snapshotVerifyCommand,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerBackupCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerBackupCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    backupCreateCommand.mockResolvedValue(undefined);
    backupVerifyCommand.mockResolvedValue(undefined);
    snapshotCreateCommand.mockResolvedValue(0);
    snapshotListCommand.mockResolvedValue(0);
    snapshotRestoreCommand.mockResolvedValue(0);
    snapshotVerifyCommand.mockResolvedValue(0);
  });

  function expectForwardedOptions(command: typeof backupCreateCommand): Record<string, unknown> {
    expect(command).toHaveBeenCalledTimes(1);
    const call = command.mock.calls[0];
    if (!call) {
      throw new Error("expected backup command call");
    }
    const [runtimeArg, options] = call as unknown as [typeof runtime, Record<string, unknown>];
    expect(runtimeArg).toBe(runtime);
    return options;
  }

  it("runs backup create with forwarded options", async () => {
    await runCli(["backup", "create", "--output", "/tmp/backups", "--json", "--dry-run"]);

    const options = expectForwardedOptions(backupCreateCommand);
    expect(options.output).toBe("/tmp/backups");
    expect(options.json).toBe(true);
    expect(options.dryRun).toBe(true);
    expect(options.verify).toBe(false);
    expect(options.onlyConfig).toBe(false);
    expect(options.includeWorkspace).toBe(true);
  });

  it("honors --no-include-workspace", async () => {
    await runCli(["backup", "create", "--no-include-workspace"]);

    const options = expectForwardedOptions(backupCreateCommand);
    expect(options.includeWorkspace).toBe(false);
  });

  it("forwards --verify to backup create", async () => {
    await runCli(["backup", "create", "--verify"]);

    const options = expectForwardedOptions(backupCreateCommand);
    expect(options.verify).toBe(true);
  });

  it("forwards --only-config to backup create", async () => {
    await runCli(["backup", "create", "--only-config"]);

    const options = expectForwardedOptions(backupCreateCommand);
    expect(options.onlyConfig).toBe(true);
  });

  it("runs backup verify with forwarded options", async () => {
    await runCli(["backup", "verify", "/tmp/openclaw-backup.tar.gz", "--json"]);

    const options = expectForwardedOptions(backupVerifyCommand);
    expect(options.archive).toBe("/tmp/openclaw-backup.tar.gz");
    expect(options.json).toBe(true);
  });

  it("registers the SQLite snapshot backup command group", () => {
    const program = new Command();

    registerBackupCommand(program);

    const backup = program.commands.find((command) => command.name() === "backup");
    const sqlite = backup?.commands.find((command) => command.name() === "sqlite");
    const snapshot = sqlite?.commands.find((command) => command.name() === "snapshot");
    expect(snapshot?.commands.map((command) => command.name()).toSorted()).toEqual([
      "create",
      "list",
      "restore",
      "verify",
    ]);
  });

  it("runs SQLite snapshot create with forwarded options", async () => {
    await runCli([
      "backup",
      "sqlite",
      "snapshot",
      "create",
      "--db",
      "/tmp/source.sqlite",
      "--repository",
      "/tmp/snapshots",
      "--id",
      "global",
      "--kind",
      "control-plane",
      "--json",
    ]);

    expect(snapshotCreateCommand).toHaveBeenCalledWith(
      {
        db: "/tmp/source.sqlite",
        repository: "/tmp/snapshots",
        id: "global",
        kind: "control-plane",
        json: true,
      },
      runtime,
    );
  });

  it("runs SQLite snapshot create for named OpenClaw targets", async () => {
    await runCli([
      "backup",
      "sqlite",
      "snapshot",
      "create",
      "--target",
      "global",
      "--repository",
      "/tmp/snapshots",
    ]);

    expect(snapshotCreateCommand).toHaveBeenCalledWith(
      {
        target: "global",
        repository: "/tmp/snapshots",
      },
      runtime,
    );

    await runCli([
      "backup",
      "sqlite",
      "snapshot",
      "create",
      "--agent",
      "main",
      "--repository",
      "/tmp/snapshots",
    ]);

    expect(snapshotCreateCommand).toHaveBeenLastCalledWith(
      {
        agent: "main",
        repository: "/tmp/snapshots",
      },
      runtime,
    );
  });

  it("runs SQLite snapshot list with forwarded options", async () => {
    await runCli([
      "backup",
      "sqlite",
      "snapshot",
      "list",
      "--repository",
      "/tmp/snapshots",
      "--json",
    ]);

    expect(snapshotListCommand).toHaveBeenCalledWith(
      { repository: "/tmp/snapshots", json: true },
      runtime,
    );
  });

  it("runs SQLite snapshot verify with forwarded options", async () => {
    await runCli(["backup", "sqlite", "snapshot", "verify", "/tmp/snapshots/one", "--json"]);

    expect(snapshotVerifyCommand).toHaveBeenCalledWith(
      "/tmp/snapshots/one",
      { json: true },
      runtime,
    );
  });

  it("runs SQLite snapshot restore with forwarded options", async () => {
    await runCli([
      "backup",
      "sqlite",
      "snapshot",
      "restore",
      "/tmp/snapshots/one",
      "--target",
      "/tmp/restore.sqlite",
      "--json",
    ]);

    expect(snapshotRestoreCommand).toHaveBeenCalledWith(
      "/tmp/snapshots/one",
      { target: "/tmp/restore.sqlite", json: true },
      runtime,
    );
  });
});
