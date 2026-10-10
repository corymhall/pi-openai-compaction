import { getCurrentTools } from '@earendil-works/pi-ai';
import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  assertIdentity,
  CompactionError,
  coverageFor,
  digest,
  fail,
  newAnchor,
  ownsCheckpoint,
  record,
  requireCheckpoint,
  resolveCheckpoint,
  TYPE,
  type Checkpoint,
} from './checkpoint.js';
import {
  classifyWire,
  convertWithImagePolicy,
  effectiveSources,
  expandClassified,
  filterContext,
  replaceAnchor,
  snapshot,
} from './projection.js';
import { fitRequest, retainUsers } from './retention.js';
import {
  betaHeaders,
  deadline,
  requestV2,
  resolveConnection,
  supportedModel,
} from './transport.js';

import { combinedUsage, portableCompact } from './portable.js';

// Unvalidated initial default, configurable per invocation; not measured live acceptance.
export const DEFAULT_DEADLINE_MS = 5 * 60_000;
function report(ctx: ExtensionContext, error: unknown): void {
  const message =
    error instanceof CompactionError
      ? error.message
      : 'Compaction failed or was cancelled; no accepted checkpoint was installed.';
  try {
    if (ctx.hasUI) ctx.ui.notify(message, 'error');
    else console.error(`[pi-openai-compaction] ${message}`);
  } catch {
    // A broken UI/reporting sink must not turn an owned failure into native fallback.
    try {
      console.error(`[pi-openai-compaction] ${message}`);
    } catch {
      /* best effort */
    }
  }
}
export default function (pi: ExtensionAPI): void {
  install(pi);
}

