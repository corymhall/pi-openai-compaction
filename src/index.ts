import {
  CompactionEntry,
  convertToLlm,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { type Model } from '@earendil-works/pi-ai';
import type {
  ResponseCreateParamsStreaming,
  ResponseCompactParams,
  ResponseOutputItem,
  CompactedResponse,
} from 'openai/resources/responses/responses';
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared';
import OpenAI from 'openai';
import { dirname, join } from 'node:path';
import { arch, homedir, platform, release } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CompactionResult } from '@earendil-works/pi-coding-agent';

interface CodexRequestConfig extends Pick<
  ResponseCreateParamsStreaming,
  | 'tools'
  | 'reasoning'
  | 'text'
  | 'parallel_tool_calls'
  | 'service_tier'
  | 'prompt_cache_key'
> {}

type CodexCompactRequest = ResponseCompactParams &
  Pick<
    ResponseCreateParamsStreaming,
    'tools' | 'reasoning' | 'text' | 'parallel_tool_calls' | 'service_tier'
  >;

function normalizeBaseUrl(
  baseUrl: string | undefined,
  fallback: string,
): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return fallback;
  return trimmed.replace(/\/+$/, '');
}

function resolveCodexResponsesEndpoint(model: Model<any>): string {
  const baseUrl = normalizeBaseUrl(
    typeof model.baseUrl === 'string' ? model.baseUrl : undefined,
    'https://chatgpt.com/backend-api',
  );
  if (baseUrl.endsWith('/codex/responses')) return baseUrl;
  if (baseUrl.endsWith('/codex')) return `${baseUrl}/responses`;
  return `${baseUrl}/codex/responses`;
}

export type JsonRecord = Record<string, unknown>;
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isResponsesPayload(
  value: unknown,
): value is ResponseCreateParamsStreaming {
  return (
    typeof value === 'object' &&
    value !== null &&
    'stream' in value &&
    value.stream === true
  );
}

