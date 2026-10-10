# Architecture

## Scope and ownership

This extension supports only Pi's legacy `openai-codex` provider with `openai-codex-responses`, OAuth login, and the official ChatGPT Codex endpoint. Development is pinned to Pi 1.1.0. Wildcard host peers are a packaging choice, not proof of compatibility with every Pi version.

Pi owns compaction scheduling, session-tree persistence, normal inference preparation and normal transport. The extension owns whole-window Codex V2 compaction and checkpoint replay. It does not replace the provider or patch Pi internals.

| Module              | Responsibility                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `src/index.ts`      | Lifecycle hooks, current settings, operation deadline, state snapshots and safe reporting.  |
| `src/checkpoint.ts` | Versioned state, identity, transitive coverage and checkpoint validation.                   |
| `src/projection.ts` | Source correspondence, covered-history pruning, image policy and exact-anchor expansion.    |
| `src/retention.ts`  | User retention, text/image estimates and restricted request fitting.                        |
| `src/transport.ts`  | Pi-resolved connection, single-attempt stream, raw result validation and usage mapping.     |
| `src/portable.ts`   | Pi text helper, individual completion validation, cumulative file lists and combined usage. |

## Context lifecycle

```text
Effective conversation A -> compaction -> replacement W1
W1 + subsequent conversation B -> compaction -> replacement W2
W2 + subsequent conversation C -> normal inference
```

The encrypted replacement contains retained actual user messages followed by one opaque item. Every successful entry also stores an ordinary Pi text summary and normal retained-tail boundary. These are independent lineages: encrypted compaction captures the effective whole window; text compaction uses Pi's prepared prefix and previous portable summary, never ciphertext, replay markers, or omitted raw history.

### Produce a checkpoint

1. `session_before_compact` resolves the latest compaction on the active branch as absent, valid, or invalid. Invalid owned state cancels rather than becoming ordinary history. Unrelated unsupported sessions without an owned checkpoint are left to Pi.
2. Read `buildSessionProjection()` and its source entries. Never resurrect history omitted by previous compaction or context edits.
3. Snapshot branch, public effective instructions, thinking level, transcript tools and image-blocking policy. Carry earlier sealed coverage forward.
4. Resolve authentication through Pi. Validate provider/API/OAuth/official endpoint. Derive a hashed account identity from the resolved token; do not store the token.
5. Serialize via Pi's actual Codex provider, retaining system/tool deltas needed to interpret historical calls. Apply image blocking to users and tool results.
6. At per-call `onPayload`, validate ordered wire-user/source correspondence, expand an existing checkpoint anchor once, apply request fitting, and append `compaction_trigger`.
7. Concurrently call exported Pi `compact()` with event preparation and a direct resolved-provider stream (no ordinary replay hooks). Carry cumulative fromHook file lists into preparation.fileOps. Validate each individual text completion through the supported stream result API before Pi adds file tags or merges split-turn summaries: require successful stop, nonempty non-whitespace text and no tool calls. Require a successful native summary and successful encrypted result before returning one entry; combine both usages, including any Pi split-turn calls.
8. Accept only successful normalized completion plus raw `response.completed` with an ID and exactly one nonempty encrypted compaction item. Reject explicit noncompleted status, errors, incomplete streams and EOF. Preserve unknown structured checkpoint fields; never execute synthetic output tools.
9. Recheck identity, cancellation and the state snapshot before returning a compaction result. Pi then appends the entry; that append is not transactional.

