# Architecture

## Scope and ownership

This extension supports only Pi's legacy `openai-codex` provider with `openai-codex-responses`, OAuth login, and the official ChatGPT Codex endpoint. Development is pinned to Pi 1.1.0. Wildcard host peers are a packaging choice, not proof of compatibility with every Pi version.

Pi owns compaction scheduling, session-tree persistence, normal inference preparation and normal transport. The extension owns whole-window Codex V2 compaction and checkpoint replay. It does not replace the provider or patch Pi internals.

| Module              | Responsibility                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `src/index.ts`      | Lifecycle hooks, current settings, operation deadline, state snapshots and safe reporting. |
| `src/checkpoint.ts` | Versioned state, identity, transitive coverage and checkpoint validation.                  |
| `src/projection.ts` | Source correspondence, covered-history pruning, image policy and exact-anchor expansion.   |
| `src/retention.ts`  | User retention, text/image estimates and restricted request fitting.                       |
| `src/transport.ts`  | Pi-resolved connection, single-attempt stream, raw result validation and usage mapping.    |

## Context lifecycle

```text
Effective conversation A -> compaction -> replacement W1
W1 + subsequent conversation B -> compaction -> replacement W2
W2 + subsequent conversation C -> normal inference
```

A replacement contains retained actual user messages followed by one opaque encrypted compaction item. It is not just the encrypted item, and it is not a portable text summary.

### Produce a checkpoint

1. `session_before_compact` resolves the latest compaction on the active branch as absent, valid, or invalid. Invalid owned state cancels rather than becoming ordinary history. Unrelated unsupported sessions without an owned checkpoint are left to Pi.
2. Read `buildSessionProjection()` and its source entries. Never resurrect history omitted by previous compaction or context edits.
3. Snapshot branch, public effective instructions, thinking level, transcript tools and image-blocking policy. Carry earlier sealed coverage forward.
4. Resolve authentication through Pi. Validate provider/API/OAuth/official endpoint. Derive a hashed account identity from the resolved token; do not store the token.
5. Serialize via Pi's actual Codex provider, retaining system/tool deltas needed to interpret historical calls. Apply image blocking to users and tool results.
6. At per-call `onPayload`, validate ordered wire-user/source correspondence, expand an existing checkpoint anchor once, apply request fitting, and append `compaction_trigger`.
7. Accept only successful normalized completion plus raw `response.completed` with an ID and exactly one nonempty encrypted compaction item. Reject explicit noncompleted status, errors, incomplete streams and EOF. Preserve unknown structured checkpoint fields; never execute synthetic output tools.
8. Recheck identity, cancellation and the state snapshot before returning a compaction result. Pi then appends the entry; that append is not transactional.

Synthetic compaction uses SSE, `maxRetries: 0`, one application attempt and a whole-operation abort deadline. It uses current transcript declarations/instructions/reasoning, not cached normal-request payloads or normal Fast-mode hooks. Service tier is omitted. Exact prepared-tool-description parity with ordinary inference is not a requirement; backend acceptance of this request remains to be verified.

### Continue a checkpointed session

`context_with_system` removes covered conversation copies by canonical source occurrence while preserving the leading system state and historical tool deltas. Using conversation-only `context` would make Pi collapse historical declarations into its current head, changing serialization of removed grammar tools. Pi retains ownership of later hidden/prepared declarations and forced-prompt preparation.

`before_provider_request` replaces exactly one wrapped checkpoint anchor with the complete saved window. It changes only `input`; normal instructions, prepared tools, service tier and transport remain intact. Identical user text is not a duplicate identifier. Transient appended messages remain subsequent input.

The beta feature `remote_compaction_v2` is merged into legacy request headers before the first checkpoint as well as synthetic requests. Existing cached WebSocket handshake headers cannot be retrofitted by reloading; restart Pi before consuming inherited checkpoints in that situation.

## Persisted format

`CompactionEntry.summary` contains a unique warning/UUID display anchor, not conversation knowledge. `firstKeptEntryId` remains Pi's supplied boundary; the projection hook removes retained copies already covered by the replacement.

`CompactionEntry.details` has type `pi-openai-compaction-v2`, version `1`:

| Field            | Meaning                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `anchor`         | Exact summary anchor, required to agree with the entry summary.                                                |
| `identity`       | Provider, API, producing model, effective endpoint, and hashed account identity.                               |
| `coveredThrough` | Branch entry delimiting the context captured by this operation.                                                |
| `coverage`       | Entry IDs and SHA-256 digests of represented source entries, including inherited coverage and effective edits. |
| `window`         | Ordered classified wire copies (`item`, `sourceKind`, `sourceIds`), ending with one checkpoint.                |
| `responseId`     | Completed compaction response ID.                                                                              |

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
- Unloading the extension cannot make checkpoints portable or enforce blocking. The warning anchor instructs recovery.
- Payload-hook errors are caught by Pi; cancellation is best effort, not a zero-transmission guarantee on ordinary cached WebSockets.
- Pi append failure can advance memory before disk. Report failure and advise stopping/reopening; do not promise rollback or durability from `getBranch()`.
- Initial encrypted context size is unknown. Use normal reported usage for scheduling; never fake usage or infer token size from ciphertext or compaction-call usage.
- Usage subtracts cache reads/writes from ordinary input; reasoning stays within output. Zero cost fields mean unpriced, not free.

The five-minute deadline (CLI range 1 second–30 minutes) and wire guard are provisional policies. Dual compaction/portable summaries are not implemented; adding them requires a separate design for summary coverage, boundaries and anchor compatibility.
