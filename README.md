# pi-openai-compaction

Use OpenAI Responses native compaction with Pi's `openai-codex` provider.

## Decision

Build an extension around the standalone `POST /responses/compact` endpoint. Run it from Pi's `before_provider_request` hook, where Pi has already serialized the exact Responses API input.

Do **not** start with `context_management.compact_threshold`. Pi 0.84.1 ignores streamed `type: "compaction"` output items, so inline server compaction would help only the current request; Pi could not persist or replay the opaque item on the next request.

| Approach | Verdict | Reason |
|---|---|---|
| Standalone compact endpoint in `before_provider_request` | Recommended MVP | Uses Pi's exact serialized input and can persist the canonical compacted window |
| Add `context_management` in `before_provider_request` | Insufficient alone | Pi's response parser drops compaction items |
| Replace/wrap the complete `openai-codex` provider | Optional later | Can capture inline compaction, but duplicates transport and stream concerns |

## Minimal setup

```text
.
├── package.json
├── extensions/
│   └── openai-compaction.ts
└── test/
    └── openai-compaction.test.ts
```

```json
{
  "name": "pi-openai-compaction",
  "private": true,
  "type": "module",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/openai-compaction.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

Pi loads TypeScript directly, so the runtime needs no build step and no OpenAI SDK. Add Pi packages as development dependencies only if this repository will run type-checks and tests.

### MVP request flow

1. Gate on `ctx.model.provider === "openai-codex"` and `ctx.model.api === "openai-codex-responses"`.
2. In `before_provider_request`, treat `event.payload.input` as the raw, uncompressed Pi transcript. If an active checkpoint exists, verify its saved prefix hash and replace that prefix with the checkpoint's canonical OpenAI output.
3. When the effective context crosses the configured threshold, call the Codex compact endpoint with the effective input and return the normal provider payload with `input` replaced by `compacted.output`.

Persist this JSON-serializable state with `pi.appendEntry("openai-compaction", state)`:

```ts
interface NativeCheckpoint {
  version: 1;
  provider: "openai-codex";
  model: string;
  baselineItemCount: number;
  baselineHash: string;
  output: unknown[]; // Preserve the complete canonical output without pruning.
  usage?: unknown;
}
```

The next raw Pi payload should start with the same baseline items and then contain newer turns. Send:

```ts
input = [...checkpoint.output, ...rawInput.slice(checkpoint.baselineItemCount)];
```

On repeated compaction, compact that effective input and replace the checkpoint. On resume or branch changes, select the newest checkpoint on `ctx.sessionManager.getBranch()`; a checkpoint is inactive when its custom entry is not on the current branch.

### Compact request

For ChatGPT subscription auth, Pi's provider uses:

```text
POST https://chatgpt.com/backend-api/codex/responses/compact
Authorization: Bearer <Pi's refreshed OAuth access token>
chatgpt-account-id: <JWT https://api.openai.com/auth.chatgpt_account_id>
OpenAI-Beta: responses=experimental
originator: pi
Content-Type: application/json
```

Resolve the refreshed token and configured headers through:

```ts
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
```

Build the compact body from the already serialized normal request. Keep the fields accepted by the official Codex compact flow:

```ts
const compactBody = {
  model: payload.model,
  input: effectiveInput,
  instructions: payload.instructions,
  tools: payload.tools,
  parallel_tool_calls: payload.parallel_tool_calls,
  reasoning: payload.reasoning,
  service_tier: payload.service_tier,
  prompt_cache_key: payload.prompt_cache_key,
  text: payload.text,
};
```

Strip response-only fields such as `stream`, `store`, `include`, `tool_choice`, `previous_response_id`, and `client_metadata`. Validate that the response has `object: "response.compaction"` and preserve its entire `output` array; OpenAI explicitly says not to prune standalone compact output.

### Pi compaction interaction

Keep Pi's compaction enabled as a fallback, but intercept `session_before_compact`:

| Pi reason | MVP behavior |
|---|---|
| `threshold` | Cancel; the next provider request performs native compaction using its exact payload |
| `manual` | Cancel and mark the next provider request as forced native compaction |
| `overflow` | Allow Pi's default compaction and clear incompatible native checkpoint state |

This retains Pi's overflow recovery if the native threshold was too late. A manual `/compact <instructions>` cannot apply those instructions to OpenAI's opaque compaction; notify the user that compaction will occur on the next model request and the instructions are ignored.

## Limitations

| Limitation | Consequence | MVP action |
|---|---|---|
| OpenAI output is opaque encrypted state | Pi cannot display a useful compaction summary in `/tree` or exports | Render a compact checkpoint marker only |
| Checkpoint is provider-specific | Switching to Anthropic, Google, or an incompatible OpenAI endpoint loses the native state | Fail closed or clear the checkpoint and invoke Pi compaction before switching |
| Pi has no public opaque provider-item message type | Native state cannot live in a normal Pi `CompactionEntry` | Persist it as a custom entry and rewrite provider payloads |
| Inline compaction items are ignored by Pi 0.84.1 | `context_management` alone is not durable | Use standalone compaction for the MVP |
| Prefix replay depends on deterministic serialization | Model/tool/schema changes can make the saved prefix hash fail | Never slice on count alone; require a hash match and fall back safely |
| Native compaction usage is outside Pi's accounting | Footer and `/session` totals omit the compact call | Store raw usage in checkpoint details; add accounting only with upstream support |
| `/responses/compact` input must still fit the model window | A late trigger cannot rescue an already oversized compact request | Trigger conservatively, for example `contextWindow - 32_000` |
| Full Pi history remains in memory/session JSONL | Network context shrinks, but local serialization and session size do not | Accept for MVP; Pi intentionally retains full history anyway |

The encrypted item should be treated like a credential-adjacent artifact: do not log it, include it in diagnostics, or expose it in a renderer.

## Optional features

| Feature | Value | Cost |
|---|---|---|
| Dual OpenAI + readable Pi summary | Safe provider switching and useful `/tree`/exports | A second summarization call and two sources of compacted state |
| Inline `context_management` support | Server decides exactly when to compact during generation | Requires a provider wrapper or a new Pi raw-output-item hook |
| Configuration and UI | Threshold, force command, status, checkpoint statistics | Small once the core state machine is stable |
| Broader OpenAI support | API-key `openai` via `https://api.openai.com/v1/responses/compact` | Separate auth/base URL capability checks |
| Branch/import hardening | Reliable fork, clone, tree navigation, and imported sessions | More checkpoint ancestry and compatibility tests |
| Upstream Pi integration | Correct usage accounting and first-class opaque checkpoints | Requires a Pi API change, but removes most extension workarounds |

