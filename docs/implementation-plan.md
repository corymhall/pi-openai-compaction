# OpenAI remote compaction: review plan

Status: reviewed product design; implementation in progress. Operation-specific request clarification below supersedes earlier exact normal-request parity requirements. Isolated experiments and a successful ordinary AgentSession lifecycle are recorded in `feasibility-review.md` and `feasibility/`. The user accepts cancellation/persistence risks; supported hooks and normal Pi scheduling are the implementation approach, without mandatory host changes.

## Purpose and accepted scope

Build and maintain a focused extension for the user's legacy Pi ChatGPT/Codex login (`openai-codex`, `openai-codex-responses`). The user tested the new OpenAI login and found compaction unavailable, then confirmed the legacy login works. Do not support the new login, API keys, Azure, or gateways. Resolve credentials and the effective endpoint through Pi; never copy credentials between routes or persist them.

Accepted decisions:

- Match local Codex's whole-active-window remote V2 compaction, not Pi's older-prefix summarization.
- Keep Pi's manual `/compact` and automatic scheduling. Do not enable public API `context_management` compaction.
- Repeated compaction sends the previous replacement window plus subsequent effective conversation exactly once.
- Retain actual Pi user messages and images with Codex's approximate 64,000-token retention budget, newest first, chronological order restored afterward, and boundary truncation.
- Other Pi conversation kinds are sent into compaction but are not separately retained. Current system instructions and tool state remain supplied normally.
- Preserve the original transcript. Persist checkpoint state in branch-local `CompactionEntry.details`.
- Remote failure/cancellation installs no accepted replacement checkpoint and reports the outcome. No automatic native text-summary fallback. Host disk-write failures can leave memory ahead of disk; report the failure and advise stopping/reopening, without promising rollback.
- Autoresearch is unsupported. Disable this extension for autoresearch and use a separate session without an opaque checkpoint. No autoresearch mode detector or integration is planned.
- Upgrade the project's outdated Pi dependencies. No internal runner monkeypatch or general compatibility layer for arbitrary context-transforming extensions.

## Evidence and limitations

Primary reference: `~/github/codex`, commit `c0c230e6730b3b3c9101b8aff4b9aea4027cea5b`.

- `codex-rs/core/src/compact_remote_v2_attempt.rs`: reads active history, fits tool output to the context budget, prepares current instructions/tools, appends `compaction_trigger`.
- `compact_remote_v2.rs`: requires completion and exactly one compaction item, retains selected messages, installs replacement history.
- `compact_remote_v2_images.rs`: counts images and treats images/associated labels atomically during boundary truncation.
- `features/src/lib.rs`: image budgeting enabled by default; client developer-message retention disabled by default.
- `session/mod.rs`: advertises `remote_compaction_v2` in the beta-feature header.

Pi docs inspected: installed 1.0.4 `docs/extensions.md`, `docs/compaction.md`, `docs/session-format.md`, and `docs/message-types.md`. Published Pi 1.1.0 declarations/runtime were initially reviewed in temporary storage. Implementation pins aligned local development packages to 1.1.0 in `package.json`; host packages are wildcard peers. Tooling now uses handwritten configuration, TypeScript 7, Vitest and Oxc, without Projen or GitHub Actions.

Example repositories: `awoaCrim/pi-openai-toolkit` and `IgorWarzocha/howaboua-pi-stuff` informed persistence/replay design. `nedleeds/pi-compact-tools` is UI-only, not context compaction. If source is adapted, preserve applicable attribution/license notices. Official standalone `/responses/compact` output rules do not define this Codex V2 locally assembled replacement window.

No new credentialed requests were made during this planning pass. Legacy-login acceptance is user-reported evidence.

## Consistent example

```text
A -> remote compaction -> W1
W1 + B -> remote compaction -> W2
W2 + C -> normal continuation
```

`Wn` contains retained user-message copies plus a new opaque checkpoint. A and B remain in the original session log, but their covered copies are not independently sent again.

## Proposed implementation boundaries

