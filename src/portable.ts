import { compact, type CompactionResult, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { contentText, type Usage } from '@earendil-works/pi-ai';
import { fail, record } from './checkpoint.js';
import type { Connection } from './transport.js';

/**
 * Produce ordinary Pi text from the event's prepared prefix and previous summary,
 * independently of encrypted whole-window replay. The supplied operation connection
 * is used directly so normal context/payload hooks cannot inject ciphertext.
 * The caller owns the shared cancellation deadline and combines returned usage.
 */
export async function portableCompact(
  preparation: Parameters<typeof compact>[0],
  branch: SessionEntry[],
  connection: Connection,
  signal: AbortSignal,
  thinking: Parameters<typeof compact>[6],
  sessionId: string,
): Promise<CompactionResult<{ readFiles: string[]; modifiedFiles: string[] }>> {
  const prepared = structuredClone(preparation);
  const previous = branch.filter((e) => e.type === 'compaction').at(-1);
  // Pi deliberately ignores file details from fromHook entries. Preserve our own
  // cumulative portable file lists explicitly, without reopening omitted history.
  if (previous?.fromHook && record(previous.details)) {
    for (const path of Array.isArray(previous.details.readFiles)
      ? previous.details.readFiles
      : []) {
      if (typeof path === 'string') prepared.fileOps.read.add(path);
    }
    for (const path of Array.isArray(previous.details.modifiedFiles)
      ? previous.details.modifiedFiles
      : []) {
      if (typeof path === 'string') prepared.fileOps.edited.add(path);
    }
  }
  const result = await compact(
    prepared,
    connection.model,
    connection.apiKey,
    undefined,
    undefined,
    signal,
    thinking,
    async (model, context, options) => {
      const stream = connection.provider.streamSimple(model, context, {
        ...options,
        apiKey: connection.apiKey,
        headers: { ...connection.model.headers, ...connection.headers },
        transport: 'sse',
        maxRetries: 0,
      });
      const completion = await stream.result();
      signal.throwIfAborted();
      // Validate every individual history/prefix completion before Pi adds file
      // tags or merges it with the previous summary and split-turn wrapper.
      if (
        completion.stopReason !== 'stop' ||
        completion.content.some((part) => part.type === 'toolCall') ||
        !contentText(completion.content).trim()
      ) {
        fail('Portable text completion failed, was incomplete, or returned no summary.');
      }
      // result() retains its resolved completion; Pi can read it again unchanged.
      return stream;
    },
    undefined,
    { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    undefined,
    sessionId,
  );
  signal.throwIfAborted();
  if (!result.summary.trim()) fail('Portable compaction returned an empty summary.');
  return result as CompactionResult<{ readFiles: string[]; modifiedFiles: string[] }>;
}
/** Add actual operation usage; reasoning is an output subtotal, not extra tokens. */
export function combinedUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    reasoning:
      a.reasoning === undefined && b.reasoning === undefined
        ? undefined
        : (a.reasoning ?? 0) + (b.reasoning ?? 0),
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}