Both paths use SSE, `maxRetries: 0`, disabled helper retries and a shared whole-operation abort deadline. Either failure aborts the sibling; Promise.all observes late errors, and outer failure aborts before deadline disposal. Pi can issue separate history and split-turn text calls. The encrypted request uses current transcript declarations/instructions/reasoning, not cached normal-request payloads or normal Fast-mode hooks. Service tier is omitted. Exact prepared-tool-description parity with ordinary inference is not a requirement. Live acceptance covered a real implementation transcript on the legacy connection described in [Testing](testing.md#authorized-live-acceptance); other declaration/model combinations are not established by that run.

### Continue a checkpointed session

`context_with_system` removes covered conversation copies by canonical source occurrence while preserving the leading system state and historical tool deltas. Using conversation-only `context` would make Pi collapse historical declarations into its current head, changing serialization of removed grammar tools. Pi retains ownership of later hidden/prepared declarations and forced-prompt preparation.

`context_with_system` rewrites only the canonical checkpoint-source compactionSummary to a private replay marker; identical real user text remains untouched. `before_provider_request` replaces exactly one wrapped private marker with the complete saved window. It changes only `input`; normal instructions, prepared tools, service tier and transport remain intact. Identical user text is not a duplicate identifier. Transient appended messages remain subsequent input.

The beta feature `remote_compaction_v2` is merged into legacy request headers before the first checkpoint as well as synthetic requests. Existing cached WebSocket handshake headers cannot be retrofitted by reloading; restart Pi before consuming inherited checkpoints in that situation.

## Persisted format

`CompactionEntry.summary` contains a real Pi text summary. `firstKeptEntryId` remains the normal portable boundary; encrypted pruning removes retained copies already covered by its separate whole-window replacement.

`CompactionEntry.details` has type `pi-openai-compaction-v2`, version `2` (earlier versions rejected):

| Field            | Meaning                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `anchor`         | Private UUID replay marker substituted only for the checkpoint's proven source contribution.                   |
| `identity`       | Provider, API, producing model, effective endpoint, and hashed account identity.                               |
| `coveredThrough` | Branch entry delimiting the context captured by this operation.                                                |
| `coverage`       | Entry IDs and SHA-256 digests of represented source entries, including inherited coverage and effective edits. |
| `window`         | Ordered classified wire copies (`item`, `sourceKind`, `sourceIds`), ending with one checkpoint.                |
| `responseId`     | Completed compaction response ID.                                                                              |

`summaryHash` seals portable text, `firstKeptEntryId` seals its Pi boundary, and cumulative `readFiles`/`modifiedFiles` preserve file tracking despite Pi's fromHook exclusion. Text/boundary corruption fail closed.

Consult the exported interfaces in `src/checkpoint.ts` for exact types. Source IDs establish provenance, not permission to reconstruct a truncated or image-filtered copy from original history. Hashes detect changed branch evidence; they are not signatures or protection against deliberate file tampering.

Only the latest effective compaction is authoritative. A newer ordinary Pi summary supersedes remote replay. Unsupported owned versions and the old prototype format are rejected without implicit migration. Forks may inherit valid coverage; session ID is deliberately not a consumer identity constraint.

## Retention and image policy

Retain only actual Pi user entries, including previously saved retained users. Pi custom, shell and summary contributions also become wire-user messages but must not be retained as actual users.

Use an approximate 64,000-token retained-user budget: newest first, restore chronological order, truncate one boundary, and never backfill older users after an oversized boundary. Text estimates use UTF-8 bytes/4; images use the Codex-aligned auto-detail estimate. Image/label groups are atomic. This budget excludes the checkpoint and is not a server token count.

Honor current `images.blockImages` via public settings for synthetic input and plaintext saved-window replay. Match Pi's placeholder/deduplication behavior. Request-local filtering does not mutate saved state; recursive compaction persists filtered copies. Opaque checkpoint knowledge cannot be selectively erased. A clean context requires a new session without inherited ciphertext.

Request fitting only rewrites an eligible trailing output suffix, preserving encrypted outputs and call pairing and stopping at the first ineligible boundary. If the estimated budget still does not fit, fail rather than trimming users/checkpoints. A separate 20 MiB wire-byte guard bounds local payload size; it is not a measured backend maximum and does not estimate encrypted model-context size.

## Safety and deliberate limits

- No automatic text fallback or compaction retry. Ordinary Pi overflow recovery remains enabled.
- Producing-model-only consumption; account/endpoint changes are incompatible.
- Edits to sealed history block replay and recursion; live-tail edits are supported.
- `/tree` navigation without summaries is supported; opaque-history text summaries are blocked conservatively.
- Custom `/compact` guidance is rejected before the request.
- Autoresearch and arbitrary request-time history rewrites are unsupported. Autoresearch requires a separate session with the extension disabled and no opaque checkpoint.
- Without the extension Pi naturally resumes portable summary plus retained tail and can compact again; a newer native compaction supersedes encrypted state.
- Explicit `--openai-compaction-portable` validates owned state but bypasses producing identity for text continuation. Compaction remains legacy-only, rejects custom guidance and returns ordinary text details. Tree summaries across owned history remain blocked.
- Payload-hook errors are caught by Pi; cancellation is best effort, not a zero-transmission guarantee on ordinary cached WebSockets.
- Pi append failure can advance memory before disk. Report failure and advise stopping/reopening; do not promise rollback or durability from `getBranch()`.
- Initial encrypted context size is unknown. Use normal reported usage for scheduling; never fake usage or infer token size from ciphertext or compaction-call usage.
- Usage subtracts cache reads/writes from ordinary input; reasoning stays within output. Encrypted-call cost fields are unpriced, not free; native text usage retains Pi's cost calculation.

The five-minute deadline (CLI range 1 second–30 minutes) and wire guard are provisional policies. Portable text retains normal Pi summary fidelity and image limitations; it is not a decryption or whole-window copy.