Names below are illustrative internal responsibilities, not established Pi API names.

- `index`: register lifecycle handlers; decide compaction ownership; report outcomes.
- `projection`: read Pi's effective branch projection, identify source entries, resolve checkpoint coverage, remove covered duplicates.
- `checkpoint`: versioned JSON details, exact anchor, validation, branch-local resolution, identity checks.
- `codex-transport`: resolve legacy login via Pi, prepare request, collect raw events, validate completion; no tool execution.
- `retention`: source-aware user retention, approximate budgeting, text/image boundary handling.
- `replay`: splice checkpoint window into normal provider input without losing current prompt/tools or subsequent items.
- `usage`: map actual usage without double-counting cached/reasoning tokens or treating token counts as dollars.

Keep modules small; this is an ownership outline, not a requirement to create every listed file.

## Lifecycle pseudocode

```ts
async function onBeforeCompact(event, ctx) {
  // Resolve ownership before making a request.
  // Autoresearch is excluded by the user's extension/session setup.
  if (!usesSupportedLegacyLogin(ctx.model)) {
    // No inherited opaque checkpoint: leave unrelated sessions alone.
    // With one: unsafe continuation/conversion must not happen silently.
    return handleUnsupportedConsumer(ctx);
  }

  try {
    const prepared = prepareActiveWindow(ctx);
    const connection = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    requireSupportedConnection(connection);
    const result = await requestRemoteV2(prepared, connection, event.signal);
    const window = retainUserMessages(prepared.items, 64_000).concat(result.checkpoint);

    require(!event.signal.aborted);
    requireSnapshotStillApplicable(ctx, prepared);
    return {
      compaction: {
        summary: prepared.uniqueDisplayAnchor,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: makeCheckpointDetails(prepared, window, result),
        usage: mapUsage(result.usage),
      },
    };
  } catch (error) {
    reportWithoutSecrets(error);
    return { cancel: true }; // Never undefined on an owned failed attempt.
  }
}
```

Pi owns writing the new entry; preparing or receiving an incomplete checkpoint does not append a replacement. Returning a result or observing it in `getBranch()` is not durable-write proof: Pi can advance in-memory state before a failed disk append. Reconstruct from the active branch during ordinary operation; on persistence failure report the error and advise stopping/reopening from disk. Transactional rollback and perfect durability are not promised.

### Prepare active window

```ts
function prepareActiveWindow(ctx) {
  const projection = ctx.sessionManager.buildSessionProjection();
  const branch = ctx.sessionManager.getBranch();
  const checkpoint = resolveLatestEffectiveCheckpoint(branch);
  // Three outcomes: absent, valid, invalid/unsupported.
  // Invalid owned checkpoints must never become ordinary placeholder context.
  if (checkpoint.kind === 'invalid') fail(checkpoint.reason);

  const items =
    checkpoint.kind === 'valid'
      ? [
          ...checkpoint.entry.details.classifiedReplacementWindow,
          ...serializeProjectedTail(projection, checkpoint.entry.details.coverage),
        ]
      : serializeEffectiveProjection(projection);

  // Use Pi's actual Codex history serializer and current effective instructions.
  // Synthetic compaction is a separate operation, not the normal request pipeline.
  // Don't serialize checkpoint display text as history.
  const fitted = fitRequestWithoutMutatingSession(items);
  return snapshotBranchCoverageAndCurrentRequestState(ctx, fitted);
}
```

Use source entries and branch order, not lexicographic ID comparisons. Ordinary Pi summaries are legitimate effective context on first remote compaction. Do not reconstruct older omitted history from the raw log. Read only the latest effective compaction; a newer native summary supersedes old remote checkpoints.

### Request and response