The best upstream API would let a compaction result carry provider-owned opaque context and let each provider serialize it. A raw Responses output-item event would also make inline server compaction possible without replacing the provider.

## Tests required before enabling by default

| Test | Assertion |
|---|---|
| First compaction | Compact body equals the effective normal request minus response-only fields |
| Continuation | Outgoing input is canonical compact output plus only post-checkpoint items |
| Repeated compaction | The newest compact call receives the previous canonical output plus its suffix |
| Resume and branch | Only checkpoints on the active branch apply |
| Prefix mismatch | Request is not sliced; extension warns and falls back |
| Auth refresh and cancellation | Pi auth resolution is used and `ctx.signal` aborts the compact fetch |
| Overflow | Pi's built-in compaction remains able to recover and retry |
| Sensitive output | Logs and UI never contain `encrypted_content` |

Use mocked provider payloads for unit tests. Keep a live ChatGPT subscription probe opt-in because compaction consumes provider quota and endpoint behavior can change.

## Sources

- [Pi extension events](https://github.com/earendil-works/pi/blob/368e013dec766724d892cfa5cc247d2f2bee8795/packages/coding-agent/docs/extensions.md)
- [Pi compaction internals](https://github.com/earendil-works/pi/blob/368e013dec766724d892cfa5cc247d2f2bee8795/packages/coding-agent/docs/compaction.md)
- [Pi OpenAI Codex Responses provider](https://github.com/earendil-works/pi/blob/368e013dec766724d892cfa5cc247d2f2bee8795/packages/ai/src/api/openai-codex-responses.ts)
- [Pi Responses stream parser](https://github.com/earendil-works/pi/blob/368e013dec766724d892cfa5cc247d2f2bee8795/packages/ai/src/api/openai-responses-shared.ts)
- [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction)
- [OpenAI Node compact endpoint types](https://github.com/openai/openai-node/blob/71bc2a6115f4c9aff3403dccb867a1b4661b877a/src/resources/responses/responses.ts)
- [Official Codex compact request implementation](https://github.com/openai/codex/blob/3aae5d885bac39c1262491aa3fd100dfd8b3919f/codex-rs/core/src/client.rs)
