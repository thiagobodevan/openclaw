---
title: Local Embedding Safety Plan
author: Bob <dutifulbob@gmail.com>
date: 2026-05-22
---

# Local Embedding Safety Plan

Issue: https://github.com/openclaw/openclaw/issues/44202

## Context

OpenClaw users on Apple Silicon have reported local memory embedding crashes in
the `node-llama-cpp` and `ggml-metal` path. The observed crash can happen during
Metal cleanup on process exit, after embedding work has already completed.

This is separate from the generic plugin embedding provider contract added by
PR #84947. The generic contract is useful future plumbing, but the immediate
safety work should stay on the existing local memory embedding path.

## Goal

Make local GGUF embeddings safer on macOS Apple Silicon without waiting for the
new plugin SDK embedding provider bridge.

The first deliverable should make a native local embedding failure degrade memory
search instead of threatening the Gateway process. The second deliverable should
give operators an explicit CPU or Metal policy for local embeddings.

## Non-Goals

- Do not redesign the public plugin embedding provider contract.
- Do not migrate memory to generic `embeddingProviders` in this fix.
- Do not add a new production embedding provider.
- Do not make local embedding failures silently fall back to cloud providers.
- Do not remove existing `memoryEmbeddingProviders` compatibility.

## Current Problem Shape

- `packages/memory-host-sdk/src/host/embeddings.ts` lazy-loads
  `node-llama-cpp` inside the Gateway process.
- The local provider currently calls `getLlama({ logLevel })` with no explicit
  CPU or Metal policy.
- Local `embedBatch` currently runs `ctx.getEmbeddingFor(...)` calls through
  `Promise.all`, which can exercise native embedding work concurrently.
- The strict config schema accepts only `local.modelPath`,
  `local.modelCacheDir`, and `local.contextSize`.
- If the native addon aborts the process, TypeScript error handling cannot catch
  it inside the same process.

## Proposed Work

### Phase 1: Safer Local Batch Semantics

Make local `embedBatch` sequential by default in the existing local provider.

Files:

- `packages/memory-host-sdk/src/host/embeddings.ts`
- `packages/memory-host-sdk/src/host/embeddings.test.ts`

Acceptance:

- A focused test proves the second local embedding request does not start until
  the first has resolved.
- Abort signals are still checked before each item.
- Existing query and close behavior remains unchanged.

### Phase 2: Explicit CPU Or Metal Policy

Add a local embedding runtime policy under `memorySearch.local`.

