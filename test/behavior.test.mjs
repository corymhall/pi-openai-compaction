import { afterEach, beforeEach, expect, test } from 'vitest';
import { createServer } from 'node:http';
import { zstdDecompressSync, deflateSync, crc32 } from 'node:zlib';
import { once } from 'node:events';
import { mkdtempSync, rmSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import { install } from '../src/index.ts';
import { WARNING, digest, resolveCheckpoint } from '../src/checkpoint.ts';
import { filterContext, replaceAnchor, anchorText } from '../src/projection.ts';
import { retainUsers, fitRequest, middleTruncate } from '../src/retention.ts';
import {
  RawCollector,
  requestV2,
  deadline,
  mapUsage,
  resolveConnection,
} from '../src/transport.ts';

let root, server, baseUrl, settings, runtime, model, identity;
// Valid 1x1 RGBA PNG: exercise Pi's real image pipeline, not an omitted invalid image.
function pngChunk(name, data) {
  const type = Buffer.from(name);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([size, type, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(1, 0);
ihdr.writeUInt32BE(1, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const IMAGE_DATA = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
  pngChunk('IEND', Buffer.alloc(0)),
]).toString('base64');
const fakeKey =
  'synthetic.' +
  Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'local-account' },
    }),
  ).toString('base64url') +
  '.synthetic';
const requests = [];
const responses = [];
const sockets = new Set();
let compactions = 0;
let wireMode = 'good';
let onSyntheticReceived;

let identityOverrides = {};
const connection = async (ctx) => {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  return {
    model: { ...ctx.model, baseUrl },
    provider: ctx.modelRegistry.getProvider(model.provider),
    apiKey: fakeKey,
    headers: { ...auth.headers, 'x-codex-beta-features': 'existing-feature' },
    identity: { ...identity, model: ctx.model.id, ...identityOverrides },
  };
};
let session,
  context,
  toolRuns = 0;
