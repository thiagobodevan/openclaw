---
summary: "CLI reference for `openclaw backup` (archives and SQLite-safe artifacts)"
read_when:
  - You want a first-class backup archive for local OpenClaw state
  - You need a SQLite-safe artifact for one OpenClaw database
  - You want to preview which paths would be included before reset or uninstall
title: "Backup"
---

# `openclaw backup`

Create a local backup archive for OpenClaw state, config, auth profiles, channel/provider credentials, sessions, and optionally workspaces.

```bash
openclaw backup create
openclaw backup create --output ~/Backups
openclaw backup create --dry-run --json
openclaw backup create --verify
openclaw backup create --no-include-workspace
openclaw backup create --only-config
openclaw backup verify ./2026-03-09T08-00-00.000+08-00-openclaw-backup.tar.gz
openclaw backup sqlite snapshot create --target global --repository ./snapshots
openclaw backup sqlite snapshot create --agent main --repository ./snapshots
openclaw backup sqlite snapshot list --repository ./snapshots
openclaw backup sqlite snapshot verify ./snapshots/<snapshot-id>
openclaw backup sqlite snapshot restore ./snapshots/<snapshot-id> --target ./restore/openclaw.sqlite
```

## Notes

- The archive embeds a `manifest.json` with the resolved source paths and archive layout.
- Default output is a timestamped `.tar.gz` archive in the current working directory. Timestamped filenames use your machine's local timezone and include the UTC offset. If the current working directory is inside a backed-up source tree, OpenClaw falls back to your home directory for the default archive location.
- Existing archive files are never overwritten. Output paths inside the source state/workspace trees are rejected to avoid self-inclusion.
- `openclaw backup verify <archive>` checks that the archive contains exactly one root manifest, rejects traversal-style archive paths, and confirms every manifest-declared payload exists in the tarball. `openclaw backup create --verify` runs that validation immediately after writing the archive.
- `openclaw backup create --only-config` backs up just the active JSON config file.
- If you only need a SQLite-safe sync artifact for one OpenClaw database, use `openclaw backup sqlite snapshot`. `backup create` is for broad recovery archives.

## SQLite snapshot artifacts

Use `openclaw backup sqlite snapshot` when you need a syncable artifact for one
SQLite database. A snapshot repository stores verified snapshot directories
containing `manifest.json` and `database.sqlite`, so a host, container, object
storage sync, or backup system can copy those files instead of copying a hot
SQLite database.

Use `openclaw backup create` when you need a broader local recovery archive for
OpenClaw state, config, auth profiles, credentials, sessions, and optional
workspaces. Backup archives may contain SQLite-safe database copies, but their
output and restore model are archive-level, not a per-database snapshot
repository.

### What to sync

Sync the snapshot directory created under the repository. A snapshot directory
contains:

- `manifest.json`
- `database.sqlite`

Do not sync live SQLite runtime files as the portability artifact:

- `openclaw.sqlite`
- `openclaw.sqlite-wal`
- `openclaw.sqlite-shm`
- `openclaw-agent.sqlite`
- `openclaw-agent.sqlite-wal`
- `openclaw-agent.sqlite-shm`

Those files are hot runtime state. `openclaw backup sqlite snapshot create`
reads the live database and writes a compact, verified SQLite artifact that can
be copied by a host, container, object storage sync, or backup system.

SQLite snapshot artifacts are still sensitive state. Global and per-agent
artifacts can include auth profile records, session state, plugin state, and
other credentials-adjacent data from the source SQLite database. Protect
snapshot repositories with the same access controls, encryption, retention
policy, and upload destination restrictions you use for OpenClaw backups and
live state.

### Named SQLite targets

Use named targets when snapshotting OpenClaw-owned SQLite state:

| Command                                                                     | Source                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------- |
| `openclaw backup sqlite snapshot create --target global --repository <dir>` | Shared control-plane state database            |
| `openclaw backup sqlite snapshot create --agent <id> --repository <dir>`    | Per-agent database for the normalized agent id |

