// Local-only Pi 1.1.0 seam investigation. No plugin or remote inference is invoked.
import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { getCurrentTools } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { Type } from 'typebox';

test('synthetic request preparation is independent of normal loadout and Fast hooks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-request-state-'));
  const observations = [];
  let api;
  let context;
  let fast = true;
  let session;
  const usage = {
    input: 10,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 11,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  function mockStream(model, transcript, options) {
    const stream = new AssistantMessageEventStream();
    (async () => {
      try {
        const initial = {
          tools: getCurrentTools(transcript.messages),
          input: [],
        };
        const payload = (await options?.onPayload?.(initial, model)) ?? initial;
        observations.push(payload);
        const message = {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [{ type: 'text', text: 'local reply' }],
          usage,
          stopReason: 'stop',
          timestamp: Date.now(),
        };
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end();
      } catch (error) {
        stream.end();
        throw error;
      }
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
    return stream;
  }
  function extension(pi) {
    api = pi;
    pi.registerTool({
      name: 'hidden_probe',
      label: 'probe',
      description: 'registered probe',
      parameters: Type.Object({}),
      async execute() {
        return { content: [], details: undefined };
      },
    });
    pi.registerTool({
      name: 'orchestrator',
      label: 'orchestrator',
      description: 'registered orchestrator',
      parameters: Type.Object({}),
      prepareLoadout() {
        return {
          descriptions: { orchestrator: 'prepared description' },
          hiddenDeclarations: ['hidden_probe'],
        };
      },
      async execute() {
        return { content: [], details: undefined };
      },
    });
    pi.on('before_provider_request', (event) => ({
      ...event.payload,
      ...(fast ? { service_tier: 'priority' } : {}),
    }));
    pi.on('session_start', (_event, ctx) => {
      context = ctx;
    });
  }
  try {
    const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
    const runtime = await ModelRuntime.create({
      authPath: join(root, 'synthetic-auth.json'),
      modelsPath: null,
      modelsStorePath: join(root, 'models.json'),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerProvider('mock', {
      api: 'openai-responses',
      baseUrl: 'http://mock.invalid',
      apiKey: 'synthetic',
      streamSimple: mockStream,
      models: [
        {
          id: 'local',
          name: 'Local',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 10000,
          maxTokens: 100,
        },
      ],
    });
    const model = runtime.getModel('mock', 'local');
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: 'Local seam test.',
      extensionFactories: [extension],
      disabledBuiltinExtensions: ['mcp', 'codemode', 'tool-search'],
    });
    await loader.reload();
    const created = await createAgentSession({
      cwd: root,
      agentDir: root,
      modelRuntime: runtime,
      model,
      settingsManager: settings,
      sessionManager: SessionManager.inMemory(root),
      resourceLoader: loader,
      tools: ['hidden_probe', 'orchestrator'],
    });
    expect(created.extensionsResult.errors).toStrictEqual([]);
    session = created.session;
    await session.bindExtensions({
      mode: 'print',
      onError: (error) => {
        throw Error(JSON.stringify(error));
      },
    });
    await session.prompt('first local turn');
    expect(observations[0].service_tier).toBe('priority');
    expect(observations[0].tools.map((t) => t.name)).toStrictEqual(['orchestrator']);
    expect(observations[0].tools[0].description).toBe('prepared description');
    expect(api.getActiveTools().includes('hidden_probe')).toBeTruthy();
    expect(api.getAllTools().find((t) => t.name === 'orchestrator').description).toBe(
      'registered orchestrator',
    );
    const projection = context.sessionManager.buildSessionProjection();
    expect(
      getCurrentTools(projection.messages).some((t) => t.name === 'hidden_probe'),
    ).toBeTruthy();
    await context.modelRegistry.streamSimple(model, { messages: projection.messages }).result();
    expect(observations.length).toBe(2);
    expect(observations[1].service_tier, 'nested call bypassed active Fast hook').toBe(undefined);
    expect(observations[1].tools.some((t) => t.name === 'hidden_probe')).toBeTruthy();
    fast = false; // Changed since the last main request: a captured payload is now stale.
    await session.prompt('second local turn');
    expect(observations.length).toBe(3);
    expect(observations[2].service_tier).toBe(undefined);
    expect(observations[0].service_tier, 'cached options are stale').toBe('priority');
  } finally {
    session?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