let deadlineMs = '300000';
let customFailure;
let forcePrompt = true;
let transientText;
const phaseSnapshots = [];
const outcomes = [];
const rawObserved = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'pi-v2-behavior-'));
  requests.length =
    responses.length =
    outcomes.length =
    rawObserved.length =
    phaseSnapshots.length =
      0;
  compactions = toolRuns = 0;
  wireMode = 'good';
  deadlineMs = '300000';
  identityOverrides = {};
  customFailure = transientText = onSyntheticReceived = undefined;
  forcePrompt = true;
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const body = JSON.parse(
      (req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(raw) : raw).toString('utf8'),
    );
    requests.push({ body, headers: req.headers });
    const synthetic = body.input.at(-1)?.type === 'compaction_trigger';
    const reply = synthetic
      ? { checkpoint: 'sealed-' + ++compactions, tokens: 200 }
      : responses.shift();
    expect(reply, 'missing staged normal response').toBeTruthy();
    if (synthetic && wireMode === 'http-error') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'local unavailable' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const id = 'response-' + requests.length;
    send({ type: 'response.created', response: { id, status: 'in_progress' } });
    if (!synthetic && reply.overflow) {
      send({
        type: 'error',
        code: 'context_length_exceeded',
        message: 'maximum context length exceeded',
      });
      res.end();
      return;
    }
    if (synthetic) {
      onSyntheticReceived?.();
      if (wireMode === 'stall') return;
      if (wireMode === 'eof') {
        res.end();
        return;
      }
      if (wireMode === 'error') {
        send({ type: 'error', message: 'local failure' });
        res.end();
        return;
      }
    }
    const item = synthetic
      ? {
          type: 'compaction',
          id: 'cmp-' + compactions,
          encrypted_content: reply.checkpoint,
          opaque_extra: { preserve: true },
        }
      : reply.tool
        ? {
            type: 'function_call',
            id: 'fc_' + requests.length,
            call_id: 'call-' + requests.length,
            name: 'probe',
            arguments: '{}',
          }
        : {
            type: 'message',
            id: 'msg_' + requests.length,
            role: 'assistant',
            content: [{ type: 'output_text', text: 'local reply', annotations: [] }],
            status: 'completed',
          };
    if (synthetic && wireMode === 'good') {
      const ignored = {
        type: 'function_call',
        id: 'fc_ignored',
        call_id: 'ignored',
        name: 'probe',
        arguments: '{}',
      };
      send({
        type: 'response.output_item.added',
        output_index: 1,
        item: ignored,
      });
      send({ type: 'response.output_item.done', output_index: 1, item: ignored });
    }
    if (!synthetic) {
      send({ type: 'response.output_item.added', output_index: 0, item });
      if (!reply.tool)
        send({
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          delta: 'local reply',
        });
    }
    send({
      type: 'response.output_item.done',
      output_index: 0,
      item: synthetic && wireMode === 'empty' ? { ...item, encrypted_content: '' } : item,
    });
    if (synthetic && wireMode === 'multiple')
      send({
        type: 'response.output_item.done',
        output_index: 1,
        item: { ...item, id: 'duplicate' },
      });
    send({
      type: synthetic && wireMode === 'incomplete' ? 'response.incomplete' : 'response.completed',
      response: {
        id,
        // The pinned Codex SSE parser accepts completed terminals without status metadata.
        ...(synthetic && wireMode === 'good'
          ? {}
          : {
              status: synthetic && wireMode === 'incomplete' ? 'incomplete' : 'completed',
            }),
        output: [item],
        usage: {
          input_tokens: reply.tokens - 10,
          output_tokens: 10,
          total_tokens: reply.tokens,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      },
    });
    res.end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  settings = SettingsManager.inMemory({
    transport: 'sse',
    compaction: { enabled: true, reserveTokens: 1500, keepRecentTokens: 5 },
    retry: { enabled: false },
  });
  runtime = await ModelRuntime.create({
    authPath: join(root, 'synthetic-auth.json'),
    modelsPath: null,
    modelsStorePath: join(root, 'models.json'),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider('openai-codex', {
    api: 'openai-codex-responses',
    baseUrl,
    apiKey: fakeKey,
    headers: { 'X-Codex-Beta-Features': 'model-feature' },
    models: [
      {
        id: 'local-v2',
        name: 'Local V2',
        reasoning: true,
        input: ['text', 'image'],
        compat: getBuiltinModel('openai-codex', 'gpt-6.1-sol').compat,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10000,
        maxTokens: 1000,
      },
    ],
  });
  model = runtime.getModel('openai-codex', 'local-v2');
  identity = {
    provider: model.provider,
    api: model.api,
    model: model.id,
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    account: digest('local-account'),
  };
});

afterEach(async () => {
  session?.dispose();
  session = undefined;
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

function extension(pi) {
  pi.registerTool({
    name: 'probe',
    label: 'probe',
    description: 'registered probe',
    parameters: Type.Object({}),
    async execute() {
      toolRuns++;
      return {
        content: [
          { type: 'text', text: 'actual tool output' },
          { type: 'image', mimeType: 'image/png', data: IMAGE_DATA },
        ],
        details: undefined,
      };
    },
  });
  pi.registerTool({
    name: 'orchestrator',
    label: 'orchestrator',
    description: 'registered orchestrator',
    parameters: Type.Object({}),
    prepareLoadout() {
      return {
        hiddenDeclarations: ['probe'],
        descriptions: { orchestrator: 'prepared orchestrator' },
      };
    },
    async execute() {
      return { content: [], details: undefined };
    },
  });
  // Append a request-local contribution before the extension's full-transcript pruning.
  pi.on('context_with_system', (event) =>
    transientText === undefined
      ? undefined
      : {
          messages: [
            ...event.messages,
            { role: 'user', content: transientText, timestamp: Date.now() },
          ],
        },
  );
  install(pi, (ctx) =>
    customFailure ? Promise.reject(Error('SECRET SHOULD NOT BE LOGGED')) : connection(ctx),
  );
  // Fixture-only flag accessor: the normal runtime flag remains unchanged.
  const actualGet = pi.getFlag;
  pi.getFlag = (name) => (name === 'openai-compaction-deadline-ms' ? deadlineMs : actualGet(name));
  pi.on('context_with_system', (event) => {
    if (!forcePrompt) phaseSnapshots.push(structuredClone(event.messages));
  });
  pi.on('before_agent_start', () =>
    forcePrompt
      ? {
          systemPrompt: 'CURRENT FORCED INSTRUCTIONS',
        }
      : undefined,
  );
  pi.on('before_provider_request', (event) => ({
    ...event.payload,
    service_tier: 'priority',
  }));
  pi.on('session_start', (_event, ctx) => {
    context = ctx;
  });
  pi.on('provider_stream_event', (event) => {
    rawObserved.push(event.data);
  });
}
async function open(manager) {
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'base instructions',
    extensionFactories: [extension],
    disabledBuiltinExtensions: ['mcp', 'codemode', 'tool-search'],
  });
  await loader.reload();
  const created = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime: runtime,
    model,
    thinkingLevel: 'low',
    settingsManager: settings,
    sessionManager: manager,
    resourceLoader: loader,
    tools: ['probe', 'orchestrator'],
  });
  expect(created.extensionsResult.errors).toStrictEqual([]);
  await created.session.bindExtensions({
    mode: 'print',
    onError: (error) => {
      throw Error(JSON.stringify(error));
    },
  });
  created.session.subscribe((event) => {
    if (event.type === 'compaction_end') outcomes.push(event);
  });
  return created.session;
}
function users(body) {
  return body.input
    .filter((x) => x.role === 'user')
    .map((x) => x.content.map((p) => p.text ?? '[image]').join(''));
}
function normalRequests() {
  return requests.filter((r) => r.body.input.at(-1)?.type !== 'compaction_trigger');
}
function syntheticRequests() {
  return requests.filter((r) => r.body.input.at(-1)?.type === 'compaction_trigger');
}
function assertWindow(body, ciphertext, expectedUsers) {
  expect(users(body)).toStrictEqual(expectedUsers);
  expect(body.input.filter((x) => x.type === 'compaction').length).toBe(1);
  expect(body.input.find((x) => x.type === 'compaction').encrypted_content).toBe(ciphertext);
  expect(!JSON.stringify(body).includes('pi-openai-compaction:')).toBeTruthy();
}
function imageCount(value) {
  if (Array.isArray(value)) return value.reduce((n, part) => n + imageCount(part), 0);
  if (value && typeof value === 'object')
    return (
      (value.type === 'input_image' ? 1 : 0) +
      Object.values(value).reduce((n, part) => n + imageCount(part), 0)
    );
  return 0;
}
function appendHistoricalGrammar(manager) {
  manager.appendMessage({
    role: 'system',
    content: '',
    timestamp: Date.now(),
    toolsAdded: [
      {
        name: 'historical_grammar',
        description: 'old grammar',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
        },
        constrainedSampling: {
          type: 'grammar',
          variants: { openai_regex: '.*' },
        },
      },
    ],
  });
  manager.appendMessage({
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [
      {
        type: 'toolCall',
        id: 'grammar-call|ctc_history',
        name: 'historical_grammar',
        arguments: { input: 'historical input' },
      },
    ],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'grammar-call|ctc_history',
    toolName: 'historical_grammar',
    content: [{ type: 'text', text: 'historical grammar output' }],
    isError: false,
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: 'system',
    content: '',
    timestamp: Date.now(),
    toolsRemoved: [{ name: 'historical_grammar' }],
  });
}
test('recursive windows, provenance, reopen, forks, edits and persistence failures', async () => {
  const manager = SessionManager.create(root, join(root, 'sessions'));
  session = await open(manager);
  responses.push({ tokens: 300 });
  await session.prompt('same user');
  responses.push({ tokens: 400 });
  await session.prompt('same user');
  manager.appendCustomMessageEntry('local-not-user', 'same user', true);
  manager.branchWithSummary(manager.getLeafId(), 'BRANCH HISTORY');
  manager.appendMessage({
    role: 'bashExecution',
    command: 'echo shell',
    output: 'shell transcript',
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: Date.now(),
  });
  const reasoning = {
    type: 'reasoning',
    id: 'rs_local',
    summary: [],
    encrypted_content: 'opaque-reasoning',
  };
  manager.appendMessage({
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [
      {
        type: 'thinking',
        thinking: '',
        thinkingSignature: JSON.stringify(reasoning),
      },
    ],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  });
  appendHistoricalGrammar(manager);
  const rawBefore = rawObserved.length;
  await session.compact();
  expect(
    rawObserved.length,
    'synthetic raw observer is isolated from ordinary extension traffic',
  ).toBe(rawBefore);
  expect(outcomes.at(-1).aborted).toBe(false);
  expect(outcomes.at(-1).result).toBeTruthy();
  expect(compactions).toBe(1);
  expect(toolRuns, 'synthetic output tools are not actions').toBe(0);
  expect(
    requests[0].headers['x-codex-beta-features'].includes('remote_compaction_v2'),
    'capability advertised before the first checkpoint',
  ).toBeTruthy();
  expect(requests[0].headers['x-codex-beta-features'].includes('model-feature')).toBeTruthy();
  const first = syntheticRequests()[0];
  expect(
    first.headers['x-codex-beta-features'].includes('model-feature'),
    'synthetic header merge preserves model features',
  ).toBeTruthy();
  expect(users(first.body).slice(0, 3)).toStrictEqual(['same user', 'same user', 'same user']);
  expect(
    first.body.input.some(
      (x) => x.type === 'reasoning' && x.encrypted_content === 'opaque-reasoning',
    ),
  ).toBeTruthy();
  const grammarCall = first.body.input.find((x) => x.type === 'custom_tool_call');
  const grammarOutput = first.body.input.find((x) => x.type === 'custom_tool_call_output');
  expect(grammarCall.input).toBe('historical input');
  expect(grammarCall.call_id).toBe(grammarOutput.call_id);
  expect(
    !first.body.tools.some((t) => t.name === 'historical_grammar'),
    'removed tool is absent from current declarations but historical grammar call remains correctly serialized',
  ).toBeTruthy();
  expect(
    first.body.input.some(
      (x) => x.role === 'user' && JSON.stringify(x).includes('shell transcript'),
    ),
  ).toBeTruthy();
  expect(
    first.body.instructions,
    'manual compaction uses current instructions, not the previous run forced prompt',
  ).toBe(context.getSystemPrompt());
  expect(
    first.body.input.some((x) => x.role === 'user' && JSON.stringify(x).includes('BRANCH HISTORY')),
  ).toBeTruthy();
  expect(first.body.reasoning.effort).toBe('low');
  expect(first.body.service_tier).toBe(undefined);
  expect(first.headers['x-codex-beta-features'].includes('existing-feature')).toBeTruthy();
  expect(first.headers['x-codex-beta-features'].includes('remote_compaction_v2')).toBeTruthy();
  const checkpoint1 = resolveCheckpoint(manager.getBranch());
  expect(checkpoint1.kind).toBe('valid');
  expect(
    checkpoint1.details.window.filter((w) => w.sourceKind === 'user').length,
    'custom/shell/branch-summary wire users not retained',
  ).toBe(2);
  expect(checkpoint1.details.window.at(-1).item.opaque_extra.preserve).toBeTruthy();
  const file = manager.getSessionFile();
  session.dispose();
  session = await open(SessionManager.open(file));
  expect(session.getContextUsage().tokens, 'reopen before fresh usage is unknown').toBe(null);
  responses.push({ tokens: 500 });
  await session.prompt('tail C');
  assertWindow(normalRequests().at(-1).body, 'sealed-1', ['same user', 'same user', 'tail C']);
  expect(normalRequests().at(-1).body.instructions).toBe('CURRENT FORCED INSTRUCTIONS');
  expect(normalRequests().at(-1).body.service_tier).toBe('priority');
  expect(
    normalRequests().at(-1).headers['x-codex-beta-features'].includes('remote_compaction_v2'),
  ).toBeTruthy();
  expect(
    normalRequests()
      .at(-1)
      .body.tools.map((t) => t.name),
  ).toStrictEqual(['orchestrator']);
  expect(normalRequests().at(-1).body.tools[0].description).toBe('prepared orchestrator');
  expect(session.getContextUsage().tokens).toBe(500);
  responses.push({ tokens: 600, tool: true }, { tokens: 650 });
  await session.prompt('tail D', {
    images: [{ type: 'image', mimeType: 'image/png', data: IMAGE_DATA }],
  });
  expect(toolRuns).toBe(1);
  await session.compact();
  expect(compactions).toBe(2);
  const second = syntheticRequests()[1].body;
  assertWindow({ ...second, input: second.input.slice(0, -1) }, 'sealed-1', [
    'same user',
    'same user',
    'tail C',
    'tail D[image]',
  ]);
  const call = second.input.find((x) => x.type === 'function_call');
  const output = second.input.find((x) => x.type === 'function_call_output');
  expect(call && output).toBeTruthy();
  expect(call.call_id).toBe(output.call_id);
  expect(
    Array.isArray(output.output) && output.output.some((p) => p.type === 'input_image'),
  ).toBeTruthy();
  const checkpoint2 = resolveCheckpoint(context.sessionManager.getBranch());
  expect(checkpoint2.kind).toBe('valid');
  expect(
    checkpoint2.details.coverage.some((c) => c.id === checkpoint1.details.coverage[0].id),
    'transitive sealed coverage',
  ).toBeTruthy();
  session.dispose();
  session = await open(SessionManager.open(file));
  responses.push({ tokens: 700 });
  await session.prompt('after reopen');
  assertWindow(normalRequests().at(-1).body, 'sealed-2', [
    'same user',
    'same user',
    'tail C',
    'tail D[image]',
    'after reopen',
  ]);
  expect(compactions, 'no immediate reopen compaction loop').toBe(2);

  for (const mismatch of [
    { account: digest('another account') },
    { model: 'another model' },
    { endpoint: 'https://different.invalid' },
  ]) {
    identityOverrides = mismatch;
    const beforeMismatch = requests.length;
    await expect(session.compact()).rejects.toThrow();
    expect(requests.length, 'incompatible recursive producer rejected before request').toBe(
      beforeMismatch,
    );
  }
  identityOverrides = {};
  expect(() => replaceAnchor([], checkpoint2)).toThrow();
  const marker = {
    role: 'user',
    content: [{ type: 'input_text', text: anchorText(checkpoint2.details.anchor) }],
  };
  expect(() => replaceAnchor([marker, marker], checkpoint2)).toThrow();
  const projected = session.sessionManager.buildSessionProjection();
  const transient = {
    role: 'user',
    content: 'same user',
    timestamp: Date.now() + 1,
  };
  expect(
    () => filterContext([], projected, checkpoint2),
    'redacted/missing canonical history cannot silently lose provenance',
  ).toThrow();
  const filtered = filterContext([...projected.messages, transient], projected, checkpoint2);
  expect(filtered.at(-1), 'identical transient input not removed as covered history').toBe(
    transient,
  );

  // Genuine edits to live tail remain legal, even when text duplicates a sealed user.
  const reopened = session.sessionManager;
  const liveUser = reopened
    .getBranch()
    .filter((e) => e.type === 'message' && e.message.role === 'user')
    .at(-1);
  reopened.appendContextEdit(liveUser.id, { content: 'edited live tail' });
  responses.push({ tokens: 750 });
  await session.prompt('next');
  expect(users(normalRequests().at(-1).body).slice(-2)).toStrictEqual(['edited live tail', 'next']);
  reopened.appendContextEdit(
    checkpoint1.details.coverage.find(
      (c) =>
        reopened.getEntry(c.id)?.type === 'message' &&
        reopened.getEntry(c.id).message.role === 'user',
    ).id,
    { content: 'sealed edit' },
  );
  expect(resolveCheckpoint(reopened.getBranch()).kind).toBe('invalid');
  const beforeInvalid = requests.length;
  await expect(session.compact()).rejects.toThrow();
  expect(requests.length).toBe(beforeInvalid);
  expect(outcomes.at(-1).aborted).toBe(true);
  expect(outcomes.at(-1).result).toBe(undefined);
  // Navigation before the edit restores checkpoint validity; forks inherit evidence, not session ID.
  reopened.branch(checkpoint2.entry.id);
  expect(resolveCheckpoint(reopened.getBranch()).kind).toBe('valid');
  const validBranch = structuredClone(reopened.getBranch());
  for (const mutate of [
    (b) => {
      b.at(-1).details.version = 2;
    },
    (b) => {
      b.at(-1).summary = 'wrong anchor';
    },
    (b) => {
      b.at(-1).details.coverage[0].hash = 'changed';
    },
    (b) => {
      b.at(-1).details.window[0].sourceIds = [];
    },
  ]) {
    const invalidBranch = structuredClone(validBranch);
    mutate(invalidBranch);
    expect(resolveCheckpoint(invalidBranch).kind).toBe('invalid');
  }
  const forkFile = reopened.createBranchedSession(checkpoint2.entry.id);
  expect(forkFile).toBeTruthy();
  const fork = SessionManager.open(forkFile);
  expect(resolveCheckpoint(fork.getBranch()).kind).toBe('valid');
  fork.appendCompaction(`ordinary native summary quotes ${WARNING}`, null, 100);
  expect(resolveCheckpoint(fork.getBranch()).kind, 'newer native summary supersedes remote').toBe(
    'absent',
  );
  fork.branch(checkpoint2.entry.id);
  fork.appendCompaction('NATIVE_COMPACTION_MARKER', null, 100, {
    type: 'openai-native-compaction',
    version: '1',
  });
  expect(resolveCheckpoint(fork.getBranch()).kind).toBe('invalid');

  // Custom guidance rejects before a synthetic request, never falls through to native summary.
  session.dispose();
  session = await open(SessionManager.open(file));
  expect((await session.navigateTree(checkpoint2.entry.id, { summarize: false })).cancelled).toBe(
    false,
  );
  responses.push({ tokens: 800 });
  await session.prompt('new live turn');
  const beforeCustom = requests.length;
  await expect(session.compact('summarize specially')).rejects.toThrow();
  expect(requests.length).toBe(beforeCustom);
  // Owned preparation/auth errors do not invoke native fallback.
  customFailure = true;
  await expect(session.compact()).rejects.toThrow();
  expect(requests.length).toBe(beforeCustom);
  customFailure = false;
  deadlineMs = 'not-a-number';
  await expect(session.compact()).rejects.toThrow();
  expect(requests.length).toBe(beforeCustom);
  deadlineMs = '300000';

  // Real append failure: no durability claim based on the advanced in-memory branch.
  const failureManager = session.sessionManager;
  const failureFile = failureManager.getSessionFile();
  const backup = failureFile + '.backup';
  renameSync(failureFile, backup);
  mkdirSync(failureFile);
  await expect(session.compact()).rejects.toThrow();
  expect(outcomes.at(-1).aborted).toBe(false);
  expect(outcomes.at(-1).result).toBe(undefined);
  expect(failureManager.getLeafEntry().type).toBe('compaction');
  expect(SessionManager.open(backup).getLeafId()).not.toBe(failureManager.getLeafId());
  session.dispose();
  session = undefined;
});