```ts
request = {
  model: currentModel.id,
  instructions: currentInstructions,
  tools: currentToolDeclarations,
  parallel_tool_calls: true,
  store: false,
  stream: true,
  input: [...preparedInput, { type: 'compaction_trigger' }],
  // Use current supported reasoning. Synthetic Fast/service-tier parity is optional.
};
headers = mergeExistingBetaFeaturesWith('remote_compaction_v2');

for await (const event of remoteStream) {
  if (isFailure(event)) fail();
  if (isDoneCompactionItem(event)) checkpoints.push(event.item);
  if (isCompletedResponse(event)) {
    require(checkpoints.length === 1);
    require(nonEmptyString(checkpoints[0].encrypted_content));
    return { checkpoint: checkpoints[0], responseId, usage };
  }
}
fail('stream ended before completion');
```

Preserve opaque checkpoint structured fields. Additional output items do not become actions or retained assistant replies. Aborted operations cannot install an accepted checkpoint. Compaction makes one application-level attempt, using per-call `transport: "sse"` and `maxRetries: 0` to avoid adapter WebSocket continuation retries and fallback outside the SSE retry loop. Bound the entire operation with an abort-signal deadline; SSE `timeoutMs` alone only bounds response-header acquisition. The initial configurable deadline is five minutes, unvalidated; revise it from measured user-authorized legacy-login acceptance rather than claiming a measured default. No automatic compaction retries; normal Pi overflow recovery remains allowed. Raw event capture must be scoped to the synthetic operation, not unrelated main-model traffic.

### Retention

```ts
candidates = classifiedInput.filter((item) => item.sourceKind === 'user');
retained = walkNewestFirstWithinApproximateBudget(candidates, 64_000);
replacement = [...restoreChronologicalOrder(retained), newCheckpoint];
```

Preserve classifications for retained users from an earlier replacement window. Do not infer actual users solely from Responses `role: user`: Pi's custom, shell, branch-summary and compaction-summary messages also serialize into that role. Truncate only replacement copies. Count images using a Codex-aligned estimate, not base64 character length or a claim of exact server tokens. Port relevant image atomicity and text middle-truncation behavior; omit Codex-only agent/hook/developer retention machinery that Pi does not provide.

### Persistence and replay

Details should carry version/type, complete replacement window with retention provenance, coverage boundary, producer/consumer endpoint and account compatibility identity without credentials, response ID, and available usage. Final field names are an implementation detail. Fork compatibility must follow inherited branch evidence rather than rejecting a checkpoint simply because the session ID changed.

```ts
onContext(messages, ctx) {
  const checkpoint = latestEffectiveCheckpointOnCurrentBranch(ctx);
  if (!checkpoint) return;
  // Verify projection/source correspondence before removing copies.
  return removeCoveredCopiesButKeepExactAnchorAndSystemState(messages, checkpoint);
}

onProviderRequest(payload, ctx) {
  const checkpoint = latestEffectiveCheckpointOnCurrentBranch(ctx);
  if (!checkpoint) return;
  requireCompatibleConsumer(checkpoint, ctx);
  return replaceExactAnchorWithCompleteWindow(payload, checkpoint);
}
```

Keep Pi's supplied `firstKeptEntryId`; remove its covered retained copies in request-time projection. Pi 1.1.0's session manager accepts `null` for retain-none, but `CompactionResult` still declares a string: do not bypass types or invent future IDs. Verify that source-aware filtering preserves system/tool state and transient subsequent input.

## Authoritative v1 safety and compatibility contracts

These contracts incorporate the accepted decisions from `feasibility-review.md` and govern implementation:

