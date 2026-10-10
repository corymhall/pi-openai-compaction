# pi-openai-compaction

Dual portable-text and remote whole-window V2 compaction for Pi's **legacy `openai-codex` / `openai-codex-responses` ChatGPT login**. Requires the Pi 1.1.0 API baseline; local development uses exactly 1.1.0. Live acceptance passed on that baseline with legacy `gpt-6.1-sol`; see [tested scope and limitations](docs/testing.md#authorized-live-acceptance).

Try without changing settings:

```sh
pi -e /path/to/pi-openai-compaction
```

Use Pi's ordinary `/compact` and automatic scheduling. Nonempty custom `/compact` guidance is rejected before sending: V2 uses current instructions. API keys, the new OpenAI login, Azure, custom endpoints and gateways are unsupported. No automatic text-only fallback on compaction failure or automatic remote compaction retries are installed; uninstall portability and explicit portable mode are intentional text paths.

Each compaction runs Pi's exported native text summarizer and whole-window encrypted compaction concurrently on the same resolved legacy connection. Both must succeed before one entry is returned; either failure aborts the sibling, with no partial success or retry. Usage combines both operations (including Pi split-turn calls). Text summarization uses Pi's prepared prefix, normal retained-tail boundary and previous portable summary, independently of encrypted replay; normal text/image fidelity limitations apply.

Synthetic encrypted compaction is a separate SSE operation using Pi's actual Codex history serializer, current instructions, current transcript tool declarations and reasoning. It does not dispatch normal-inference Fast-mode hooks or use cached payload options. Live acceptance covered a real implementation transcript and recursive checkpoints on the tested legacy connection; it does not establish compatibility for every tool declaration or model. Ordinary continuation retains Pi's prepared prompt, tools, service tier and transport.

## Checkpoints and recovery

The original transcript remains intact. Branch-local compaction details persist a versioned replacement window: retained actual user messages/images (approximately 64k tokens, newest first, with boundary truncation) and one encrypted checkpoint. Custom/shell/summary messages are sent but are not separately retained. Recursive compaction includes the previous window and the complete effective live tail once.

Pi's effective `images.blockImages` setting applies to synthetic input (including tool results) and retained plaintext images injected on continuation. Blocking uses Pi's text placeholder and preserves source IDs. Existing saved windows are filtered only for the current request: disabling blocking can re-enable images still retained there. Recursive compaction persists filtered copies; those copies never restore images from sealed raw history, even after blocking is disabled or the session is reopened.

**Blocking cannot selectively forget images already sealed inside an opaque checkpoint.** That checkpoint is still replayed unchanged and may contain image-derived knowledge. For a clean context, start a new session without an inherited checkpoint; neither blocking nor recursive compaction is an erasure operation.

A checkpoint may be consumed only by its producing model and compatible legacy account/endpoint. Reopening and forks resolve inherited branch evidence. Edits to sealed history, malformed/unsupported checkpoints, missing anchors and unsafe text tree summaries are rejected; edits confined to the live tail remain supported. The old standalone prototype format is not migrated.

Every accepted entry also stores a real ordinary Pi text summary and its normal `firstKeptEntryId`. With the extension completely absent, Pi naturally resumes that summary plus its retained tail and can compact again. Re-enabling after a newer ordinary compaction uses that new text lineage, not stale encrypted state.

For an explicit text-only invocation use `pi -e /path/to/pi-openai-compaction --openai-compaction-portable`. This intentionally bypasses producing-model/account identity for continuation, but still validates owned state and rejects corruption/unsupported versions. Compaction in this mode uses only Pi's text helper and supersedes encrypted state; it remains limited to the supported legacy connection and rejects custom guidance. It is not an automatic fallback. Text tree summaries across owned checkpoints remain conservatively blocked in either mode.

For invalid/corrupt owned state, navigate **before the affected checkpoint**, or start a new session. Earlier checkpoint/prototype versions are rejected without migration.

**Autoresearch is unsupported.** Use a separate session with this extension disabled and no inherited opaque checkpoint. There is no autoresearch mode integration.

## Limits

- Cancellation is best effort. Ordinary cached-WebSocket requests can transmit despite cancellation; no zero-transmission guarantee.
- V2 capability is advertised on legacy requests while loaded. Connections opened before loading/reloading retain their original handshake headers; restart Pi before using an inherited checkpoint in that case. Cache internals and ordinary transport are not changed.
- Host append failures may leave memory ahead of disk. Treat them as failures, stop and reopen from disk. In-memory checkpoint presence does not establish durability or rollback.
- Initial encrypted-context sizing is unknown. Ordinary provider usage drives Pi scheduling when available; ciphertext length and compaction usage are not replacement-window token counts.
- Request fitting rewrites only eligible trailing tool outputs, stopping at the first noneligible/encrypted boundary. Oversized user input/checkpoints are never truncated to force a request.
- The local 20 MiB wire-byte safety guard is not a measured backend limit. Image budgeting uses Codex's approximate auto-detail estimate, not base64 length.
- Covered-history pruning uses `context_with_system` to preserve the leading prompt and historical tool/system deltas. Pi's own later prepared-declaration and forced-prompt projections remain in control. Arbitrary request-time history-transform/redaction extensions are unsupported; mismatched source correspondence is rejected.
- Both compaction paths have retries disabled and share one whole-operation deadline. Pi can make separate history and split-turn text calls. The initial **five-minute default is unvalidated**, not measured acceptance. Override per invocation:

  ```sh
  pi -e /path/to/pi-openai-compaction --openai-compaction-deadline-ms 600000
  ```

Usage records subtract cached input from ordinary input and keep reasoning within output. Encrypted-call cost fields are zero/unpriced, not a claim that an operation is free; native text usage retains Pi's cost calculation. Extension diagnostics omit credentials and checkpoint bodies.

## Local validation

The project uses TypeScript 7, Vitest, oxlint and oxfmt, with handwritten configuration and no GitHub Actions or release automation. Pi development dependencies remain pinned to 1.1.0; host peers remain `*`.

```sh
npm ci --ignore-scripts
npm run check          # typecheck, lint, format check and tests
npm run build          # ESM JavaScript and declarations in lib/
npm pack --dry-run     # builds and checks package contents; does not publish
```

Use `npm test` for tests alone, `npm run test:watch` while developing, `npm run test:coverage` for source coverage, and `npm run format` to apply formatting. Tests run directly against source; a build is not required first.

`test/behavior.test.mjs` uses the real Pi session lifecycle and actual Codex serializer/SSE adapter against a local server with synthetic credentials. Cases reset their session/server state independently. No paid inference is required. `test/request-state.test.mjs` records the distinction between normal and synthetic request preparation; it is not a backend compatibility test. Both use Vitest directly, without a subprocess wrapper.

## Maintaining this project

See [maintainer documentation](docs/README.md) for architecture, upstream sources, review guidance, and testing/acceptance procedures.
