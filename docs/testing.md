# Testing and acceptance

## Local checks

Use the scripts in `package.json` as the authority:

```sh
npm ci --ignore-scripts
npm run check          # typecheck, oxlint, oxfmt check, Vitest
npm run build          # ESM JS/declarations in lib/
npm pack --dry-run     # invokes prepack/build; no publishing
```

For iteration:

```sh
npm test
npm run test:watch
npm run test:coverage  # V8 source coverage
npm run format        # applies formatting; inspect the resulting diff
```

Do not approve install scripts or run audit remediation automatically. Long builds/test runs should use the session's managed command interface; confirm completion before reporting success.

## Test responsibilities

| File                          | Purpose                                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/behavior.test.mjs`      | Actual Pi sessions and Codex serializer/SSE adapter against a local HTTP server; isolated cases cover checkpoint lifecycle and safety behavior. |
| `test/request-state.test.mjs` | Normal prepared loadout/request hooks versus operation-specific nested request behavior.                                                        |
| `vitest.config.ts`            | Test execution and coverage configuration.                                                                                                      |

Tests execute directly against source with synthetic credentials and temporary session files. They do not need a prior build or paid inference. Never replace these paths with a mocked helper that merely mirrors implementation. Use source-level unit tests for algorithm boundaries where useful, and real Pi/local-wire tests for lifecycle claims.

Essential regressions include:

- First compaction, continuation, repeated compaction, immediate reopen and fork continuation.
- Ordered repeated actual users versus custom/shell/summary wire users; exact checkpoint identity/position and absence of every display marker from outgoing history.
- Complete live tail, paired tool IDs, encrypted reasoning, removed grammar-tool declarations, prepared hidden tools and current forced instructions.
- Image blocking initially and after policy changes/reopen, including tool results and prior retained windows; ciphertext carried unchanged.
- User-retention boundaries, Unicode, atomic image/labels and no older-user backfill; restricted fitting and independent wire-byte guard.
- Invalid/unsupported details, missing/duplicate anchors, sealed edits, valid live-tail edits, model/account/endpoint mismatch and conservative tree-summary rejection.
- Raw completed/minimal terminal shapes, incomplete/error/EOF/HTTP failures, invalid checkpoint counts/content, operation isolation and nonexecution of synthetic tools.
- One attempt, no native text fallback, parent cancellation, auth/stream deadlines and late rejection observation.
- Usage mapping, normal automatic threshold/overflow recovery and no ineffective immediate compaction loop.
- Host append failure reporting without treating in-memory state as disk durability.
- Source-factory discovery/session binding in print/TUI modes and built package content. Module loading is not visual TUI acceptance.

Coverage is a diagnostic, not proof of protocol correctness. Report the current run's results rather than keeping fixed counts/percentages as permanent guarantees. Test names should identify behavior so failures are actionable.

## Pi or protocol upgrades

Run the suite against the proposed aligned Pi baseline. Inspect the actual host serialization and callback behavior using [upstream sources](upstream-sources.md). Give special attention to full-transcript handler ordering, dynamic tools, image placeholders, per-call raw events, cache headers, retry paths, source-factory loading and persisted schema compatibility. Keep existing saved checkpoints readable or explicitly reject incompatible versions with recovery guidance; no silent reinterpretation.

## Authorized live acceptance

Live backend acceptance of the current implementation is still pending. Local success cannot prove server acceptance of declarations, encrypted recursion or WebSocket continuity.

Ask the user before any real inference, including subscription-backed requests. Use a disposable session/project and Pi's supported legacy login; do not read auth files, print tokens or alter global settings. Agree on the producing model, request budget and transport coverage beforehand.

Suggested acceptance sequence:

1. Start a fresh Pi process with the extension and supported producing model, so cached handshake headers include the capability.
2. Establish a small task with user constraints and at least one tool interaction.
3. `/compact`; confirm successful checkpoint persistence and meaningful continuation.
4. Add new work/tool history, compact again, and confirm earlier plus new constraints remain available.
5. Restart/reopen and continue; fork/navigate without a summary and continue on inherited valid state.
6. If authorized, check ordinary cached-WebSocket continuation separately from the synthetic SSE request.
7. Record content-free outcomes, versions, model, transport, latency and failures. Never commit live ciphertext or conversation captures as fixtures.

Do not claim measured backend limits from the provisional five-minute deadline or 20 MiB wire guard. Do not force a huge expensive session merely to trigger automatic compaction; local tests cover scheduler mechanics. Additional live scenarios should answer a concrete compatibility concern.

No live erasure, crash-transaction guarantees or cross-model compatibility are established by successful continuation. Cleanup must affect only the disposable artifacts you created. Publishing is a separate authorized operation.
