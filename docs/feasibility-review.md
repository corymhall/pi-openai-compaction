# Feasibility review — Pi 1.1.0

Status: source/API inspection plus completed isolated Pi 1.1.0 runtime experiments and a successful ordinary AgentSession lifecycle. Proceed through supported hooks under the accepted personal-plugin limitations; no mandatory host fixes. These are feasibility evidence, not full plugin or live Codex acceptance. Plugin implementation has not started.

## Completed runtime results

Reproducible fixture and instructions: `docs/feasibility/experiments.mjs` and `docs/feasibility/README.md`. Recorded output: `docs/feasibility/results.json`. Ran successfully with Node 26.7.0 and isolated published Pi 1.1.0 dependencies.

- Cached WebSocket: warm successful connection, then cancellation inside `onPayload`. Despite cancellation, the client invoked `socket.send` once and the local server received one request. Debug counters confirmed one created and one reused connection. The eventual normalized result was aborted.
- SSE control: cancellation inside `onPayload` resulted in zero fetch calls.
- Accounting, disk-backed/reopened fixtures: actual host scheduler predicate saw 3,009 canonical tokens and requested compaction when the replacement retained-user text estimated only 5; another fixture saw 12 canonical tokens and declined compaction while retained-user text alone estimated 3,000. Threshold was 800. These numbers exclude unknown encrypted checkpoint tokens. They prove predicate mismatch, not a full-loop simulation.
- Persistence: actual disk append failed with EISDIR. The in-memory branch advanced to a compaction entry while reopening the pre-failure disk file showed no compaction.
- Per-call raw stream observer captured `response.incomplete` for a synthetic incomplete response. That fixture also normalized to an error. Raw terminal validation remains necessary.

No credentials or remote OpenAI calls were involved. These experiments establish limits on cancellation guarantees, canonical estimates and in-memory presence as write proof. They do not require a host fork under the user's accepted scope.

## Completed ordinary AgentSession lifecycle

`docs/feasibility/lifecycle.mjs` runs through real Pi session creation and extension binding with a synthetic model (2,000-token context window, 500 reserve), fake checkpoint-producing compaction hook, replay/projection hooks and a real synthetic tool. It completed 8 normal inference calls, 3 tool executions, 1 manual compaction and 1 threshold-triggered automatic compaction.

It reopened immediately after manual compaction, before fresh usage. Context usage remained unknown. The first continuation reported 500 tokens; tool turns reported 600, 900 and 1,700, causing exactly one automatic compaction at the 1,500 threshold. The next response reported 500; reopening again and continuing reported 600. Replay used the latest checkpoint exactly once and user messages weren't duplicated. No redundant-compaction guard was needed in this successful baseline.

This corrects the earlier broad conclusion: canonical estimate mismatches exist, but fresh provider usage supplies the ordinary scheduling baseline. The original predicate fixtures were adversarial representations, not demonstrations of a broken ordinary session. Error/edit/overflow paths and large newly appended inputs still require tests during implementation.

## Review disposition

The independent review correctly identified host integration risks, but treating all of them as mandatory host-fix blockers was too strong for this personal plugin. The user accepts the cached-WebSocket cancellation race and rare persistence failures. Supported extension hooks are the intended integration mechanism. The completed ordinary AgentSession lifecycle below supports proceeding without requiring a Pi fork; limitations remain explicit rather than claiming perfect accounting.

### Request blocking: confirmed source-level risk

Inspected published `@earendil-works/pi-coding-agent@1.1.0` and `@earendil-works/pi-ai@1.1.0` in temporary storage, without modifying repository dependencies.

- `core/extensions/runner.js`, `emitBeforeProviderRequest`: catches payload-handler errors and returns the prior payload. A throw does not veto transmission.
- `api/openai-codex-responses.js`, `processWebSocketStream`: calls `socket.send()` before the parser checks the operation abort signal. The cached-socket path therefore needs a guard at the send boundary, not merely eventual cancellation.
- The SSE retry loop checks cancellation before fetching. This is promising but is not sufficient evidence for a transport-independent guarantee.

Superseded prerequisite: zero upstream requests on every transport and a mandatory host veto fix are not required under the accepted personal-plugin scope. `ctx.abort()` plus a thrown payload-hook error does not establish zero transmission.

The focused local-server experiment confirmed the cached-WebSocket race. Use supported best-effort cancellation, report unsafe replay and accept no aborted checkpoint as success. For synthetic compaction use explicit SSE with disabled retries; ordinary-session transport is unchanged. A host veto improvement is optional, not a gate.

### Context accounting: confirmed representation mismatch

`agent-session.js` recomputes post-compaction message estimates from `sessionManager.buildSessionProjection().messages`. Those messages contain our display anchor and Pi-retained copies, not the replacement window used after provider rewriting. Returning `estimatedTokensAfter` does not change this computation.

