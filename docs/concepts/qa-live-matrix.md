---
summary: "Maintainer reference for Matrix live QA through the canonical QA Lab scenario host and transport adapter."
read_when:
  - Running pnpm openclaw qa matrix locally
  - Adding or selecting Matrix QA scenarios
  - Triaging Matrix QA lifecycle or scenario failures
title: "QA Lab Matrix"
---

QA Lab runs the bundled `@openclaw/matrix` plugin against a disposable Tuwunel homeserver in Docker. The Matrix transport adapter provisions temporary driver, SUT, and observer accounts, starts the gateway, and exposes the same lifecycle contract used by the shared QA Lab scenario host.

Maintainer-only tooling. Packaged OpenClaw releases omit `qa-lab`, so `openclaw qa` only runs from a source checkout.

For broader QA framework context, see [QA overview](/concepts/qa-e2e-automation).

## Quick start

The focused selector is a thin QA Lab-owned delegate:

```bash
pnpm openclaw qa matrix \
  --profile release \
  --provider-mode mock-openai \
  --model mock-openai/gpt-5.5 \
  --alt-model mock-openai/gpt-5.5-alt \
  --fast
```

It resolves the selected profile to canonical QA Lab scenario ids, then invokes the same suite host as:

```bash
pnpm openclaw qa suite \
  --channel-driver live \
  --channel matrix \
  --scenario channel-chat-baseline \
  --scenario matrix-allowlist-hot-reload \
  --provider-mode mock-openai \
  --model mock-openai/gpt-5.5 \
  --alt-model mock-openai/gpt-5.5-alt \
  --fast
```

There is no separate Matrix runner, scenario catalog, artifact format, or compatibility fallback.

## Profiles

| Profile      | Count | Use                                                                                  |
| ------------ | ----: | ------------------------------------------------------------------------------------ |
| `release`    |     2 | Release-critical chat and allowlist hot-reload proof                                 |
| `fast`       |    11 | Short transport, policy, approval, thread, and E2EE smoke                            |
| `transport`  |    50 | Messaging, rooms, DMs, threads, streaming, approvals, policy, restart, and sync      |
| `media`      |     7 | Inbound media, generated images, voice preflight, and encrypted media                |
| `e2ee-smoke` |     8 | Encrypted messaging, bootstrap, recovery-key lifecycle, restart, and redaction       |
| `e2ee-deep`  |    18 | Destructive crypto-state, backup, device, verification, and recovery behavior        |
| `e2ee-cli`   |     9 | Account setup, encryption setup, recovery keys, multi-account, and self-verification |
| `all`        |    92 | Every default legacy Matrix scenario; excludes the two explicit-only stress cases    |

All 94 legacy scenario ids now resolve to canonical QA Lab scenarios. The default `all` profile preserves the old 92-scenario selection, while `matrix-room-block-streaming` and `subagent-thread-spawn` remain explicit-only as before. Portable behaviors reuse existing QA Lab flows. Matrix-specific behaviors use canonical scenario YAML for profile membership, config, topology, timeout, and retry metadata, then execute through the single Matrix transport adapter.

Repeat `--scenario <id>` to bypass profile selection and run only named canonical QA Lab scenarios.

## CLI flags

`pnpm openclaw qa matrix` uses the shared QA Lab live-transport CLI surface:

- `--profile <profile>`: select `all`, `fast`, `release`, `transport`, `media`, `e2ee-smoke`, `e2ee-deep`, or `e2ee-cli`; default `all`.
- `--scenario <id>`: run a named scenario; repeatable and takes precedence over the profile.
- `--provider-mode <mode>`: choose the QA Lab provider mode; defaults to `live-frontier`, matching the old Matrix selector. CI and release workflows pass `mock-openai` explicitly for deterministic proof.
- `--model <ref>` and `--alt-model <ref>`: select primary and alternate models.
- `--fast`: enable provider fast mode where supported.
- `--allow-failures`: write evidence without returning a failing exit code for scenario failures.
- `--fail-fast`: stop after the first failed scenario. Matrix runs remain sequential, matching the old runner.
- `--output-dir <path>`: choose the QA Lab artifact directory.
- `--repo-root <path>`: target a source checkout from another working directory.
- `--sut-account <id>`: choose the temporary Matrix account id in the gateway config.

The disposable Matrix homeserver does not use credential leases or credential roles.

## Lifecycle ownership

`live:matrix` is registered through QA Lab's transport registry. Its channel-driver lifecycle owns Tuwunel provisioning and teardown through the Matrix adapter, while the QA Lab suite host owns scenario selection, execution, failure semantics, and evidence generation. The adapter executes Matrix-specific assertions against that same lifecycle and calls the child Gateway for Matrix actions, so the bundled Matrix plugin remains the behavior owner.

Legacy Matrix scenarios keep their original per-scenario timeout. They declare zero automatic scenario retries, matching the old runner; only the bounded one-time stale-config-hash retry remains. Portable QA Lab flows retain their existing suite retry policy.

The focused lifecycle test exercises provision, start, scenario execution, restart, evidence collection, and cleanup for both the live Matrix adapter and the Crabline Matrix adapter.

## Output artifacts

The selector writes the standard QA Lab suite artifacts to `--output-dir`:

- `qa-suite-report.md`: human-readable scenario and step results.
- `qa-suite-summary.json`: structured suite status and timing data.
- `qa-evidence.json`: normalized QA evidence consumed by CI and release checks.

Matrix transport logs and lifecycle evidence referenced by the suite are stored beneath the same run directory. The lane does not maintain a second Matrix-specific report or summary format.

## Workflow use

`QA-Lab - All Lanes` and `OpenClaw Release Checks` call the focused selector through the reusable QA Live workflow. Scheduled live-provider and release gates use `--profile release`; manual dispatch defaults to the comprehensive `all` profile with `mock-openai`. Every profile uses the same QA Lab suite and Matrix adapter path.

## Related

- [QA overview](/concepts/qa-e2e-automation): overall QA stack and live transport contract
- [QA Channel](/channels/qa-channel): synthetic channel adapter for repo-backed scenarios
- [Testing](/help/testing): running tests and adding QA coverage
- [Matrix](/channels/matrix): the channel plugin under test
