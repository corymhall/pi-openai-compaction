# Upstream sources for updates

Use Pi's published version and Codex source as the primary references. Follow links at a fixed version/commit when checking behavior; moving branches show what changed, not what the installed runtime does.

## Source index

| Source                                                                                                                      | Read for                                                                              |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Pi repository](https://github.com/earendil-works/pi)                                                                       | Public API contracts and host implementation.                                         |
| [Pi extension docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)                | Event phases, per-call streams, settings, cancellation and package loading.           |
| [Pi compaction docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)               | Scheduling, recovery ordering and extension compaction results.                       |
| [Pi session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)            | Branch projection, checkpoint system state and context edits.                         |
| [Pi changelog](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md)                           | Changes to inspect before dependency upgrades.                                        |
| [OpenAI Codex repository](https://github.com/openai/codex)                                                                  | Legacy backend request shape, retention and replay behavior.                          |
| [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction)                                         | Public API concepts and distinction between automatic and standalone compaction.      |
| [Public compact endpoint reference](https://developers.openai.com/api/reference/python/resources/responses/methods/compact) | Standalone endpoint schema and full-output preservation; not our V2 wire contract.    |
| [pi-openai-toolkit](https://github.com/awoaCrim/pi-openai-toolkit)                                                          | Secondary reference for provenance, checkpoint safety and compatibility approaches.   |
| [Howaboua pi-codex-conversion](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion)    | Secondary reference for Codex serialization, retention and opaque-history conversion. |

The community implementations are examples, not specifications. Do not copy their wider auth support or fallback behavior into this project's narrower scope. `pi-compact-tools` is tool rendering, not context compaction.

## Pi: inspect these paths

Within the Pi repository:

- `packages/coding-agent/src/core/extensions/types.ts`: event/result types, `context_with_system`, settings and raw-stream exposure.
- `packages/coding-agent/src/core/extensions/runner.ts`: handler composition, error handling and system-message restoration.
- `packages/coding-agent/src/core/session-manager.ts`: active branch projection, edits, append ordering and fork behavior.
- `packages/coding-agent/src/core/agent-session.ts`: scheduling, prompt/loadout projections, dynamic image policy and failure events.
- `packages/coding-agent/src/core/model-runtime.ts` and `model-registry.ts`: connection resolution versus ordinary request preparation.
- `packages/ai/src/api/openai-codex-responses.ts` and `openai-responses-shared.ts`: serialization, IDs, SSE/WebSocket retries, headers and raw callbacks.

For the actual installed version, inspect `node_modules/@earendil-works/{pi-coding-agent,pi-ai,pi-agent-core}/package.json` and exported `dist/**/*.d.ts`/runtime files. Repository source is useful context; installed exports/runtime are the authority for the dependency baseline. Runtime imports must use supported package roots, not private subpath assumptions.

## Codex: protocol and retention map

Current adaptation reference: commit `c0c230e6730b3b3c9101b8aff4b9aea4027cea5b`. See [that tree](https://github.com/openai/codex/tree/c0c230e6730b3b3c9101b8aff4b9aea4027cea5b) and `NOTICE`. The user's local checkout is `~/github/codex`; verify its commit before treating it as the adaptation baseline.

| Path under `codex-rs/`                                                                       | Responsibility                                                               |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `core/src/compact_remote_v2_attempt.rs`                                                      | Active history, request options, tool-output fitting, trigger.               |
| `core/src/compact_remote_v2.rs`                                                              | Completion validation, retained-message selection, replacement installation. |
| `core/src/compact_remote_v2_images.rs`                                                       | Image charging and atomic boundary truncation.                               |
| `core/src/compact_remote_history.rs`                                                         | Eligible output suffix fitting and attached notices.                         |
| `core/src/compact.rs`                                                                        | Current context re-establishment around replacement history.                 |
| `core/src/context_manager/history.rs`                                                        | History/image estimates.                                                     |
| `utils/string/src/truncate.rs`                                                               | Text truncation behavior.                                                    |
| `core/src/session/mod.rs` and `client.rs`                                                    | Capability headers and normal transport metadata.                            |
| `codex-api/src/sse/responses.rs`                                                             | Raw event/terminal parsing.                                                  |
| `features/src/lib.rs`                                                                        | Defaults that affect retention and protocol behavior.                        |
| `core/tests/suite/compact_remote.rs`, `compact_remote_trimming.rs`, `compact_resume_fork.rs` | Upstream behavioral expectations.                                            |

Paths may move. Locate symbols such as `CompactionTrigger`, `collect_compaction_output`, `build_v2_compacted_history`, and `trim_function_call_history_to_fit_context_window` rather than guessing replacement paths.

## Updating from these sources

1. Compare the installed Pi baseline or adapted Codex commit with the proposed update.
2. Inspect relevant source and tests, not only release notes or model names.
3. Translate changed behavior into local wire/lifecycle regressions before changing implementation.
4. Update adaptation references and `NOTICE` when copying upstream code.
5. Verify old checkpoint compatibility explicitly. Client source and mocked success do not establish backend acceptance; use an authorized live check when protocol/auth behavior changes.

The public `/responses/compact` contract preserves its complete server-returned output. This project instead uses Codex's `compaction_trigger` V2 flow and locally assembled retained users plus one checkpoint. Never interchange those output-handling rules merely because both are named compaction.