The same runtime uses projected estimates when context edits exist, including recovery edits. Fresh provider usage can help some paths, but does not solve every pre-usage or edited-context path. The compaction request's usage is accounting for the compaction operation, not an authoritative token count for the replacement window.

No public extension accounting override was established by this inspection. Do not fabricate assistant usage, pad the anchor with fake text, treat ciphertext length as token count, or report zero after compaction.

The disk-backed predicate fixtures confirmed estimation mismatch, but the completed ordinary AgentSession lifecycle supports normal Pi scheduling with fresh reported usage. No host accounting API is required before implementation. Initial opaque-context sizing remains an acknowledged limitation. Test large incoming input, edited/invalidated usage and error/overflow recovery during implementation; add a redundant-compaction guard only for a demonstrated behavioral failure. An optional host accounting improvement is not a prerequisite.

### Raw events: supported interface found

`StreamOptions.onProviderStreamEvent(data, model)` is a per-call public observer in Pi 1.1.0. The Codex adapter calls it in `mapCodexEvents` before normalization for SSE and WebSockets. This is the preferred candidate; do not start with a custom SSE adapter.

Correction to the earlier inspection: the Codex adapter catches observer errors and rethrows a `ProviderStreamEventCallbackError`, rather than simply suppressing them. Prefer recording protocol evidence and validating the terminal result; do not confuse this observer with payload-hook veto behavior. Validate the raw terminal event independently of normalized `done`; `response.incomplete` must not qualify. Prove this with synthetic per-call streams and operation isolation before using it with credentials.

## Conservative v1 contracts

These tighten the design following user approval of the review response:

- Autoresearch is unsupported; use a separate session with this extension disabled. No dynamic ownership integration.
- No text fallback or automatic compaction retries. One application-level attempt with a bounded whole-operation abort-signal deadline. Use per-call `transport: "sse"` and `maxRetries: 0`: WebSocket continuation/connection-limit retries and pre-stream fallback occur outside the SSE retry loop. `timeoutMs` alone only bounds SSE response-header acquisition. Ordinary-session transport and normal Pi overflow recovery remain unchanged. Select the deadline from measured successful legacy-login behavior; do not invent an acceptance result.
- Reject custom `/compact` instructions before sending.
- Only the producing model may consume the checkpoint initially. Endpoint/account compatibility still applies. Cross-model transitions require separate validation/design, including smaller context windows.
- Later edits to sealed history block replay and recursive compaction; edits confined to the live tail remain supported. Persist transitive coverage/provenance across checkpoints, not just retained user IDs. Recover by navigating before the checkpoint or starting a new session.
- Request fitting rewrites only eligible trailing tool outputs following pinned Codex rules. Preserve encrypted outputs, calls and pairing; stop at the noneligible boundary. If the request still exceeds the applicable budget, fail. Do not truncate oversized user input or opaque checkpoints to force fitting. Include instructions/tools in budget reasoning and treat byte/image constraints separately.
- Checkpoint resolution distinguishes absent, valid, and invalid/unsupported. The latter never silently falls through as ordinary context.
- The persisted display anchor warns that the session requires this extension and is not a portable summary. If the extension is unloaded, it cannot enforce blocking; document this unavoidable limitation and recovery instructions.
- Persistence failure is an error, not success. A callback or `getBranch()` observation is not durable-write proof. Pi 1.1.0 `SessionManager._appendEntry` updates memory before `_persist`, so append failure can leave memory ahead of disk. The user accepts this host risk: report the failure and advise stopping/reopening. Transactional append, mandatory fail-stop and supported rollback are not implementation prerequisites; do not promise them.
- Canonical projection is the supported input source. Arbitrary request-time redaction/history-transform extensions are unsupported; disclose this rather than replaying their hooks privately.

## Current implementation gate

The user accepts occasional transmission despite cancellation and the host persistence-failure risk; host fixes are not prerequisites. Report errors and never accept an aborted checkpoint as a success. On a disk-write failure advise stopping/reopening rather than promising rollback.

The successful baseline lifecycle and per-call raw event experiment are sufficient to proceed with the supported-hook design. Keep tests for newly appended large context, missing fresh usage, context edits, overflow/error recovery, and duplicate checkpoint preparation in the implementation checklist. Add a redundant-compaction guard only against demonstrated stale/unchanged coverage; do not suppress a genuinely full live window blindly.

No exact initial encrypted-window token estimate is promised. Don't fabricate usage or pretend the compaction operation's usage is the replacement-window size. A Pi accounting API improvement remains optional, not a precondition for this user's plugin.

## Work performed

Added documentation and reproducible experiment artifacts only. Dependencies were installed in `/tmp/pi-compaction-api-review`, not this repository. No project dependency upgrade, plugin code, credential inspection, live OpenAI inference request, commit, or publish. The isolated experiments completed; full plugin/live Codex acceptance remains pending. Host fixes are optional improvements, not pending prerequisites.
