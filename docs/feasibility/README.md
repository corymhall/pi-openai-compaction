# Isolated Pi 1.1.0 feasibility experiments

These are host-runtime experiments, not plugin implementation or a full AgentSession end-to-end suite. They use the published Pi 1.1.0 runtime, temporary disk-backed sessions, an actual local WebSocket server, and synthetic credentials. They do not resolve user authentication or contact OpenAI.

Copy `experiments.mjs` into the root of an isolated temporary npm project with these dependencies:

```json
{"private":true,"type":"module","dependencies":{"@earendil-works/pi-coding-agent":"1.1.0","@earendil-works/pi-ai":"1.1.0","ws":"8.18.3"}}
```

Then run `npm install --ignore-scripts --no-audit --no-fund` and `node experiments.mjs > results.json`. Tested with Node 26.7.0. Imports of host internals are deliberate experiment-only coupling, not recommended plugin APIs. Do not run npm installation in the plugin checkout for this experiment.

Experiments:

- Accounting: real persisted/reopened SessionManager fixtures and the actual `AgentSession._exceedsCompactionThreshold` predicate. This proves the scheduler-input mismatch, not the exact number of compaction loops in a full agent run. User-text comparisons are heuristic estimates; opaque checkpoint size is deliberately unknown.
- Persistence: rename only the temporary fixture's session file and replace its path with a directory. Real append fails with EISDIR, and the test compares in-memory history with a reopened disk copy. No monkeypatched persistence implementation.
- Blocking: warm a cached Codex WebSocket with successful synthetic inference, abort in `onPayload` on the next call, and count both client send invocations and requests received by the local server. Debug stats verify connection reuse. The raw-incomplete experiment uses a separate cache identity so its error cannot invalidate the warm cache.
- Raw events: per-call observer captures `response.incomplete` before normalization. The adapter also produces an error for this fixture; do not generalize that to all incomplete shapes or equate normalized completion with success.
- SSE control: abort in `onPayload`; a counted fetch stub proves no fetch occurs.

`results.json` records the completed run. Earlier attempts exposed a fixture isolation issue (an incomplete response invalidated the socket cache); that was fixed by separating session identities before accepting the cached-WebSocket result.

No experiment patches the built-in runner, scheduler, or session writer. The low-level experiments reproduce risks rather than demonstrating that all plugin behavior is ready.

## Real AgentSession lifecycle

Copy `lifecycle.mjs` into the same isolated npm project root and run `node lifecycle.mjs > lifecycle-results.json`. This uses real `createAgentSession`, disk-backed SessionManager, extension binding, `session_before_compact`, `context`, and `before_provider_request` hooks. A registered synthetic provider and synthetic tool are test fixtures, not changes to the legacy Codex provider.

The model has a 2,000-token context window and a 500-token reserve, so the automatic threshold is 1,500. The provider reports staged usage of 300, 400, 500, 600, 900, 1,700, 500 and 600 tokens. These are controlled test inputs, not claims about tokenization of the synthetic text.

Completed flow: two initial requests; manual synthetic checkpoint installation; disk reopen before any fresh post-checkpoint usage; first continuation; three tool turns; threshold-triggered checkpoint installation; final continuation; a second disk reopen and continuation. There are 8 normal provider requests, 3 executed tools, 1 manual and 1 automatic compaction. No redundant compaction occurred and no redundant-compaction guard was installed in this fixture. Reported context usage was unknown after compaction and on immediate reopen, then 500 after the first response.

Assertions check checkpoint presence exactly once, absence of the display marker from provider requests, no duplicate user content (normalized across string/block representations), successful disk restoration, expected compaction count, tool execution count, and newest checkpoint replay after reopening. Extension errors fail the experiment rather than silently making a bypassed hook look successful.

Limits: checkpoints are synthetic; the compaction hook returns a fake successful result and does not make a nested backend call. Mock input serialization is deliberately simple, not the actual Codex serializer. This verifies Pi scheduling/hook/persistence lifecycle under ordinary successful usage; it does not establish live encrypted-token budgets, images, context-edit/overflow recovery, failure handling, or every long-running scheduling scenario. Those remain implementation validation cases.
