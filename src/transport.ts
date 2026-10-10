import {
  normalizeContext,
  type Context,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type Usage,
} from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  assertIdentity,
  CompactionError,
  digest,
  fail,
  record,
  type ClassifiedItem,
  type Identity,
  type Json,
} from './checkpoint.js';

/** Operation-scoped auth resolved through Pi; credentials never enter persisted checkpoint state. */
export interface Connection {
  model: Model<'openai-codex-responses'>;
  provider: Provider;
  apiKey: string;
  headers: Record<string, string | null>;
  identity: Identity;
}
export function supportedModel(
  model: Model<any> | undefined,
): model is Model<'openai-codex-responses'> {
  return model?.provider === 'openai-codex' && model.api === 'openai-codex-responses';
}
export function endpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/codex/responses')
    ? base
    : base.endsWith('/codex')
      ? `${base}/responses`
      : `${base}/codex/responses`;
}
export async function resolveConnection(
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<Connection> {
  if (!supportedModel(ctx.model) || !ctx.modelRegistry.isUsingOAuth(ctx.model)) {
    fail('Only the legacy openai-codex ChatGPT login is supported.');
  }
  signal?.throwIfAborted();
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  signal?.throwIfAborted();
  if (!auth.ok || !auth.apiKey) {
    fail('Legacy ChatGPT authentication is unavailable; reconnect the legacy login.');
  }
  const url = endpoint(auth.baseUrl ?? ctx.model.baseUrl);
  if (url !== 'https://chatgpt.com/backend-api/codex/responses') {
    fail('Custom endpoints, gateways and nonlegacy connections are unsupported.');
  }
  let account: unknown;
  try {
    const claims = JSON.parse(Buffer.from(auth.apiKey.split('.')[1], 'base64url').toString('utf8'));
    account = claims['https://api.openai.com/auth']?.chatgpt_account_id;
  } catch {
    fail('Legacy ChatGPT account identity is unavailable.');
  }
  if (typeof account !== 'string' || !account) {
    fail('Legacy ChatGPT account identity is unavailable.');
  }
  const provider = ctx.modelRegistry.getProvider(ctx.model.provider);
  if (!provider) fail('Legacy Codex provider is unavailable.');
  const headers = { ...auth.headers };
  return {
    model: { ...ctx.model, baseUrl: auth.baseUrl ?? ctx.model.baseUrl },
    provider,
    apiKey: auth.apiKey,
    headers,
    identity: {
      provider: ctx.model.provider,
      api: ctx.model.api,
      model: ctx.model.id,
      endpoint: url,
      account: digest(account),
    },
  };
}
export function betaHeaders(headers: Record<string, string | null>): Record<string, string | null> {
  const existing = Object.entries(headers)
    .filter(([k]) => k.toLowerCase() === 'x-codex-beta-features')
    .flatMap(
      ([, v]) =>
        v
          ?.split(',')
          .map((f) => f.trim())
          .filter(Boolean) ?? [],
    );
  return {
    ...Object.fromEntries(
      Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'x-codex-beta-features'),
    ),
    'x-codex-beta-features': [...new Set([...existing, 'remote_compaction_v2'])].join(','),
  };
}
/** One synthetic stream only: normalized completion is not proof of a valid V2 checkpoint. */
export class RawCollector {
  private checkpoints: Json[] = [];
  private terminal: Json | undefined;
  private failed = false;
  observe(data: unknown): void {
    if (!record(data)) {
      this.failed = true;
      return;
    }
    if (this.terminal) {
      this.failed = true;
      return;
    }
    if (
      ['error', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(
        String(data.type),
      )
    ) {
      this.failed = true;
    }
    if (
      data.type === 'response.output_item.done' &&
      record(data.item) &&
      data.item.type === 'compaction'
    ) {
      this.checkpoints.push(structuredClone(data.item));
    }
    if (data.type === 'response.completed') {
      // Pinned Codex accepts a completed event with only response.id; status is optional.
      if (
        !record(data.response) ||
        (data.response.status !== undefined && data.response.status !== 'completed')
      ) {
        this.failed = true;
      } else {
        this.terminal = structuredClone(data.response);
      }
    }
  }
  finish(): { checkpoint: Json; responseId: string; usage?: Usage } {
    if (
      this.failed ||
      !this.terminal ||
      typeof this.terminal.id !== 'string' ||
      !this.terminal.id ||
      this.checkpoints.length !== 1 ||
      typeof this.checkpoints[0].encrypted_content !== 'string' ||
      !this.checkpoints[0].encrypted_content.trim()
    ) {
      fail('Remote V2 did not return one valid encrypted checkpoint and a completed response.');
    }
    return {
      checkpoint: this.checkpoints[0],
      responseId: this.terminal.id,
      usage: mapUsage(this.terminal.usage),
    };
  }
}
export function mapUsage(raw: unknown): Usage | undefined {
  if (!record(raw)) return undefined;
  const number = (n: unknown): number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
      ? n
      : fail('Invalid compaction usage.');
  const input = number(raw.input_tokens),
    output = number(raw.output_tokens);
  const cached = record(raw.input_tokens_details)
    ? number(raw.input_tokens_details.cached_tokens ?? 0)
    : 0;
  const written = record(raw.input_tokens_details)
    ? number(raw.input_tokens_details.cache_write_tokens ?? 0)
    : 0;
  const reasoning =
    record(raw.output_tokens_details) && raw.output_tokens_details.reasoning_tokens !== undefined
      ? number(raw.output_tokens_details.reasoning_tokens)
      : undefined;
  if (cached + written > input || (reasoning !== undefined && reasoning > output)) {
    fail('Invalid compaction usage subtotals.');
  }
  return {
    input: input - cached - written,
    output,
    cacheRead: cached,
    cacheWrite: written,
    reasoning,
    totalTokens: number(raw.total_tokens ?? input + output),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
export interface Deadline {
  signal: AbortSignal;
  dispose(): void;
  race<T>(promise: Promise<T>): Promise<T>;
}
/** Bound auth, serialization and streaming together; disposal does not roll back host writes. */
export function deadline(parent: AbortSignal, ms: number): Deadline {
  if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 30 * 60_000) {
    fail('Compaction deadline must be between 1000 and 1800000 ms.');
  }
  const controller = new AbortController();
  const abort = () => controller.abort(new CompactionError('Compaction cancelled.'));
  parent.addEventListener('abort', abort, { once: true });
  if (parent.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new CompactionError('Compaction operation deadline expired.')),
    ms,
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener('abort', abort);
    },
    async race<T>(promise: Promise<T>): Promise<T> {
      if (controller.signal.aborted) {
        // Still observe the started operation: a late rejection must not become unhandled.
        return Promise.race([Promise.reject(controller.signal.reason), promise]);
      }
      let listener: () => void = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        listener = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', listener, { once: true });
      });
      try {
        return await Promise.race([promise, aborted]);
      } finally {
        controller.signal.removeEventListener('abort', listener);
      }
    },
  };
}
/** Serialize through Pi's provider, then append one trigger; never execute returned tool calls. */
export async function requestV2(
  connection: Connection,
  context: Context,
  options: SimpleStreamOptions,
  preparePayload: (body: Json) => ClassifiedItem[],
  expectedIdentity?: Identity,
): Promise<{
  checkpoint: Json;
  responseId: string;
  usage?: Usage;
  input: ClassifiedItem[];
}> {
  if (expectedIdentity) assertIdentity(connection.identity, expectedIdentity);
  const collector = new RawCollector();
  let input: ClassifiedItem[] | undefined;
  let payloadCalls = 0;
  let normalizedDone = false;
  // A separate call with per-call raw observation; no ordinary extension hook dispatch.
  const stream = connection.provider.streamSimple(connection.model, normalizeContext(context), {
    ...options,
    apiKey: connection.apiKey,
    headers: betaHeaders({
      ...connection.model.headers,
      ...connection.headers,
    }),
    transport: 'sse',
    maxRetries: 0,
    onPayload(body) {
      options.signal?.throwIfAborted();
      if (
        ++payloadCalls !== 1 ||
        !record(body) ||
        !Array.isArray(body.input) ||
        !body.input.every(record)
      ) {
        fail('Unexpected Codex compaction payload.');
      }
      if (body.model !== connection.model.id) {
        fail('Synthetic compaction payload selected a different model.');
      }
      input = preparePayload(body);
      const { service_tier: _tier, ...operation } = body;
      return {
        ...operation,
        store: false,
        stream: true,
        parallel_tool_calls: true,
        input: [...input.map((c) => c.item), { type: 'compaction_trigger' }],
      };
    },
    onProviderStreamEvent(data) {
      collector.observe(data);
    },
  });
  for await (const event of stream) {
    options.signal?.throwIfAborted();
    if (event.type === 'error') {
      fail('Remote V2 provider operation failed or was cancelled; no checkpoint installed.');
    }
    if (event.type === 'done') normalizedDone = true;
  }
  options.signal?.throwIfAborted();
  if (!normalizedDone || !input) {
    fail('Remote V2 stream ended before successful completion.');
  }
  return { ...collector.finish(), input };
}