test('automatic threshold and overflow recovery use reported usage', async () => {
  session = await open(SessionManager.create(root, join(root, 'automatic')));
  responses.push({ tokens: 300 });
  await session.prompt('auto A');
  responses.push({ tokens: 400 });
  await session.prompt('auto B');
  await session.compact();
  const beforeAuto = compactions;
  responses.push({ tokens: 9000, tool: true }, { tokens: 500 });
  await session.prompt('auto live tail');
  expect(compactions, 'one usage-driven threshold compaction').toBe(beforeAuto + 1);
  expect(outcomes.at(-1).reason).toBe('threshold');
  expect(outcomes.at(-1).aborted).toBe(false);
  expect(session.getContextUsage().tokens).toBe(500);
  assertWindow(normalRequests().at(-1).body, 'sealed-' + compactions, [
    'auto A',
    'auto B',
    'auto live tail',
  ]);
  const autoFile = session.sessionManager.getSessionFile();
  session.dispose();
  session = await open(SessionManager.open(autoFile));
  responses.push({ tokens: 600 });
  await session.prompt('auto reopen');
  expect(compactions).toBe(beforeAuto + 1);
  responses.push({ tokens: 600, overflow: true }, { tokens: 500 });
  const beforeOverflow = compactions;
  await session.prompt('overflow repaired live');
  expect(compactions, 'normal overflow recovery remains one compact-and-retry').toBe(
    beforeOverflow + 1,
  );
  expect(outcomes.at(-1).reason).toBe('overflow');
  expect(outcomes.at(-1).willRetry).toBe(true);
  expect(session.getContextUsage().tokens).toBe(500);
  assertWindow(normalRequests().at(-1).body, 'sealed-' + compactions, [
    'auto A',
    'auto B',
    'auto live tail',
    'auto reopen',
    'overflow repaired live',
  ]);
  const beforeTree = requests.length;
  const tree = await session.navigateTree(session.sessionManager.getBranch()[0].id, {
    summarize: true,
  });
  expect(tree.cancelled).toBe(true);
  expect(requests.length).toBe(beforeTree);
  session.dispose();
});