`--db <path>` remains available for explicit SQLite files and advanced scripts.
Choose only one source selector: `--db`, `--target`, or `--agent`.

Hosted runtimes should ask OpenClaw to materialize the named target instead of
copying private SQLite paths. Hosts can sync only completed snapshot artifacts
from the repository.

### Restore a SQLite artifact

Restore from the copied snapshot directory, not from the live source database
files:

```bash
openclaw backup sqlite snapshot verify ./synced/snapshot
openclaw backup sqlite snapshot restore ./synced/snapshot --target ./hydrated/openclaw.sqlite
```

Restore verifies the manifest, artifact hash, and SQLite integrity before
copying the artifact to the target path. The target SQLite file must not already
exist; stale `-wal`, `-shm`, and `-journal` sidecars at the target path are
removed after the restore copy.

### SQLite snapshot notes

- Snapshot creation uses SQLite `VACUUM INTO`, so deleted-page remnants are not
  carried into the artifact.
- Snapshot repositories are local directories. Uploading or scheduling them is
  intentionally left to the operator or a future integration.
- This command does not add WAL bundle deltas, leases, failover automation, or
  restore-on-boot behavior.

## What gets backed up

`openclaw backup create` plans sources from your local OpenClaw install:

- The state directory (usually `~/.openclaw`)
- The active config file path
- The resolved `credentials/` directory when it exists outside the state directory
- Workspace directories discovered from the current config, unless you pass `--no-include-workspace`

Auth profiles and other per-agent runtime state live in SQLite under the state directory (`agents/<agentId>/agent/openclaw-agent.sqlite`), so they are covered by the state backup entry automatically.

`--only-config` skips state, credentials-directory, and workspace discovery and archives only the active config file path.

OpenClaw canonicalizes paths before building the archive: if config, the credentials directory, or a workspace already live inside the state directory, they are not duplicated as separate top-level backup sources. Missing paths are skipped.

During archive creation, OpenClaw skips known live-mutation files with no restoration value: active agent session transcripts, cron run logs, rolling logs, delivery queues, socket/pid/temp files under the state directory, and related durable-queue temp files. The JSON result's `skippedVolatileCount` reports how many files were intentionally omitted. SQLite databases under the state directory are snapshotted safely (`VACUUM INTO`) rather than copied live, so open WAL/SHM files do not corrupt the backup.

Installed plugin source and manifest files under the state directory's `extensions/` tree are included, but their nested `node_modules/` dependency trees are skipped as rebuildable install artifacts. After restoring an archive, use `openclaw plugins update <id>` or reinstall with `openclaw plugins install <spec> --force` if a restored plugin reports missing dependencies.

## Invalid config behavior

`openclaw backup` bypasses the normal config preflight so it can still help during recovery. Workspace discovery depends on a valid config, so `openclaw backup create` fails fast when the config file exists but is invalid and workspace backup is still enabled.

For a partial backup in that situation, rerun with `--no-include-workspace`: it keeps state, config, and the external credentials directory in scope while skipping workspace discovery entirely.

`--only-config` also works when the config is malformed, since it does not parse the config for workspace discovery.

## Size and performance

OpenClaw does not enforce a built-in maximum backup size or per-file size limit. Practical limits come from:

- Available space for the temporary archive write plus the final archive
- Time to walk large workspace trees and compress them into a `.tar.gz`
- Time to rescan the archive with `--verify` or `openclaw backup verify`
- Destination filesystem behavior: OpenClaw prefers a no-overwrite hard-link publish step and falls back to exclusive copy when hard links are unsupported

Large workspaces are usually the main driver of archive size. Use `--no-include-workspace` for a smaller/faster backup, or `--only-config` for the smallest archive.

## Related

- [CLI reference](/cli)
