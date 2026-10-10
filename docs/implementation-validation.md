# Local implementation validation

## Scope

Validated against exactly Pi 1.1.0 (`pi-ai`, `pi-agent-core`, `pi-coding-agent`) on Node 26.7.0. Published host peers and npm root lockfile peers are `*`; development dependencies remain exactly 1.1.0. The Codex reference is `c0c230e6730b3b3c9101b8aff4b9aea4027cea5b`.

All model requests used a local HTTP/SSE server and synthetic credentials. Tests use actual Pi AgentSession lifecycle, session files, package discovery and the native Codex serializer/adapter. No live inference, credential-file inspection, Pi-internal patch, global-setting change, commit or publication was performed.

## Verified behavior

- First and recursive whole-window V2 requests, structured opaque-field preservation and exactly-once replacement-window/live-tail replay.
- Repeated actual users are retained separately; wire-user custom, shell and branch-summary contributions are not mistaken for actual users.
- Images, encrypted reasoning and historical removed grammar tools serialize through the actual adapter; call/result IDs remain paired. Synthetic output tools are not executed.
- Ordinary continuation retains actual prepared descriptions/hidden declarations, current forced prompt and service tier. Full-transcript `context_with_system` pruning preserves the leading prompt and live-tail grammar-tool add/call/remove deltas. Real normal-request controls verify `custom_tool_call`, original `ctc_history` item ID, raw grammar input and paired output after a checkpoint, with a duplicate transient contribution; recursive compaction includes that history once and subsequent continuation does not restore sealed calls. Pi's own forced-prompt projection remains unchanged. Synthetic instructions use the current public prompt API, not a saved prior forced prompt.
- Effective image blocking uses public `pi.getSettings()` and matches Pi 1.1.0's SDK text placeholders/deduplication for synthetic users and tool results. Local-server requests verify zero images with blocking enabled initially, on continuation, and after policy changes/reopen with an older image-containing window. Request-local filtering leaves that saved window unchanged; recursive compaction persists filtered copies with original provenance, never restoring covered images when blocking is later disabled.
- V2 capability is advertised before the first checkpoint and merges applicable headers. Normal transport is not overridden.
- Disk-backed reopen and inherited forks; newer ordinary summaries supersede older remote checkpoints. This is not crash-durability or transactional-rollback proof.
- Live-tail edits work; sealed-history edits, incompatible identities, malformed/unsupported checkpoint state and unsafe tree summaries are rejected.
- Actual automatic threshold and overflow compact/retry scheduling.
- Raw completion validation, including the pinned client's minimal completed terminal without status metadata. EOF, incomplete/error streams, empty or multiple checkpoints and a local HTTP 503 are rejected without native fallback or another synthetic attempt.
- Parent cancellation and whole-operation deadlines, including pending connection lookup and a stalled stream. An already-cancelled race still observes a late operation rejection; Vitest treats unhandled rejections as test-run failures. Application attempts and provider retries remain bounded.
- Approximate newest-first user retention, Unicode truncation, atomic image/label groups, no older-user backfill, eligible trailing-tool-output fitting and the independent wire-byte guard. Opaque checkpoint metadata is not a plaintext token estimate.
- Available usage mapping without double-counting cache or reasoning; cost fields are unpriced, not a free-operation claim. Initial replacement-context sizing remains unknown.
- Append-failure reporting acknowledges memory/disk divergence; preparation/reporting failures do not fall through to native compaction.
- Actual source-factory loading and session binding in print and TUI modes without inference; this is not a visual terminal acceptance test.

## Checks

Passed `npm run check` (TypeScript 7 typechecking, oxlint, oxfmt and Vitest), a clean `npm ci --ignore-scripts`, `npm run test:coverage`, and `npm pack --dry-run` (including the TypeScript build). All 12 tests passed; V8 reported 79.02% source line coverage. Configuration is handwritten; there is no synthesis step or GitHub Actions automation.

The package dry-run contains 19 files: all five TypeScript source modules, compiled runtime/declarations, the manifest, README, license and NOTICE. The root manifest declares ESM; a generated `lib/package.json` marker is no longer needed. Internal `docs/` and `test/` artifacts are excluded without deleting them from the repository. Manifest and npm root lockfile host peers are verified as `*`; all three installed development Pi packages are 1.1.0.

The supplemental review repro was also rerun with strict unhandled-rejection handling: blocked images were **0 before compaction / 0 synthetic / 0 after compaction**, and checkpoint continuation's grammar call/output matched the no-checkpoint control, including original item ID `ctc_history`.

Vitest runs named cases directly against source, with fresh lifecycle fixtures per case and no subprocess wrapper. `npm run test:coverage` measures source coverage through V8. The request-state seam investigation is now included in the ordinary test suite; earlier `docs/feasibility/` experiments remain historical artifacts.

## Still unverified

Live legacy-login backend acceptance of operation-specific declarations, recursive encrypted requests, normal/cached-WebSocket continuation, fork continuity and latency requires explicit authorization for paid requests. Client-source evidence and local mocks are not backend acceptance.

The five-minute whole-operation default and 20 MiB local wire guard are unvalidated policies, not measured backend limits. Cached WebSocket handshake headers cannot be retrofitted by loading/reloading the extension; restart Pi first in that situation. Best-effort cancellation/transmission races, host write divergence, unsupported arbitrary history transforms and autoresearch exclusions remain documented limitations.

Image blocking filters explicit plaintext images, not opaque checkpoint knowledge. Tests verify that existing ciphertext is carried unchanged; they cannot demonstrate selective forgetting of previously sealed images. Start a new session without inherited opaque history for a clean context.

The tooling migration's installation reported zero dependency vulnerabilities. Installation used `--ignore-scripts`; no automatic audit remediation was applied.