test('wire failures, cancellation and oversized input never install a checkpoint or fall back', async () => {
  session = await open(SessionManager.create(root, join(root, 'wire-failures')));
  responses.push({ tokens: 300 });
  await session.prompt('wire A');
  responses.push({ tokens: 400 });
  await session.prompt('wire B');
  for (const mode of ['http-error', 'eof', 'error', 'empty', 'multiple', 'incomplete']) {
    wireMode = mode;
    const count = requests.length;
    await expect(session.compact()).rejects.toThrow();
    expect(requests.length, 'one application attempt and no native fallback').toBe(count + 1);
    expect(resolveCheckpoint(session.sessionManager.getBranch()).kind).toBe('absent');
    expect(outcomes.at(-1).result).toBe(undefined);
    expect(outcomes.at(-1).aborted).toBe(true);
  }
  wireMode = 'stall';
  deadlineMs = '1000';
  const beforeDeadline = requests.length,
    deadlineStart = Date.now();
  await expect(session.compact()).rejects.toThrow();
  expect(Date.now() - deadlineStart < 3000).toBeTruthy();
  expect(requests.length).toBe(beforeDeadline + 1);
  expect(resolveCheckpoint(session.sessionManager.getBranch()).kind).toBe('absent');
  deadlineMs = '300000';
  let observed;
  const received = new Promise((resolve) => {
    observed = resolve;
  });
  onSyntheticReceived = observed;
  const cancellation = session.compact();
  await received;
  session.abortCompaction();
  await expect(cancellation).rejects.toThrow();
  expect(resolveCheckpoint(session.sessionManager.getBranch()).kind).toBe('absent');
  onSyntheticReceived = undefined;
  wireMode = 'good';
  // Unknown usage + newly appended oversized input: fitting fails without truncation or fallback.
  session.sessionManager.appendMessage({
    role: 'user',
    content: 'x'.repeat(50000),
    timestamp: Date.now(),
  });
  const beforeOversize = requests.length;
  await expect(session.compact()).rejects.toThrow();
  expect(requests.length).toBe(beforeOversize);
  expect(session.sessionManager.getBranch().at(-1).message.content.length).toBe(50000);
  session.dispose();
  session = undefined;
});

