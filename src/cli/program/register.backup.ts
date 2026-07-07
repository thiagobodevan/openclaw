// Backup command registration for local state archive creation and verification.
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { backupVerifyCommand } from "../../commands/backup-verify.js";
import { backupCreateCommand } from "../../commands/backup.js";
import {
  snapshotCreateCommand,
  snapshotListCommand,
  snapshotRestoreCommand,
  snapshotVerifyCommand,
  type SnapshotCreateOptions,
  type SnapshotJsonOptions,
  type SnapshotRepositoryOptions,
  type SnapshotRestoreOptions,
} from "../../commands/snapshot.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

/** Register backup create/verify subcommands. */
export function registerBackupCommand(program: Command) {
  const backup = program
    .command("backup")
    .description("Create archives and SQLite-safe artifacts for OpenClaw state")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/backup", "docs.openclaw.ai/cli/backup")}\n`,
    );

  backup
    .command("create")
    .description("Write a backup archive for config, credentials, sessions, and workspaces")
    .option("--output <path>", "Archive path or destination directory")
    .option("--json", "Output JSON", false)
    .option("--dry-run", "Print the backup plan without writing the archive", false)
    .option("--verify", "Verify the archive after writing it", false)
    .option("--only-config", "Back up only the active JSON config file", false)
    .option("--no-include-workspace", "Exclude workspace directories from the backup")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw backup create", "Create a timestamped backup in the current directory."],
          [
            "openclaw backup create --output ~/Backups",
            "Write the archive into an existing backup directory.",
          ],
          [
            "openclaw backup create --dry-run --json",
            "Preview the archive plan without writing any files.",
          ],
          [
            "openclaw backup create --verify",
            "Create the archive and immediately validate its manifest and payload layout.",
          ],
          [
            "openclaw backup create --no-include-workspace",
            "Back up state/config without agent workspace files.",
          ],
          ["openclaw backup create --only-config", "Back up only the active JSON config file."],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupCreateCommand(defaultRuntime, {
          output: opts.output as string | undefined,
          json: Boolean(opts.json),
          dryRun: Boolean(opts.dryRun),
          verify: Boolean(opts.verify),
          onlyConfig: Boolean(opts.onlyConfig),
          includeWorkspace: opts.includeWorkspace as boolean,
        });
      });
    });

  backup
    .command("verify <archive>")
    .description("Validate a backup archive and its embedded manifest")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw backup verify ./2026-03-09T08-00-00.000+08-00-openclaw-backup.tar.gz",
            "Check that the archive structure and manifest are intact.",
          ],
          [
            "openclaw backup verify ~/Backups/latest.tar.gz --json",
            "Emit machine-readable verification output.",
          ],
        ])}`,
    )
    .action(async (archive, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupVerifyCommand(defaultRuntime, {
          archive: archive as string,
          json: Boolean(opts.json),
        });
      });
    });

  registerBackupSqliteSnapshotCommands(backup);
}

function registerBackupSqliteSnapshotCommands(backup: Command): void {
  const sqlite = backup
    .command("sqlite")
    .description("SQLite-specific backup artifact helpers")
    .action(() => {
      sqlite.outputHelp();
      process.exitCode = 1;
    });

  const snapshot = sqlite
    .command("snapshot")
    .description("Create, verify, list, and restore SQLite snapshot artifacts")
    .action(() => {
      snapshot.outputHelp();
      process.exitCode = 1;
    });

  snapshot
    .command("create")
    .description("Create a consistent SQLite snapshot in a local repository")
    .option("--db <path>", "SQLite database path")
    .option("--target <target>", "OpenClaw database target (global)")
    .option("--agent <id>", "OpenClaw agent id for the per-agent database")
    .requiredOption("--repository <path>", "Snapshot repository directory")
    .option("--id <id>", "Logical database id recorded in the manifest")
    .option("--kind <kind>", "Logical database kind recorded in the manifest")
    .option("--json", "Emit JSON output")
    .action(async (options: SnapshotCreateOptions) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        process.exitCode = await snapshotCreateCommand(options, defaultRuntime);
      });
    });

  snapshot
    .command("verify")
    .description("Verify a snapshot manifest, artifact hash, and SQLite integrity")
    .argument("<snapshot>", "Snapshot directory")
    .option("--json", "Emit JSON output")
    .action(async (snapshotPath: string, options: SnapshotJsonOptions) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        process.exitCode = await snapshotVerifyCommand(snapshotPath, options, defaultRuntime);
      });
    });

  snapshot
    .command("restore")
    .description("Restore a verified snapshot to a new SQLite database path")
    .argument("<snapshot>", "Snapshot directory")
    .requiredOption("--target <path>", "Target SQLite database path; must not already exist")
    .option("--json", "Emit JSON output")
    .action(async (snapshotPath: string, options: SnapshotRestoreOptions) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        process.exitCode = await snapshotRestoreCommand(snapshotPath, options, defaultRuntime);
      });
    });

  snapshot
    .command("list")
    .description("List snapshots in a local repository")
    .requiredOption("--repository <path>", "Snapshot repository directory")
    .option("--json", "Emit JSON output")
    .action(async (options: SnapshotRepositoryOptions) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        process.exitCode = await snapshotListCommand(options, defaultRuntime);
      });
    });
}