Candidate config:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        local: {
          gpu: "auto" // "auto" | "metal" | false
        }
      }
    }
  }
}
```

Implementation notes:

- Map `"auto"` to `getLlama({ gpu: "auto" })`.
- Map `"metal"` to `getLlama({ gpu: "metal" })`.
- Map `false` to `getLlama({ gpu: false })`.
- Consider `loadModel({ gpuLayers: 0 })` for CPU-only mode if upstream
  `node-llama-cpp` behavior requires it.
- Keep the default conservative. If maintainers want current behavior preserved,
  default to `"auto"` and document that CPU-only is the safer Apple Silicon
  mitigation. If maintainers want safety first on macOS, default Apple Silicon
  local embeddings to CPU-only and document the performance tradeoff.

Files:

- `packages/memory-host-sdk/src/host/node-llama.ts`
- `packages/memory-host-sdk/src/host/embeddings.types.ts`
- `packages/memory-host-sdk/src/host/embeddings.ts`
- `src/types/node-llama-cpp.d.ts`
- `src/config/zod-schema.agent-runtime.ts`
- `src/config/schema.help.ts`
- `src/config/schema.labels.ts`
- `src/config/types.tools.ts`
- `docs/reference/memory-config.md`

Acceptance:

- Strict config accepts only the intended values.
- Runtime passes the selected GPU policy to `node-llama-cpp`.
- Docs explain the Apple Silicon CPU-only path and the performance tradeoff.
- Tests cover default behavior, CPU-only, Metal, and invalid config rejection.

### Phase 3: Worker Or Subprocess Isolation

Move local embedding execution out of the Gateway process.

Preferred shape:

- Gateway owns provider selection, config, timeouts, and memory fallback policy.
- A local embedding worker process owns `node-llama-cpp` import, model load,
  context creation, embedding calls, and cleanup.
- Gateway sends embed query and batch requests over a minimal JSON protocol.
- Worker exits or native aborts are reported as local provider failure.
- Memory search marks the local provider unhealthy with backoff instead of
  restart-looping the Gateway.

Likely files:

- `packages/memory-host-sdk/src/host/embeddings-worker.ts`
- `packages/memory-host-sdk/src/host/embeddings-worker-child.ts`
- `packages/memory-host-sdk/src/host/embeddings.ts`
- `extensions/memory-core/src/memory/manager-embedding-ops.ts`
- `extensions/memory-core/src/memory/provider-adapters.ts`

Acceptance:

- A simulated worker crash rejects the current request and keeps the parent
  process alive.
- Repeated worker crashes trigger backoff.
- `close()` terminates the worker cleanly.
- Request cancellation tears down or ignores in-flight worker work safely.
- Logs identify local embedding worker failures without printing secrets.

### Phase 4: Memory Degradation And Operator Feedback

Make repeated local embedding failures visible and non-fatal.

Behavior:

- `openclaw memory status --deep` should show local embeddings degraded or
  disabled after repeated worker crashes.
- Search should fall back according to configured memory fallback policy.
- No cloud fallback should happen unless the operator explicitly configured it.
- Error copy should recommend CPU-only local embeddings on Apple Silicon when
  Metal crashes are detected.

Files:

- `extensions/memory-core/src/memory/manager.ts`
- `extensions/memory-core/src/memory/manager-embedding-ops.ts`
- `src/commands/doctor-memory-search.ts`
- `src/cli` memory status code paths as needed

Acceptance:

- Status output distinguishes missing optional runtime, model load failure, and
  worker crash or abort.
- Tests cover degraded status and no accidental cloud fallback.

## Mac Proof Required

Final acceptance for #44202 requires Apple Silicon macOS proof. Linux source
tests are not enough because the reported failure is in `ggml-metal`.

Required real environment:

- Apple Silicon Mac.
- `node-llama-cpp` with the macOS arm64 Metal binary.
- The reported EmbeddingGemma GGUF model or equivalent small GGUF embedding
  model that exercises the Metal path.
- Local memory enabled with vector search.

Proof scenarios:

1. Baseline repro on current main or pre-fix branch:
   - Run local embedding query or memory indexing.
   - Trigger provider close, worker exit, or Gateway restart.
   - Capture the Metal abort or non-zero child exit when reproducible.
2. CPU-only policy after the fix:
   - Configure local embeddings with CPU-only policy.
   - Run index and search.
   - Restart or shut down the Gateway.
   - Confirm no Gateway crash.
3. Worker isolation after the fix:
   - Force the embedding worker to exit non-zero or abort in a test mode.
   - Confirm the Gateway stays alive.
   - Confirm memory status reports degraded local embeddings.
4. Metal policy after the fix:
   - Configure explicit Metal policy.
   - If native cleanup still aborts, confirm only the worker dies and the
     Gateway applies backoff.

## Local Test Plan

Use narrow local tests for implementation:

```sh
node scripts/run-vitest.mjs packages/memory-host-sdk/src/host/embeddings.test.ts
node scripts/run-vitest.mjs extensions/memory-core/src/memory/manager-embedding-ops.test.ts
node scripts/run-vitest.mjs src/commands/doctor-memory-search.test.ts
pnpm config:schema:check
pnpm config:docs:check
```

Before a fix branch is handed off or pushed for review, run the smallest changed
gate that covers the touched surface. Use Testbox or a macOS runner for broad or
platform-specific proof.

## Open Decisions

- Should Apple Silicon default to CPU-only for local embeddings, or should CPU
  remain an explicit operator choice?
- Should worker isolation ship before or after the config policy? The safest
  user-facing fix is worker isolation first, but the config policy is smaller.
- Should QMD use the same local embedding worker, or should it get a separate
  worker wrapper if its process model differs?
- What is the exact backoff policy after repeated worker crashes?

## Suggested Implementation Order

1. Serialize local `embedBatch`.
2. Add `memorySearch.local.gpu` config and node-llama-cpp option plumbing.
3. Add local embedding worker isolation.
4. Add memory degradation and status reporting.
5. Run Apple Silicon proof.
6. Update #44202 with exact commands, host class, result, and remaining gaps.