test('image blocking survives compaction, continuation and reopen', async () => {
  settings.setBlockImages(true);
  session = await open(SessionManager.create(root, join(root, 'blocked-images')));
  responses.push({ tokens: 300, tool: true }, { tokens: 400 });
  await session.prompt('blocked A', {
    images: [
      { type: 'image', mimeType: 'image/png', data: IMAGE_DATA },
      { type: 'image', mimeType: 'image/png', data: IMAGE_DATA },
    ],
  });
  expect(imageCount(normalRequests().at(-1).body)).toBe(0);
  await session.compact();
  const blockedRequest = syntheticRequests().at(-1).body;
  expect(imageCount(blockedRequest), 'blocked user and tool images stay off synthetic wire').toBe(
    0,
  );
  expect(users(blockedRequest)).toStrictEqual(['blocked AImage reading is disabled.']);
  const blockedOutput = blockedRequest.input.find((item) => item.type === 'function_call_output');
  expect(blockedOutput.output).toBe('actual tool output\nImage reading is disabled.');
  const blockedCheckpoint = resolveCheckpoint(session.sessionManager.getBranch());
  expect(blockedCheckpoint.kind).toBe('valid');
  expect(imageCount(blockedCheckpoint.details.window)).toBe(0);
  expect(
    blockedCheckpoint.details.window.filter((entry) => entry.sourceKind === 'user').length,
  ).toBe(1);
  expect(blockedCheckpoint.details.window[0].sourceIds.length).toBe(1);
  const blockedFile = session.sessionManager.getSessionFile();
  responses.push({ tokens: 500 });
  await session.prompt('blocked continuation');
  expect(imageCount(normalRequests().at(-1).body)).toBe(0);
  session.dispose();
  // Turning blocking off/reopening must not restore the covered original images.
  settings.setBlockImages(false);
  session = await open(SessionManager.open(blockedFile));
  responses.push({ tokens: 600 });
  await session.prompt('unblocked reopen');
  expect(imageCount(normalRequests().at(-1).body)).toBe(0);
  await session.compact();
  expect(imageCount(syntheticRequests().at(-1).body)).toBe(0);
  expect(imageCount(resolveCheckpoint(session.sessionManager.getBranch()).details.window)).toBe(0);
  session.dispose();
});

