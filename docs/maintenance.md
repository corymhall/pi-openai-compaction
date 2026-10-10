# Maintenance and review

## Working rules

Read [architecture](architecture.md) before changing lifecycle/projection code, and use [upstream sources](upstream-sources.md) for API changes. The root README owns user-facing support and recovery instructions; architecture owns internal contracts; [testing](testing.md) owns validation procedures. Update those documents with behavior changes rather than creating chronological investigation reports.

Configuration is handwritten: edit `package.json`, TypeScript configs and `vitest.config.ts` directly. There is no projen synthesis, CI workflow or release automation. Do not introduce generated-configuration commands from older instructions.

Development pins all three Pi packages to the same version (currently 1.1.0). Upgrade them together and validate supported host APIs. Wildcard peer declarations do not remove the need for compatibility testing. Source extension loading and built ESM exports are both part of the package contract.

## Decisions to preserve

- Personal-use legacy ChatGPT/Codex connection only; no API-key/new-login/Azure/gateway adapters.
- Whole-window Codex V2 and source-aware retention, not default older-prefix summarization.
- One synthetic SSE attempt with a full-operation deadline, not ordinary transport retries or Fast-mode hook dispatch.
- Supported Pi APIs, no private runner monkeypatching or provider replacement.
- No text fallback, automatic checkpoint conversion or silent migration.
- Producing-model/account/endpoint identity and transitive branch coverage guard replay.
- Saved wire copies remain authoritative after truncation/filtering; never reload their content from sealed raw entries.
- Full-transcript pruning preserves tool history; normal request preparation remains Pi-owned.
- Autoresearch/arbitrary history-transform compatibility is outside scope.
- Host cancellation/write risks and unknown encrypted-context estimates are disclosed limitations, not reasons to invent fake usage or a mandatory host fork.

Portability/dual compaction has been discussed but is not part of the implementation. Before adding it, review full-window portable-summary production, recursion, failure policy, `firstKeptEntryId`, replay anchor changes, disabled-extension resume and migration. Do not turn the current warning anchor into a pretend summary.

## Review checklist

Use concrete payload/session evidence for findings. Existing passing tests establish only their covered paths.

### State and replay

- Resolve the latest active-branch compaction; distinguish absent, valid and invalid owned state.
- Preserve transitive coverage, sealed edits, fork inheritance and old-format rejection.
- Check source occurrence/order, not text uniqueness: repeated users are legitimate.
- Ensure `W1 + complete live tail` enters recursion once and covered copies never reappear.
- Preserve opaque fields and exact checkpoint position; anchor matching must be exact and unambiguous.
- Ensure tree/model/account transitions report incompatibility instead of dropping knowledge.

### Pi integration

- Keep a leading system message and historical tool deltas through `context_with_system`.
- Test grammar tools added/called/removed after a checkpoint, original item IDs, call/output pairing, prepared hidden tools and forced prompts.
- Match effective image policy for new users, tool outputs and saved plaintext replay; test changes/reopen. Do not claim ciphertext forgetting.
- Do not substitute a last captured payload for current operation state.
- Keep normal service tier/transport untouched; synthetic declarations need independent backend acceptance.

### Failure and resource behavior

- Require both raw protocol completion and normalized success; never execute synthetic tools.
- Check HTTP failure, EOF, malformed results, cancellation during auth/streaming and late rejection handling.
- Verify one attempt, no concealed fallback/retry, whole-operation deadline and cleanup.
- Preserve current checkpoint on remote failure; don't let reporting/preparation exceptions trigger native summary fallback.
- Treat append failure as memory/disk divergence, not durable success.
- Keep fitting restricted to eligible outputs and bound wire bytes without estimating opaque context from ciphertext.
- Validate usage subtotals and avoid fabricated pricing.

### Packaging and information safety

- Load the source factory through Pi and test package content/build exports.
- Do not add runtime dependencies on private package paths or duplicate host libraries casually.
- Preserve upstream license attribution in `NOTICE`.
- Keep credentials, account tokens, checkpoint bodies and real transcript captures out of diagnostics/fixtures.
- Never inspect credential files or change global settings to diagnose compatibility. Use Pi's supported authentication interface; ask for reconnection if needed.

## Completing a change

Run targeted regressions, then the checks in [testing](testing.md). Do not repeatedly rerun broad checks once they pass without a new change or unresolved concern. Report actual commands/results and separate local validation from live acceptance. Dependency audit findings need a deliberate remediation decision, not unrelated automatic upgrades. Commit, push, publish, global configuration changes and live inference require explicit user authorization.
