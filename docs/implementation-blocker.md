# Request-state seam reassessment

The prior stop was based on an over-specified normal-request parity contract. The user clarified that synthetic compaction is a separate operation: differences in prepared descriptions, hidden tool declarations and Fast/service tier alone are **not demonstrated compaction-correctness blockers**. Implementation resumed without a host patch, private runner calls or cached payload state.

## Evidence versus assumptions

The Pi 1.1.0 seam fixture (`test/request-state.test.mjs`) correctly demonstrates that ordinary AgentSession requests apply private loadout projections and payload hooks which nested registry/provider streams do not apply. It does **not** show that compaction needs those same projections or that an alternate declaration set is backend-supported.

Pinned Codex reference: `c0c230e6730b3b3c9101b8aff4b9aea4027cea5b` in `~/github/codex`:

- `compact_remote_v2_attempt.rs` reads the active annotated history, fits eligible trailing tool outputs, and appends `compaction_trigger`.
- It supplies router-visible tools/base instructions in the nonincremental path and empty top-level tools/base instructions in the incremental path. This is client behavior, not an independent specification of all backend-accepted field combinations.
- `compact_remote_v2.rs` requires a completed terminal response and exactly one compaction output item; it assembles replacement history locally from retained users and the new opaque item.
- `compact_remote_v2_images.rs` budgets images and keeps image/label groups atomic at the retention boundary.

Required correctness remains accurate effective history and provenance, serialized tool-call/result pairing and reasoning/images, complete recursive checkpoint/live-tail input, current effective instructions, raw terminal validation and correct replay. Normal continuation must preserve Pi's supplied prepared tools, prompt, options and transport.

## Operation-specific implementation

Synthetic requests use the supported provider `streamSimple` seam and Pi's actual legacy Codex adapter. A per-call `onPayload` receives the actual serialized input and tools; source classifications are attached by ordered, content-validated user occurrences. Previous replacement windows are expanded there, once, before appending the trigger. Current instructions come from `ctx.getSystemPrompt()`, reasoning from Pi's current thinking level, and tool declarations from the effective transcript's system state. No prior payload is authoritative state.

Transcript system/tool deltas are preserved so the actual adapter can serialize historical calls to removed grammar tools. Ordinary pruning runs in `context_with_system`, not conversation-only `context`: Pi's latter phase restores a single current head when conversation changes, losing historical grammar declarations. The full-transcript phase keeps the supplied leading prompt and deltas while leaving later Pi prepared/hidden declarations and forced-prompt projections untouched. Synthetic conversion and retained-window replay honor the effective `images.blockImages` policy from public `pi.getSettings()`; saved plaintext copies can be filtered, but existing opaque checkpoint knowledge cannot be selectively erased. Only this operation's current instructions are overridden in `onPayload`. The pinned `codex-api/src/sse/responses.rs` accepts `response.completed` with `response.id` and optional usage, without a required `status` field; raw validation follows that minimum and rejects an explicitly noncompleted status, failures and incomplete events.

V2 capability is advertised through the public normal header hook before the first checkpoint, as well as on synthetic requests. Pi 1.1.0 retains cached WebSocket handshake headers; loading/reloading after a connection was opened cannot retrofit its capability header. Restart Pi before consuming inherited opaque history in that situation. No cache internals or normal transport are changed. Live WebSocket acceptance remains unverified.

Synthetic service tier is omitted. This is not a latency acceptance claim. The operation uses SSE, `maxRetries: 0`, one application attempt and a bounded whole-operation abort deadline. The initial default is **300000 ms (five minutes), unvalidated**, configurable by `--openai-compaction-deadline-ms` between 1000 and 1800000 ms. The independent local wire-byte guard is 20 MiB, a conservative safety policy rather than a verified backend maximum.

The extension imports only host-mapped package roots at runtime, avoiding the prototype's subpath alias failure. Its own compiled output is ESM; package discovery still loads the source factory through Pi. Versioned checkpoint details replace the incompatible standalone prototype schema; old owned entries are explicitly rejected rather than converted.

## Remaining acceptance

Local tests can establish serializer/provenance and lifecycle behavior, not backend acceptance of operation-specific declarations, encrypted recursive history or latency. Legacy-login acceptance still requires explicit user authorization for paid requests. No live request, credential-file inspection, host patch, global-setting change, commit or publication was performed.

Best-effort cancellation, cached-WebSocket transmission races on ordinary continuation, host write failures leaving memory ahead of disk, and unknown initial opaque-context sizing remain accepted limitations. None requires a host fork. Arbitrary context-transforming extensions and autoresearch remain unsupported; autoresearch requires a separate session with this extension disabled and no inherited opaque checkpoint.