test('image policy changes filter plaintext copies without mutating sealed history', async () => {
  session = await open(SessionManager.create(root, join(root, 'image-policy-change')));
  responses.push({ tokens: 300 });
  await session.prompt('allowed image', {
    images: [{ type: 'image', mimeType: 'image/png', data: IMAGE_DATA }],
  });
  responses.push({ tokens: 400 });
  await session.prompt('allowed B');
  await session.compact();
  expect(imageCount(syntheticRequests().at(-1).body)).toBe(1);
  const allowedCheckpoint = resolveCheckpoint(session.sessionManager.getBranch());
  expect(imageCount(allowedCheckpoint.details.window)).toBe(1);
  const allowedWindow = structuredClone(allowedCheckpoint.details.window);
  settings.setBlockImages(true);
  responses.push({ tokens: 500 });
  await session.prompt('block now');
  expect(imageCount(normalRequests().at(-1).body)).toBe(0);
  expect(
    normalRequests()
      .at(-1)
      .body.input.find((item) => item.type === 'compaction').encrypted_content,
  ).toBe(allowedWindow.at(-1).item.encrypted_content);
  expect(
    resolveCheckpoint(session.sessionManager.getBranch()).details.window,
    'request-local filtering does not mutate saved windows or opaque contents',
  ).toStrictEqual(allowedWindow);
  const allowedFile = session.sessionManager.getSessionFile();
  session.dispose();
  session = await open(SessionManager.open(allowedFile));
  responses.push({ tokens: 600 });
  await session.prompt('blocked reopen');
  expect(imageCount(normalRequests().at(-1).body)).toBe(0);
  await session.compact();
  const reblocked = syntheticRequests().at(-1).body;
  expect(imageCount(reblocked)).toBe(0);
  expect(reblocked.input.filter((item) => item.type === 'compaction').length).toBe(1);
  expect(
    reblocked.input.find((item) => item.type === 'compaction').encrypted_content,
    'opaque knowledge is still carried, not selectively erased',
  ).toBe(allowedWindow.at(-1).item.encrypted_content);
  expect(users(reblocked)).toStrictEqual([
    'allowed imageImage reading is disabled.',
    'allowed B',
    'block now',
    'blocked reopen',
  ]);
  const reblockedCheckpoint = resolveCheckpoint(session.sessionManager.getBranch());
  expect(imageCount(reblockedCheckpoint.details.window)).toBe(0);
  session.dispose();
  settings.setBlockImages(false);
  session = await open(SessionManager.open(allowedFile));
  responses.push({ tokens: 700 });
  await session.prompt('reopen new filtered window');
  expect(
    imageCount(normalRequests().at(-1).body),
    'recursive filtered window never rehydrates raw images',
  ).toBe(0);
  session.dispose();
  session = undefined;
});

test('normal and recursive serialization preserve grammar tools and transient users', async () => {
  forcePrompt = false; // Forced prompts intentionally collapse system history in Pi itself.
  let grammarControl;
  for (const withCheckpoint of [false, true]) {
    const grammarManager = SessionManager.create(
      root,
      join(root, `live-grammar-${withCheckpoint}`),
    );
    session = await open(grammarManager);
    responses.push({ tokens: 300 });
    await session.prompt('initial A');
    responses.push({ tokens: 400 });
    await session.prompt('initial B');
    const initialInstructions = normalRequests().at(-1).body.instructions;
    if (withCheckpoint) await session.compact();
    appendHistoricalGrammar(grammarManager);
    if (withCheckpoint) transientText = 'initial A'; // Same content, distinct request-local occurrence.
    responses.push({ tokens: 500 });
    await session.prompt('after grammar removal');
    const normal = normalRequests().at(-1).body;
    const grammarItems = normal.input.filter(
      (item) => item.name === 'historical_grammar' || item.call_id === 'grammar-call',
    );
    expect(grammarItems[0].type).toBe('custom_tool_call');
    expect(grammarItems[0].id).toBe('ctc_history');
    expect(grammarItems[0].input).toBe('historical input');
    expect(grammarItems[1].type).toBe('custom_tool_call_output');
    expect(grammarItems[0].call_id).toBe(grammarItems[1].call_id);
    expect(normal.tools.map((tool) => tool.name)).toStrictEqual(['orchestrator']);
    expect(normal.tools[0].description).toBe('prepared orchestrator');
    expect(normal.instructions).toBe(initialInstructions);
    expect(normal.service_tier).toBe('priority');
    expect(phaseSnapshots.at(-1)[0].role).toBe('system');
    if (!withCheckpoint) grammarControl = grammarItems;
    else {
      expect(
        grammarItems,
        'checkpoint pruning preserves native grammar history serialization',
      ).toStrictEqual(grammarControl);
      expect(
        phaseSnapshots
          .at(-1)
          .filter(
            (message) =>
              message.role === 'system' &&
              (message.toolsAdded?.some((tool) => tool.name === 'historical_grammar') ||
                message.toolsRemoved?.some((tool) => tool.name === 'historical_grammar')),
          ).length,
      ).toBe(2);
      expect(
        users(normal).filter((text) => text === 'initial A').length,
        'transient duplicate survives sealed-history pruning',
      ).toBe(2);
      expect(normal.input.filter((item) => item.type === 'compaction').length).toBe(1);
      transientText = undefined;
      await session.compact();
      const recursive = syntheticRequests().at(-1).body;
      expect(
        recursive.input.filter(
          (item) => item.name === 'historical_grammar' || item.call_id === 'grammar-call',
        ),
      ).toStrictEqual(grammarControl);
      expect(
        users(recursive),
        'recursive sources retained once, not transient input',
      ).toStrictEqual(['initial A', 'initial B', 'after grammar removal']);
      expect(recursive.input.filter((item) => item.type === 'compaction').length).toBe(1);
      const recursiveCheckpoint = resolveCheckpoint(grammarManager.getBranch());
      expect(recursiveCheckpoint.kind).toBe('valid');
      expect(
        recursiveCheckpoint.details.window.filter((entry) => entry.sourceKind === 'user').length,
      ).toBe(3);
      responses.push({ tokens: 600 });
      await session.prompt('after recursive grammar');
      expect(
        !normalRequests()
          .at(-1)
          .body.input.some((item) => item.call_id === 'grammar-call'),
        'sealed calls are not restored from raw history',
      ).toBeTruthy();
      expect(normalRequests().at(-1).body.instructions).toBe(initialInstructions);
      expect(normalRequests().at(-1).body.tools[0].description).toBe('prepared orchestrator');
    }
    session.dispose();
    session = undefined;
  }
  forcePrompt = true;
});