- **Producing-model-only consumption.** Initially, only the model that produced a checkpoint may consume it. Effective endpoint and account compatibility are also required. Cross-model use needs separate validation/design; no implicit conversion.
- **Transitive sealed-history coverage.** Each new checkpoint preserves coverage/provenance of history sealed by earlier checkpoints, not merely retained user-message IDs. Later edits to sealed history block replay and recursive compaction; edits confined to the live tail remain supported. Recover by navigating before the affected checkpoint or starting a new session.
- **Three-way resolution.** Resolve the latest effective checkpoint as absent, valid, or invalid/unsupported. A newer ordinary Pi summary supersedes remote replay, but malformed or unsupported owned details must not silently fall through as ordinary context. Apply this rule to preparation, projection, and provider replay.
- **Restricted request fitting.** Rewrite only eligible trailing tool outputs following pinned Codex rules; preserve encrypted outputs, calls and pairing, and stop at the noneligible boundary. If the request still exceeds its applicable budget, fail. Never truncate oversized user input or opaque checkpoints to force fitting. Account for instructions/tools and separate byte/image constraints.
- **Missing-extension warning and recovery.** The persisted display anchor warns that this session requires the extension and is not a portable summary. When unloaded, the extension cannot block requests. Document recovery by re-enabling it or navigating before the checkpoint/starting a new session; disabling it does not convert encrypted history.
- **Accepted host limitations.** Cancellation is best effort; disk-write failure is not success and may leave in-memory state ahead of disk. Report failure and advise stopping/reopening, without claiming zero transmission, transactional rollback, or authoritative initial opaque-context sizing.

## Integration checks that must be resolved before the relevant code is built

1. **Best-effort cancellation.** Pi catches provider payload-hook exceptions and cached WebSockets can transmit after cancellation. The user accepts this risk. Request cancellation and report the failure; never treat an aborted checkpoint as success. Don't claim zero transmission. An owned failed compaction still returns cancellation rather than falling through to native summary generation.
2. **Raw event capture.** Pi 1.1.0 supports per-call `onProviderStreamEvent`; the completed local-server experiment captured raw `response.incomplete`. Use this seam instead of a global observer or custom SSE adapter, with explicit raw terminal validation and operation isolation.
3. **Autoresearch exclusion.** No mode-query integration. Document that autoresearch must use a separate session with this extension disabled. Disabling this extension does not convert an existing checkpoint into readable history.
4. **Budget accounting.** Use normal Pi scheduling and reported provider usage. The real AgentSession lifecycle passed immediate reopen without fresh usage, first continuation, tool turns, automatic threshold compaction and another reopen. Synthetic predicate fixtures still show estimate mismatch in paths without a valid usage baseline. Test large incoming input, context edits and error/overflow recovery during implementation; don't require a host accounting override before starting. Never report ciphertext length or compaction-call usage as the replacement-window size. Add stale-coverage guards only where behavioral tests justify them.
5. **Navigation/model changes.** Basic resume/fork/tree continuation must resolve the current branch. A textual tree summary that crosses an opaque checkpoint, an unsupported consumer, or an account change cannot silently lose checkpoint state. Exact UX/guard for these transitions remains reviewable, with no implicit portable-summary conversion.
6. **Manual custom instructions.** Reject nonempty custom `/compact` guidance before making a paid request. Explain that V2 uses current instructions; do not silently ignore or inject summary guidance.
7. **Project baseline/package entry.** Pin aligned Pi packages to a validated baseline (1.1.0 inspected). Edit dependency/package metadata directly in `package.json`. Verify Pi package extension entry, peer/runtime dependencies and packaging; the manifest declares the source extension entry and packages both source and ESM output.
8. **Legacy prototype details.** Existing prototype uses a different standalone-output schema. Do not interpret it as V2 or migrate it silently. Decide explicit rejection/upgrade message if encountered; original session remains intact.

## Build order after approval

1. Upgrade and validate Pi/package baseline; establish raw stream, cancellation, ownership and accounting seams.
2. Implement versioned checkpoint validation and effective projection/coverage.
3. Implement verified legacy Codex V2 request/collection and usage mapping.
4. Implement source-aware retention, request fitting and replay.
5. Integrate lifecycle/failure reporting, branch recovery and unsafe-transition guards; document autoresearch exclusion.
6. Validate mocked-wire and real-Pi lifecycle behavior, then run a small user-authorized credentialed acceptance against legacy login.
7. Update README and packaging with supported connection, limits and recovery behavior. No publish/commit unless requested.

## Required behavioral validation