// Dependency injection is for local behavioral tests, not a configurable auth route.
export function install(pi: ExtensionAPI, connectionResolver = resolveConnection): void {
  pi.registerFlag('openai-compaction-portable', {
    description:
      'Explicitly use ordinary Pi text history and compaction (still validates owned state)',
    type: 'boolean',
    default: false,
  });
  const portableMode = () => pi.getFlag('openai-compaction-portable') === true;
  pi.registerFlag('openai-compaction-deadline-ms', {
    description:
      'Whole-operation remote compaction deadline (1000–1800000 ms; initial default 300000)',
    type: 'string',
    default: String(DEFAULT_DEADLINE_MS),
  });

  pi.on('session_before_compact', async (event, ctx) => {
    let operation: ReturnType<typeof deadline> | undefined;
    try {
      const branch = ctx.sessionManager.getBranch();
      const resolution = resolveCheckpoint(branch);
      if (!supportedModel(ctx.model) && resolution.kind === 'absent') {
        return undefined;
      }
      operation = deadline(
        event.signal,
        Number(pi.getFlag('openai-compaction-deadline-ms') ?? DEFAULT_DEADLINE_MS),
      );
      if (event.customInstructions?.trim()) {
        fail('Custom /compact guidance is unsupported by V2; it uses current instructions.');
      }
      if (resolution.kind === 'invalid') fail(resolution.reason);
      const checkpoint = resolution;
      if (!supportedModel(ctx.model)) {
        fail('This encrypted checkpoint requires its legacy Codex producing model.');
      }
      const projection = ctx.sessionManager.buildSessionProjection();
      const portable = portableMode();
      const sources = effectiveSources(projection, checkpoint);
      const instructions = ctx.getSystemPrompt();
      const reasoning = pi.getThinkingLevel();
      const tools = getCurrentTools(projection.messages);
      const blockImages = pi.getSettings().images?.blockImages ?? false;
      const before = snapshot(branch, instructions, reasoning, tools, blockImages);
      const coverage = coverageFor(branch, projection, checkpoint);
      const coveredThrough = branch.at(-1)?.id;
      if (!coveredThrough || !coverage.length) {
        fail('No effective history to compact.');
      }
      // Keep transcript system/tool deltas for the adapter's historical grammar/tool
      // mapping; override only this operation's current instructions in onPayload.
      const messages = filterContext(projection.messages, projection, checkpoint);
      const active = operation;
      const connection = await active.race(connectionResolver(ctx, active.signal));
      if (!portable && checkpoint.kind === 'valid')
        assertIdentity(connection.identity, checkpoint.details.identity);
      const textTask = portableCompact(
        event.preparation,
        branch,
        connection,
        active.signal,
        reasoning,
        ctx.sessionManager.getSessionId(),
      );
      // Keep synchronous serialization failures inside the observed sibling promise.
      const encryptedTask = portable
        ? Promise.resolve(undefined)
        : (async () => {
            return requestV2(
              connection,
              { messages: convertWithImagePolicy(messages, blockImages) },
              {
                signal: active.signal,
                reasoning: reasoning === 'off' ? undefined : reasoning,
                sessionId: ctx.sessionManager.getSessionId(),
              },
              (body) => {
                if (blockImages !== (pi.getSettings().images?.blockImages ?? false)) {
                  fail('Image policy changed during compaction; request discarded.');
                }
                body.instructions = instructions;
                const classified = expandClassified(
                  classifyWire(body.input as Record<string, unknown>[], sources, blockImages),
                  checkpoint,
                  blockImages,
                );
                const { input: _input, service_tier: _tier, ...request } = body;
                return fitRequest(
                  { ...request, instructions },
                  classified,
                  connection.model.contextWindow,
                );
              },
              checkpoint.kind === 'valid' ? checkpoint.details.identity : undefined,
            );
          })();
      // Promise.all observes both promises; abort the sibling on any rejection.
      const [text, result] = await active.race(
        Promise.all([textTask, encryptedTask]).catch((error) => {
          active.abort(error);
          throw error;
        }),
      );
      assertIdentity(
        (await active.race(connectionResolver(ctx, active.signal))).identity,
        connection.identity,
      );
      active.signal.throwIfAborted();
      if (
        before !==
        snapshot(
          ctx.sessionManager.getBranch(),
          ctx.getSystemPrompt(),
          pi.getThinkingLevel(),
          getCurrentTools(ctx.sessionManager.buildSessionProjection().messages),
          pi.getSettings().images?.blockImages ?? false,
        )
      ) {
        fail('Session or request state changed during compaction; checkpoint discarded.');
      }
      if (portable) return { compaction: text };
      if (!result) fail('Encrypted operation did not complete.');
      const anchor = newAnchor();
      const details: Checkpoint = {
        type: TYPE,
        version: 2,
        anchor,
        summaryHash: digest(text.summary),
        firstKeptEntryId: text.firstKeptEntryId,
        readFiles: text.details?.readFiles ?? [],
        modifiedFiles: text.details?.modifiedFiles ?? [],
        identity: connection.identity,
        coveredThrough,
        coverage,
        window: [
          ...retainUsers(result.input),
          {
            item: result.checkpoint,
            sourceKind: 'checkpoint',
            sourceIds: [],
          },
        ],
        responseId: result.responseId,
      };
      return {
        compaction: {
          summary: text.summary,
          firstKeptEntryId: text.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details,
          usage: combinedUsage(text.usage, result.usage),
        },
      };
    } catch (error) {
      operation?.abort(error);
      report(ctx, error);
      return { cancel: true };
    } finally {
      operation?.dispose();
    }
  });

  // Conversation-only pruning makes Pi restore just the current system/tool head.
  // Own the full-transcript phase instead; preserve its leading prompt and every delta.
  // Pi still applies prepared/hidden declarations and forced instructions afterward.
  pi.on('context_with_system', async (event, ctx) => {
    try {
      const checkpoint = requireCheckpoint(ctx.sessionManager.getBranch());
      if (checkpoint.kind === 'absent' || portableMode()) return undefined;
      const connection = await connectionResolver(ctx, ctx.signal);
      assertIdentity(connection.identity, checkpoint.details.identity);
      return {
        messages: filterContext(
          event.messages,
          ctx.sessionManager.buildSessionProjection(),
          checkpoint,
        ),
      };
    } catch (error) {
      ctx.abort();
      report(ctx, error);
      throw new CompactionError('Unsafe encrypted history replay cancelled (best effort).');
    }
  });

  pi.on('before_provider_headers', (event, ctx) => {
    try {
      const checkpoint = requireCheckpoint(ctx.sessionManager.getBranch());
      if (portableMode() || (checkpoint.kind === 'absent' && !supportedModel(ctx.model))) return;
      // Cached WS connections retain their handshake headers: advertise before first compaction.
      const merged = betaHeaders({ ...ctx.model?.headers, ...event.headers });
      for (const key of Object.keys(event.headers)) {
        if (key.toLowerCase() === 'x-codex-beta-features') {
          delete event.headers[key];
        }
      }
      event.headers['x-codex-beta-features'] = merged['x-codex-beta-features'];
    } catch (error) {
      ctx.abort();
      report(ctx, error);
      throw new CompactionError('Unsafe encrypted history headers cancelled (best effort).');
    }
  });

  pi.on('before_provider_request', async (event, ctx) => {
    try {
      const checkpoint = requireCheckpoint(ctx.sessionManager.getBranch());
      if (checkpoint.kind === 'absent' || portableMode()) return undefined;
      const connection = await connectionResolver(ctx, ctx.signal);
      assertIdentity(connection.identity, checkpoint.details.identity);
      if (
        !record(event.payload) ||
        !Array.isArray(event.payload.input) ||
        !event.payload.input.every(record)
      ) {
        fail('Unsupported provider payload for encrypted checkpoint replay.');
      }
      if (event.payload.model !== checkpoint.details.identity.model) {
        fail('Checkpoint payload requires its producing model.');
      }
      // Only input changes: normal Pi instructions, prepared tools/options and transport remain intact.
      return {
        ...event.payload,
        input: replaceAnchor(
          event.payload.input,
          checkpoint,
          pi.getSettings().images?.blockImages ?? false,
        ),
      };
    } catch (error) {
      ctx.abort();
      report(ctx, error);
      throw new CompactionError('Unsafe encrypted history replay cancelled (best effort).');
    }
  });

  pi.on('session_before_tree', (event, ctx) => {
    if (
      event.preparation.userWantsSummary &&
      (resolveCheckpoint(ctx.sessionManager.getBranch()).kind !== 'absent' ||
        event.preparation.entriesToSummarize.some(
          (e) => e.type === 'compaction' && ownsCheckpoint(e),
        ))
    ) {
      report(
        ctx,
        new CompactionError(
          'Textual tree summaries across opaque history are unsupported. Navigate without a summary, before the checkpoint, or start a new session.',
        ),
      );
      return { cancel: true };
    }
    return undefined;
  });
  pi.on('session_start', (_event, ctx) => {
    const checkpoint = resolveCheckpoint(ctx.sessionManager.getBranch());
    if (checkpoint.kind === 'invalid') {
      report(ctx, new CompactionError(checkpoint.reason));
    }
  });
  pi.on('session_compact_failed', (event, ctx) => {
    if (event.fromExtension && !event.aborted) {
      report(
        ctx,
        new CompactionError(
          'Checkpoint persistence/host compaction failed. Memory may be ahead of disk. Stop and reopen from disk; in-memory presence is not durability proof.',
        ),
      );
    }
  });
}