test('raw completion validation and usage accounting', async () => {
  const cmp = {
    type: 'response.output_item.done',
    item: { type: 'compaction', encrypted_content: 'encrypted' },
  };
  const done = {
    type: 'response.completed',
    response: { id: 'done', status: 'completed' },
  };
  for (const events of [
    [],
    [cmp],
    [done],
    [cmp, cmp, done],
    [{ ...cmp, item: { type: 'compaction', encrypted_content: '' } }, done],
    [cmp, { type: 'response.incomplete', response: { status: 'incomplete' } }],
    [cmp, { type: 'response.failed' }, done],
    [cmp, { ...done, response: { id: 'bad', status: 'incomplete' } }],
  ]) {
    const collector = new RawCollector();
    events.forEach((e) => collector.observe(e));
    expect(() => collector.finish()).toThrow();
  }
  const a = new RawCollector(),
    b = new RawCollector();
  a.observe(cmp);
  b.observe(done);
  expect(() => a.finish()).toThrow();
  expect(() => b.finish()).toThrow();
  const good = new RawCollector();
  good.observe({
    type: 'response.output_item.done',
    item: { type: 'function_call', name: 'never executed' },
  });
  good.observe(cmp);
  good.observe(done);
  expect(good.finish().checkpoint.encrypted_content).toBe('encrypted');
  const minimalTerminal = new RawCollector();
  minimalTerminal.observe(cmp);
  minimalTerminal.observe({
    type: 'response.completed',
    response: { id: 'minimal' },
  });
  expect(minimalTerminal.finish().responseId).toBe('minimal');
  expect(
    mapUsage({
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_tokens_details: { cached_tokens: 30 },
      output_tokens_details: { reasoning_tokens: 5 },
    }),
  ).toStrictEqual({
    input: 70,
    output: 20,
    totalTokens: 120,
    cacheRead: 30,
    cacheWrite: 0,
    reasoning: 5,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test('user retention and request fitting preserve boundaries and opaque content', async () => {
  const user = (id, content) => ({
    item: { role: 'user', content },
    sourceKind: 'user',
    sourceIds: [id],
  });
  const text = (text) => ({ type: 'input_text', text });
  const image = {
    type: 'input_image',
    detail: 'auto',
    image_url: 'data:image/png;base64,eA==',
  };
  const retained = retainUsers(
    [
      user('old', [text('discard old')]),
      user('middle', [text('middle1234')]),
      user('new', [text('new')]),
    ],
    3,
  );
  expect(retained.map((x) => x.sourceIds[0])).toStrictEqual(['middle', 'new']);
  expect(retained[0].item.content[0].text).toBe('midd…1 tokens truncated…1234');
  expect(middleTruncate('a😀b😀c', 1)).toBe('a…2 tokens truncated…c');
  expect(
    retainUsers(
      [
        user('old', [text('old')]),
        user('image', [text('<image>'), image, text('</image>')]),
        user('new', [text('new')]),
      ],
      100,
    ).map((x) => x.sourceIds[0]),
  ).toStrictEqual(['new']);
  const mixed = retainUsers([user('mixed', [text('earlier'), image, text('late')])], 2);
  expect(mixed[0].item.content).toStrictEqual([text('late')]);
  expect(retainUsers([user('image', [image])], 1844).length).toBe(1);
  const history = (item) => ({
    item,
    sourceKind: 'history',
    sourceIds: [],
  });
  const fitted = fitRequest(
    { instructions: 'current', tools: [] },
    [
      history({ type: 'function_call', call_id: 'pair', arguments: '{}' }),
      history({
        type: 'function_call_output',
        call_id: 'pair',
        output: 'x'.repeat(1000),
      }),
    ],
    100,
  );
  expect(fitted[0].item.call_id).toBe(fitted[1].item.call_id);
  expect(fitted[1].item.output.includes('truncated')).toBeTruthy();
  expect(() =>
    fitRequest(
      {},
      [
        history({ type: 'function_call_output', output: 'x'.repeat(1000) }),
        user('boundary', [text('x'.repeat(1000))]),
      ],
      100,
    ),
  ).toThrow();
  expect(() =>
    fitRequest(
      {},
      [
        history({
          type: 'function_call_output',
          output: [
            { type: 'encrypted_content', encrypted_content: 'opaque' },
            text('x'.repeat(1000)),
          ],
        }),
      ],
      100,
    ),
  ).toThrow();
  expect(() => fitRequest({}, [user('big', [text('x'.repeat(1000))])], 100)).toThrow();
  expect(() =>
    fitRequest(
      {},
      [history({ type: 'compaction', encrypted_content: 'x'.repeat(1000) })],
      100,
      100,
    ),
  ).toThrow();

  const opaqueMetadata = history({
    type: 'compaction',
    encrypted_content: 'opaque',
    extra_metadata: 'x'.repeat(50000),
  });
  expect(
    fitRequest({}, [opaqueMetadata], 100),
    'opaque checkpoint metadata is not a plaintext token estimate',
  ).toStrictEqual([opaqueMetadata]);
});

test('request fitting counts serialized tool schemas including optional property names', () => {
  const tools = [
    {
      type: 'function',
      name: 'declaration_heavy',
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 1000 }, (_, i) => [
            `optional_parameter_${i}_${'x'.repeat(30)}`,
            { type: 'string' },
          ]),
        ),
      },
    },
  ];
  const bytes = Buffer.byteLength(JSON.stringify(tools));
  expect(bytes).toBeGreaterThan(4096 * 4);
  expect(bytes).toBeLessThan(20 * 1024 * 1024);
  expect(() => fitRequest({ tools }, [], 4096)).toThrow('estimated model budget');
  expect(fitRequest({ tools }, [], Math.ceil(bytes / 4) + 100)).toStrictEqual([]);
});