// pi starts
//   │
//   ├─► project_trust (user/global and CLI extensions only, before project resources load)
//   ├─► session_start { reason: "startup" }
//   └─► resources_discover { reason: "startup" }
//       │
//       ▼
// user sends prompt ─────────────────────────────────────────┐
//   │                                                        │
//   ├─► (extension commands checked first, bypass if found)  │
//   ├─► input (can intercept, transform, or handle)          │
//   ├─► (skill/template expansion if not handled)            │
//   ├─► before_agent_start (can inject message, modify system prompt)
//   ├─► agent_start                                          │
//   ├─► message_start / message_update / message_end         │
//   │                                                        │
//   │   ┌─── turn (repeats while LLM calls tools) ───┐       │
//   │   │                                            │       │
//   │   ├─► turn_start                               │       │
//   │   ├─► context (can modify messages)            │       │
//   │   ├─► before_provider_headers (can mutate headers)     |
//   │   ├─► before_provider_request (can inspect or replace payload)
//   │   ├─► after_provider_response (status + headers, before stream consume)
//   │   │                                            │       │
//   │   │   LLM responds, may call tools:            │       │
//   │   │     ├─► tool_execution_start               │       │
//   │   │     ├─► tool_call (can block)              │       │
//   │   │     ├─► tool_execution_update              │       │
//   │   │     ├─► tool_result (can modify)           │       │
//   │   │     └─► tool_execution_end                 │       │
//   │   │                                            │       │
//   │   └─► turn_end                                 │       │
//   │                                                        │
//   ├─► agent_end                                            │
//   └─► agent_settled (no retry/compaction/follow-up left)   │
//                                                            │
// user sends another prompt ◄────────────────────────────────┘
//
// /new (new session) or /resume (switch session)
//   ├─► session_before_switch (can cancel)
//   ├─► session_shutdown
//   ├─► session_start { reason: "new" | "resume", previousSessionFile? }
//   └─► resources_discover { reason: "startup" }
//
// /fork or /clone
//   ├─► session_before_fork (can cancel)
//   ├─► session_shutdown
//   ├─► session_start { reason: "fork", previousSessionFile }
//   └─► resources_discover { reason: "startup" }
//
// /name or pi.setSessionName()
//   └─► session_info_changed
//
// /compact or auto-compaction
//   ├─► session_before_compact (can cancel or customize)
//   └─► session_compact
//
// /tree navigation
//   ├─► session_before_tree (can cancel or customize)
//   └─► session_tree
//
// /model or Ctrl+P (model selection/cycling)
//   ├─► thinking_level_select (if model change changes/clamps thinking level)
//   └─► model_select
//
// thinking level changes (settings, keybinding, pi.setThinkingLevel())
//   └─► thinking_level_select
//
// exit (Ctrl+C, Ctrl+D, SIGHUP, SIGTERM)
//   └─► session_shutdown
//
export default function (pi: ExtensionAPI) {
  let lastCodexRequestConfig: CodexRequestConfig | undefined;
  // pi starts
  // runs right after project_trust
  // { reason: "startup" | "resume" | "fork", previousSessionFile? }
  pi.on('session_start', async (_event, _ctx) => {});

  // user sends prompt
  // Can inject message, modify system prompt
  pi.on('before_agent_start', async (_event, _ctx) => {});
  pi.on('agent_start', async (_event, _ctx) => {});
  pi.on('message_start', async (_event, _ctx) => {});
  pi.on('message_update', async (_event, _ctx) => {});
  pi.on('message_end', async (_event, _ctx) => {});

  // turn
  pi.on('turn_start', async (_event, _ctx) => {});
  // can modify messages
  pi.on('context', async (_event, _ctx) => {});
  // can mutate headers
  pi.on('before_provider_headers', async (_event, _ctx) => {});
  // can inspect or replace payload
  pi.on('before_provider_request', async (event, ctx) => {
    if (!isResponsesPayload(event.payload)) {
      return undefined;
    }
    if (ctx.model?.api !== 'openai-codex-responses') {
      return undefined;
    }
    const newPayload: ResponseCreateParamsStreaming = {
      ...(event.payload as ResponseCreateParamsStreaming),
    };

    lastCodexRequestConfig = {
      tools: newPayload.tools,
      parallel_tool_calls: newPayload.parallel_tool_calls,
      prompt_cache_key: newPayload.prompt_cache_key,
      reasoning: newPayload.reasoning,
      service_tier: newPayload.service_tier,
      text: newPayload.text,
    };
    const entries = ctx.sessionManager.buildContextEntries();
    const compactionEntry = entries.find((entry) => {
      if (entry.type !== 'compaction') return false;
      if (
        entry.details &&
        typeof entry.details === 'object' &&
        'type' in entry.details &&
        entry.details.type === 'openai-native-compaction'
      ) {
        return true;
      }
      return false;
    }) as CompactionEntry<OpenAICompactionEntry> | undefined;

    if (!Array.isArray(newPayload.input) || !compactionEntry) {
      return newPayload;
    }
    const markerIndex = newPayload.input.findIndex((input) => {
      if ('role' in input && input.role === 'user') {
        if (Array.isArray(input.content)) {
          const content = input.content[0];
          if (content.type === 'input_text') {
            if (content.text.includes(NATIVE_COMPACTION_MARKER)) {
              return true;
            }
          }
        } else {
          if (input.content.includes(NATIVE_COMPACTION_MARKER)) {
            return true;
          }
        }
      }
      return false;
    });
    if (markerIndex >= 0) {
      // TODO: not sure if it is possible to find a compaction entry, but
      // not have a compaction summary so this just assumes they have to go together
      newPayload.input = [
        ...newPayload.input.slice(0, markerIndex),
        // TODO: we should probably validate that the output is the correct shape
        ...(compactionEntry?.details?.output ?? []),
        ...newPayload.input.slice(markerIndex + 1),
      ];
    }
    return newPayload;
  });
  // status + headers, before stream consume
  pi.on('after_provider_response', async (_event, _ctx) => {});
  pi.on('turn_end', async (_event, _ctx) => {});

  pi.on('agent_end', async (_event, _ctx) => {});
  // no retry/compaction/follow-up left
  pi.on('agent_settled', async (_event, _ctx) => {});

  // /new or /resume
  pi.on('session_before_switch', async (_event, _ctx) => {});
  pi.on('session_shutdown', async (_event, _ctx) => {});

  // /fork or /clone
  pi.on('session_before_fork', async (_event, _ctx) => {});

  // /compact or auto-compaction
  pi.on('session_before_compact', async (event, ctx) => {
    if (!ctx.model || ctx.model.api !== 'openai-codex-responses') {
      return undefined;
    }
    const sessionId = ctx.sessionManager.getSessionId();
    const model: Model<'openai-codex-responses'> = ctx.model;
    const headers = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!headers.ok || !headers.apiKey) return undefined;

    const codexIdentityHeaders = {
      originator: 'pi',
      'session-id': sessionId,
      'x-codex-installation-id': resolveCodexInstallationId(),
    };
    const commonHeaders = withRemoteCompactionV2Feature({
      authorization: `Bearer ${headers.apiKey}`,
      ...codexIdentityHeaders,
      ...(headers.headers ?? {}),
      // accept: 'text/event-stream',
      'content-type': 'application/json',
    });
    const client = new OpenAI({
      apiKey: headers.apiKey,
      baseURL: (headers.baseUrl ?? model.baseUrl) + '/codex',
      defaultHeaders: {
        ...commonHeaders,
        'chatgpt-account-id': extractCodexAccountId(headers.apiKey),
        originator: 'pi',
        'user-agent': `pi-openai-server-compaction (${platform()} ${release()}; ${arch()})`,
        'OpenAI-Beta': 'responses=experimental',
      },
    });
    event.preparation.turnPrefixMessages;
    const messages = convertToLlm([
      ...event.preparation.messagesToSummarize,
      ...event.preparation.turnPrefixMessages,
    ]);

    const input = convertResponsesMessages(
      model,
      {
        messages,
        tools: undefined, // do I need this?
      },
      new Set(['openai-codex']),
      {
        grammarToolInputProperties: undefined, // do I need this?
        deferredTools: undefined, // do I need this?
        toolOptions: {
          supportsStrictMode: model.compat?.supportsStrictMode,
        },
      },
    );
    const body: CodexCompactRequest = {
      model: model.id,
      input,
      instructions: ctx.getSystemPrompt(),
      ...lastCodexRequestConfig,
    };
    const response = await client.post<CompactedResponse>(
      '/responses/compact',
      {
        body,
        signal: event.signal,
      },
    );

    const compaction: CompactionResult<OpenAICompactionEntry> = {
      tokensBefore: event.preparation.tokensBefore,
      summary: NATIVE_COMPACTION_MARKER,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      estimatedTokensAfter: 0,
      details: {
        type: 'openai-native-compaction',
        version: '1',
        provider: model.provider,
        // store the entire output which can contain:
        // - encrypted compaction item
        // - some original messages that the server decided to retain
        // - reasoning items
        // - tool calls and tool results that must remain available
        output: response.output,
      },
      // TODO: I think there is more conversion here than just a field mapping
      usage: {
        cacheRead: response.usage.input_tokens_details.cached_tokens,
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        totalTokens: response.usage.total_tokens,
        reasoning: response.usage.output_tokens_details.reasoning_tokens,
        cacheWrite: 0,
        cost: {
          cacheWrite: 0,
          cacheRead: response.usage.input_tokens_details.cached_tokens,
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
          total: response.usage.total_tokens,
        },
      },
    };
    return {
      compaction,
    };
  });
  pi.on('session_compact', async (event, ctx) => {});

  // /tree navigation
  pi.on('session_before_tree', async (_event, _ctx) => {});
  pi.on('session_tree', async (_event, _ctx) => {});
}
type OpenAICompactionEntry = {
  type: string;
  version: string;
  provider: string;
  output: ResponseOutputItem[];
};
const RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;
const NATIVE_COMPACTION_MARKER = 'NATIVE_COMPACTION_MARKER';

function resolveCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? configured : join(homedir(), '.codex');
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function resolveCodexInstallationId(): string {
  const path = join(resolveCodexHome(), 'installation_id');
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf8').trim();
      if (UUID_RE.test(existing)) return existing.toLowerCase();
    }
  } catch {
    // Fall through and regenerate below, matching Codex's invalid-file behavior.
  }

  const installationId = randomUUID();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, installationId);
  } catch {
    // Header is a parity hint, not a reason to fail compaction.
  }
  return installationId;
}

const REMOTE_COMPACTION_V2_FEATURE = 'remote_compaction_v2';
function withRemoteCompactionV2Feature(
  headers: Record<string, string>,
): Record<string, string> {
  const configuredFeatures =
    Object.entries(headers)
      .find(([name]) => name.toLowerCase() === 'x-codex-beta-features')?.[1]
      ?.split(',')
      .map((feature) => feature.trim())
      .filter(Boolean) ?? [];
  const headersWithoutFeature = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => name.toLowerCase() !== 'x-codex-beta-features',
    ),
  );
  const features = [
    ...new Set([...configuredFeatures, REMOTE_COMPACTION_V2_FEATURE]),
  ];
  return {
    ...headersWithoutFeature,
    'x-codex-beta-features': features.join(','),
  };
}

function extractCodexAccountId(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Failed to extract accountId from Codex token');
  }
  const payload = JSON.parse(
    Buffer.from(parts[1], 'base64url').toString('utf8'),
  ) as {
    [key: string]: unknown;
  };
  const auth = isRecord(payload['https://api.openai.com/auth'])
    ? payload['https://api.openai.com/auth']
    : undefined;
  const accountId = auth?.chatgpt_account_id;
  if (typeof accountId !== 'string' || !accountId) {
    throw new Error('Failed to extract accountId from Codex token');
  }
  return accountId;
}