- First compaction, continuation, second compaction: prior checkpoint and live conversation included once, previous display anchor never sent.
- Retained actual users versus custom/shell/summary wire users; approximate budget boundary, Unicode truncation, image-only/mixed content and image atomicity.
- Tool call/result IDs, reasoning signatures and current/deferred tool loadout survive projection and serialization.
- Disk-backed persistence/reopen, fork and branch navigation; newer ordinary compaction supersedes older remote checkpoint.
- Missing anchor, identity mismatch and invalid coverage request cancellation and report an error; verify no checkpoint success is accepted. Cached-WebSocket transmission despite cancellation is an explicitly accepted host risk, not a zero-transmission guarantee.
- Error/EOF/missing checkpoint/multiple checkpoints/empty encrypted content/cancellation accept no replacement checkpoint and invoke no fallback summary. Test disk-write failure separately: report failure and recovery advice without treating in-memory presence as durable success.
- Synthetic compaction uses SSE, one attempt, disabled retries and an abort-signal deadline covering the whole stream; normal-session transport and overflow recovery remain unchanged.
- Transitive sealed-history edits, invalid versions and producing-model/account/endpoint mismatches are rejected; live-tail edits remain supported.
- Restricted fitting preserves encrypted outputs and call pairing, stops at the eligible suffix boundary, and fails rather than truncating user input/checkpoints.
- Document and verify the supported configuration excludes autoresearch; never suggest disabling the extension converts an existing opaque session.
- Synthetic compaction uses current effective instructions and actual Pi Codex history serialization, never authoritative cached payload options. Synthetic Fast/service tier is optional; normal continuation preserves Pi's actual prepared prompt/tools and service tier.
- Automatic threshold/overflow behavior uses actual reported usage where available and doesn't compact-loop; test unknown-usage and edited-context paths explicitly. Initial opaque-context sizing is an acknowledged estimate limitation.
- Usage cached input/reasoning not counted twice; monetary costs not fabricated from token counts.
- Packaging loads through Pi in interactive and headless modes; no credentials or opaque checkpoint bodies emitted in normal diagnostics.

The existing lifecycle fixture establishes that Pi hooks, reopening and ordinary usage-driven scheduling compose; it does not prove a nested V2 request, complete recursive `W1 + live tail`, source-provenance matching, or real serializer parity. Keep its simplified matching experimental.

Before promoting feasibility fixtures into regressions, assert expected ordered user sequences (including legitimate repeated text), checkpoint identity and position, marker absence anywhere in the payload, successful terminal compaction events (`aborted` and result presence), usage transitions, request counts and the final reopen request. Replace the fixed delivery delay with an observed server-message condition and bounded timeout; assert connection-reuse counters and aborted stop reasons.

Use meaningful tests around these contracts, not assertions that duplicate constants or mirror helpers. Run the required checks once they pass; broaden only for changes, failures or unresolved concerns.

## Operation-specific request clarification

The user clarified that compaction is a separate operation from normal inference. Exact prepared descriptions, hidden declarations and Fast-mode latency/service-tier parity are not demonstrated compaction-correctness prerequisites. The source sends model-visible tools in nonincremental mode and empty tools/base instructions in incremental mode; this is evidence of Codex client behavior, not proof that arbitrary omitted/alternate declarations are accepted by the backend.

Implement a synthetic operation using supported provider streaming APIs, the actual Codex serializer, current `ctx.getSystemPrompt()` instructions, current transcript-declared tools and current reasoning. Omit synthetic service-tier overrides; do not cache prior payloads as current state or replay private runner hooks. Whether the operation-specific declarations work with the legacy backend remains live acceptance, not something mocks can establish. Accurate tool calls/results, reasoning/images, recursive opaque continuity and complete effective live tail remain essential. Normal continuation must leave Pi's supplied prepared tools, prompt and transport unchanged.

## Review gate

This plan records accepted product behavior and names unresolved API seams explicitly. Approval permits starting implementation, not silently changing the accepted behavior to work around a missing seam. If a listed seam requires a Pi patch, different retention semantics, native-summary conversion, or broader authentication support, return for review first.