test('deadlines, cancelled promises and unsupported connections fail safely', async () => {
  let attempts = 0;
  const abortController = new AbortController();
  const timeout = deadline(abortController.signal, 1000);
  const fakeConnection = {
    model: { ...model, baseUrl },
    apiKey: fakeKey,
    headers: {},
    identity,
    provider: {
      streamSimple(_model, _ctx, options) {
        attempts++;
        expect(options.transport).toBe('sse');
        expect(options.maxRetries).toBe(0);
        return {
          // Intentionally emits nothing: the deadline must interrupt a stalled stream.
          // oxlint-disable-next-line require-yield
          async *[Symbol.asyncIterator]() {
            await once(options.signal, 'abort');
            throw Error('aborted');
          },
        };
      },
    },
  };
  const started = Date.now();
  await expect(
    timeout.race(requestV2(fakeConnection, { messages: [] }, { signal: timeout.signal }, () => [])),
  ).rejects.toThrow();
  expect(Date.now() - started < 3000).toBeTruthy();
  expect(attempts).toBe(1);
  expect(timeout.signal.aborted).toBeTruthy();
  timeout.dispose();
  const preAborted = new AbortController();
  preAborted.abort();
  const cancelled = deadline(preAborted.signal, 1000);
  await expect(cancelled.race(Promise.resolve())).rejects.toThrow();
  await expect(cancelled.race(Promise.reject(Error('late operation rejection')))).rejects.toThrow();
  // Let Node run its unhandled-rejection check; this used to crash after cancellation.
  await new Promise((resolve) => setImmediate(resolve));
  cancelled.dispose();
  await expect(
    resolveConnection({
      model: { ...model, provider: 'openai' },
      modelRegistry: { isUsingOAuth: () => true },
    }),
  ).rejects.toThrow();
  await expect(
    resolveConnection({ model, modelRegistry: { isUsingOAuth: () => false } }),
  ).rejects.toThrow();
  await expect(
    resolveConnection({
      model,
      modelRegistry: {
        isUsingOAuth: () => true,
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: fakeKey,
          baseUrl: 'https://gateway.invalid',
        }),
      },
    }),
  ).rejects.toThrow();
});

test('preparation and reporting failures never invoke native fallback', async () => {
  const handlers = new Map();
  let resolverCalls = 0;
  install(
    {
      registerFlag() {},
      getFlag() {
        return '1000';
      },
      getThinkingLevel() {
        return 'low';
      },
      on(name, handler) {
        handlers.set(name, handler);
      },
    },
    async () => {
      resolverCalls++;
      throw Error('SECRET SHOULD NOT BE LOGGED');
    },
  );
  const reportingManager = SessionManager.inMemory(root);
  reportingManager.appendMessage({
    role: 'user',
    content: 'reporting input',
    timestamp: 0,
  });
  const reportResult = await handlers.get('session_before_compact')(
    { signal: new AbortController().signal },
    {
      model,
      sessionManager: reportingManager,
      hasUI: true,
      ui: {
        notify() {
          throw Error('broken UI');
        },
      },
      getSystemPrompt() {
        throw Error('SECRET SHOULD NOT BE LOGGED');
      },
    },
  );
  expect(reportResult).toStrictEqual({ cancel: true });
  expect(resolverCalls).toBe(0);
  const futureCheckpoint = {
    type: 'compaction',
    id: 'future',
    parentId: null,
    summary: 'unknown future anchor',
    details: { type: 'pi-openai-compaction-v3', version: 1 },
  };
  expect(resolveCheckpoint([futureCheckpoint]).kind).toBe('invalid');
  expect(
    await handlers.get('session_before_tree')(
      {
        preparation: {
          userWantsSummary: true,
          entriesToSummarize: [futureCheckpoint],
        },
      },
      { sessionManager: reportingManager, hasUI: false },
    ),
    'tree summaries reject unsupported owned checkpoints in abandoned paths',
  ).toStrictEqual({ cancel: true });
});

test('Pi loads the source package in print and TUI modes without inference', async () => {
  const packageLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [resolve('.')],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    disabledBuiltinExtensions: ['mcp', 'codemode', 'tool-search'],
  });
  await packageLoader.reload();
  expect(packageLoader.getExtensions().errors).toStrictEqual([]);
  expect(packageLoader.getExtensions().extensions.length).toBe(1);
  const beforePackageLoad = requests.length;
  for (const mode of ['print', 'tui']) {
    const packaged = await createAgentSession({
      cwd: root,
      agentDir: root,
      modelRuntime: runtime,
      model,
      settingsManager: SettingsManager.inMemory({}),
      sessionManager: SessionManager.inMemory(root),
      resourceLoader: packageLoader,
      tools: [],
    });
    expect(packaged.extensionsResult.errors).toStrictEqual([]);
    await packaged.session.bindExtensions({
      mode,
      onError: (error) => {
        throw Error(JSON.stringify(error));
      },
    });
    packaged.session.dispose();
  }
  expect(requests.length, 'factory/session binding does not perform inference').toBe(
    beforePackageLoad,
  );
});
