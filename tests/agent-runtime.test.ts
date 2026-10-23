import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInput } from '../packages/contracts.js';
import type { ReflectionEvidence } from '../apps/server/skills.js';
import {
  AgentProtocolError,
  AgentSecurityError,
  AgentTimeoutError,
  AgentTurnError,
  CodexAgentAdapter,
  DemoAgentAdapter,
} from '../apps/server/agent/index.js';
import type { SpawnProcess } from '../apps/server/agent/app-server-client.js';

const input: AgentInput = {
  page: {
    postId: 42,
    url: 'https://example.test/article',
    title: 'Safe title',
    bodyHtml: '<p>Original paragraph.</p>',
    status: 'publish',
    modified: '2026-10-23T00:00:00Z',
    protectedHash: 'sha256:before',
  },
  opportunity: {
    id: 'opp-1',
    postId: 42,
    title: 'Safe title',
    url: 'https://example.test/article',
    kind: 'decay',
    clicks: 10,
    previousClicks: 20,
    impressions: 200,
    position: 8,
    queries: ['safe query'],
    evidenceIds: ['evidence-1'],
    quality: 'available',
    engagementRate: 0.5,
    reason: 'Clicks declined in a complete comparison window.',
    audienceHypothesis: 'Readers need a clearer next step.',
    keywordHypotheses: ['safe query'],
  },
  evidence: [{
    id: 'evidence-1',
    source: 'gsc',
    property: 'https://example.test/',
    startDate: '2026-10-01',
    endDate: '2026-10-07',
    timeZone: 'Asia/Taipei',
    fetchedAt: '2026-10-23T00:00:00Z',
    complete: true,
    coverage: '7 complete days',
  }],
  relatedPages: [],
  skillContent: 'Improve clarity while preserving supported facts.',
  skillVersion: 'skill-v1',
};

const reflectionEvidence: ReflectionEvidence = {
  active: {
    id: 'skill-v1',
    content: 'Preserve supported facts and keep editorial changes bounded.',
  },
  tasks: [{ status: 'completed' }, { status: 'review_required' }],
  proposals: [{ status: 'applied' }, { status: 'rejected' }],
};

interface RpcMessage { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }

interface FakeOptions {
  behavior?: 'success' | 'cancel' | 'unknown-request' | 'tool-event' | 'unknown-item' | 'unsafe-output' | 'turn-failed' | 'client-too-old' | 'reflection-extra' | 'reflection-short';
  mcpName?: string;
  inventoryRaw?: string;
  inventoryStderr?: string;
  inventoryExitCode?: number;
  configMcpNames?: string[];
  configEnabledNames?: string[];
  omitConfigLayers?: boolean;
  emitMcpNotification?: boolean;
}

class FakeInventoryProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  private exited = false;
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number): boolean => {
    if (!this.exited) {
      this.exited = true;
      queueMicrotask(() => this.emit('exit', 0, null));
    }
    return true;
  });

  constructor(options: FakeOptions) {
    super();
    queueMicrotask(() => {
      if (this.exited) return;
      const raw = options.inventoryRaw ?? JSON.stringify([{ name: options.mcpName ?? 'test-mcp' }]);
      this.stdout.write(raw);
      if (options.inventoryStderr) this.stderr.write(options.inventoryStderr);
      this.exited = true;
      this.emit('exit', options.inventoryExitCode ?? 0, null);
    });
  }
}

class FakeAppServer extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: RpcMessage[] = [];
  readonly stdin: Writable;
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number): boolean => {
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  });
  private buffer = '';

  constructor(
    private readonly options: FakeOptions,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        this.buffer += chunk.toString();
        let newline = this.buffer.indexOf('\n');
        while (newline >= 0) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          if (line.length > 0) this.receive(JSON.parse(line) as RpcMessage);
          newline = this.buffer.indexOf('\n');
        }
        callback();
      },
    });
  }

  private send(message: RpcMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  private receive(message: RpcMessage): void {
    this.messages.push(message);
    if (!message.method || message.id === undefined) return;
    switch (message.method) {
      case 'initialize':
        this.send({ id: message.id, result: { userAgent: 'fake', platformFamily: 'unix', platformOs: 'macos' } });
        if (this.options.emitMcpNotification) {
          queueMicrotask(() => this.send({ method: 'mcpServer/startupStatus/updated', params: {} }));
        }
        break;
      case 'config/read':
        this.send({
          id: message.id,
          result: {
            config: this.config(),
            ...(this.options.omitConfigLayers ? {} : { layers: [] }),
          },
        });
        break;
      case 'account/read':
        this.send({ id: message.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
        break;
      case 'thread/start':
        this.send({
          id: message.id,
          result: {
            thread: { id: 'thread-1' },
            approvalPolicy: 'never',
            sandbox: { type: 'readOnly', networkAccess: false },
          },
        });
        break;
      case 'turn/start':
        this.send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
        queueMicrotask(() => this.afterTurnStart());
        break;
      case 'turn/interrupt':
        this.send({ id: message.id, result: {} });
        this.send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } },
        });
        break;
      default:
        this.send({ id: message.id, error: { code: -32601, message: 'unsupported' } });
    }
  }

  private config(): Record<string, unknown> {
    const featureNames = [
      'apps', 'auth_elicitation', 'browser_use', 'code_mode_host', 'computer_use',
      'goals', 'hooks', 'image_generation', 'in_app_browser', 'in_app_local_automation',
      'memories', 'multi_agent', 'plugins', 'recommended_plugins', 'shell_tool',
      'skill_search', 'tool_call_mcp_elicitation', 'tool_suggest', 'view_image',
      'workspace_dependencies',
      'skill_mcp_dependency_install',
    ];
    const inventoryNames = this.options.configMcpNames ?? [this.options.mcpName ?? 'test-mcp'];
    const enabled = new Set(this.options.configEnabledNames ?? []);
    return {
      features: Object.fromEntries(featureNames.map((name) => [name, false])),
      web_search: 'disabled',
      tools: { web_search: null },
      apps: { _default: { enabled: false } },
      feedback: { enabled: false },
      hooks: {},
      plugins: {},
      shell_environment_policy: { inherit: 'none', ignore_default_excludes: false },
      mcp_servers: Object.fromEntries(inventoryNames.map((name) => [name, { enabled: enabled.has(name) }])),
    };
  }

  private afterTurnStart(): void {
    this.send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
    if (this.options.behavior === 'cancel') return;
    if (this.options.behavior === 'unknown-request') {
      this.send({ id: 900, method: 'item/tool/call', params: { tool: 'forbidden' } });
      return;
    }
    if (this.options.behavior === 'tool-event') {
      this.send({
        method: 'item/started',
        params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'item-1' } },
      });
      return;
    }
    if (this.options.behavior === 'unknown-item') {
      this.send({
        method: 'item/started',
        params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'futureDataOrToolItem', id: 'item-unknown' } },
      });
      return;
    }
    if (this.options.behavior === 'turn-failed') {
      this.send({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-1',
            status: 'failed',
            error: {
              message: 'Invalid response_format at https://private.example/path?token=fake-private-input',
              codexErrorInfo: 'badRequest',
              additionalDetails: 'fake-private-input',
            },
          },
        },
      });
      return;
    }
    if (this.options.behavior === 'client-too-old') {
      this.send({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-1',
            status: 'failed',
            error: {
              message: "The 'fake-model' model requires a newer version of Codex. Please upgrade to the latest CLI.",
              codexErrorInfo: 'other',
              additionalDetails: null,
            },
          },
        },
      });
      return;
    }
    const turnStart = [...this.messages].reverse().find(message => message.method === 'turn/start');
    const reflection = JSON.stringify(turnStart?.params).includes('"rationale"');
    const bodyHtml = this.options.behavior === 'unsafe-output'
      ? '<p>Safe</p><script>steal()</script>'
      : '<p>Improved paragraph.</p>';
    this.send({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'reasoning', id: 'item-reasoning', summary: ['safe summary'], content: [] },
      },
    });
    this.send({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'plan', id: 'item-plan', text: 'safe plan' },
      },
    });
    this.send({ method: 'item/agentMessage/delta', params: { delta: '{' } });
    this.send({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'item-2',
          text: JSON.stringify(reflection
            ? {
                content: this.options.behavior === 'reflection-short'
                  ? 'too short'
                  : 'Preserve supported facts and explain each editorial recommendation in reader-facing language.',
                rationale: 'Status-only evidence supports a bounded editorial clarification without claiming measured impact.',
                ...(this.options.behavior === 'reflection-extra' ? { unsafeExtra: 'CANARY' } : {}),
              }
            : {
                bodyHtml,
                summary: 'Grounded improvement.',
                evidenceIds: ['evidence-1'],
                skillVersion: 'skill-v1',
              }),
        },
      },
    });
    this.send({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    });
  }
}

function fakeRuntime(options: FakeOptions = {}): {
  spawnProcess: SpawnProcess;
  launches: Array<{
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    process: ChildProcessWithoutNullStreams;
    server?: FakeAppServer;
  }>;
} {
  const launches: Array<{
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    process: ChildProcessWithoutNullStreams;
    server?: FakeAppServer;
  }> = [];
  const spawnProcess: SpawnProcess = (_command, args, spawnOptions) => {
    if (args[0] === 'mcp') {
      const inventory = new FakeInventoryProcess(options) as unknown as ChildProcessWithoutNullStreams;
      launches.push({ args, env: spawnOptions.env ?? {}, process: inventory });
      return inventory;
    }
    const server = new FakeAppServer(options);
    const process = server as unknown as ChildProcessWithoutNullStreams;
    launches.push({ args, env: spawnOptions.env ?? {}, process, server });
    return process;
  };
  return { spawnProcess, launches };
}

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  vi.restoreAllMocks();
});

describe('DemoAgentAdapter', () => {
  it('adds substantive guidance without copying hypotheses or queries into the article', async () => {
    const adapter = new DemoAgentAdapter();
    const result = await adapter.run({
      taskId: 'task-1',
      input: {
        ...input,
        opportunity: {
          ...input.opportunity,
          queries: ['UNTRUSTED_QUERY_MARKER'],
          audienceHypothesis: 'UNTRUSTED_AUDIENCE_MARKER',
        },
      },
      signal: new AbortController().signal,
      onEvent: vi.fn(),
    });
    expect(result.evidenceIds).toEqual(['evidence-1']);
    expect(result.bodyHtml).toContain('先核對提案引用的證據是否支持文章主題');
    expect(result.bodyHtml).not.toContain('UNTRUSTED_QUERY_MARKER');
    expect(result.bodyHtml).not.toContain('UNTRUSTED_AUDIENCE_MARKER');
    expect(result.bodyHtml).not.toContain('<a ');
  });

  it('links only to a related page already present in the snapshot', async () => {
    const adapter = new DemoAgentAdapter();
    const result = await adapter.run({
      taskId: 'task-related',
      input: {
        ...input,
        relatedPages: [{
          postId: 84,
          url: 'https://example.test/related?topic=content&lang=zh',
          title: '既有的相關文章',
        }],
      },
      signal: new AbortController().signal,
      onEvent: vi.fn(),
    });
    expect(result.bodyHtml).toContain(
      '<a href="https://example.test/related?topic=content&amp;lang=zh">既有的相關文章</a>',
    );
  });
});

describe('CodexAgentAdapter', () => {
  it('runs through isolated stdio, emits lifecycle events, and returns structured output', async () => {
    process.env.OPENAI_API_KEY = 'fake-secret-canary';
    const runtime = fakeRuntime();
    const onEvent = vi.fn();
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    const result = await adapter.run({
      taskId: 'task-1', input, signal: new AbortController().signal, onEvent,
    });

    expect(result).toEqual({
      bodyHtml: '<p>Improved paragraph.</p>',
      summary: 'Grounded improvement.',
      evidenceIds: ['evidence-1'],
      skillVersion: 'skill-v1',
    });
    expect(runtime.launches).toHaveLength(2);
    expect(runtime.launches[0]?.args.slice(0, 3)).toEqual(['mcp', 'list', '--json']);
    expect(runtime.launches[0]?.args).toContain('shell_tool');
    expect(runtime.launches[1]?.args).toContain('mcp_servers.test-mcp.enabled=false');
    expect(runtime.launches[1]?.args).toContain('shell_tool');
    expect(runtime.launches[1]?.env.OPENAI_API_KEY).toBeUndefined();
    expect(onEvent).toHaveBeenCalledWith('agent.running', expect.any(String));
    expect(onEvent).toHaveBeenCalledWith('agent.completed', expect.any(String));
    const initialize = runtime.launches[1]?.server?.messages.find((message) => message.method === 'initialize');
    expect(initialize?.params).toEqual({
      clientInfo: { name: 'yolo_siteops', title: 'YOLO SiteOps', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    const configRead = runtime.launches[1]?.server?.messages.find((message) => message.method === 'config/read');
    expect(configRead?.params).toEqual({ includeLayers: true, cwd: '/tmp' });
    const threadStart = runtime.launches[1]?.server?.messages.find((message) => message.method === 'thread/start');
    expect(threadStart?.params).toMatchObject({ environments: [], dynamicTools: [] });
    const turnStart = runtime.launches[1]?.server?.messages.find((message) => message.method === 'turn/start');
    expect(turnStart?.params).toMatchObject({ environments: [] });
    const serializedTurn = JSON.stringify(turnStart?.params);
    expect(serializedTurn).toContain('outputSchema');
    expect(serializedTurn).not.toContain('maxLength');
    expect(serializedTurn).not.toContain('uniqueItems');
  });

  it('uses identical runtime controls for article generation and live reflection', async () => {
    const runtime = fakeRuntime();
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });

    await adapter.run({ taskId: 'task-shared-controls', input, signal: new AbortController().signal, onEvent: vi.fn() });
    const reflected = await adapter.reflect(reflectionEvidence, new AbortController().signal);

    expect(reflected).toEqual({
      content: 'Preserve supported facts and explain each editorial recommendation in reader-facing language.',
      rationale: 'Status-only evidence supports a bounded editorial clarification without claiming measured impact.',
    });
    expect(runtime.launches).toHaveLength(4);
    expect(runtime.launches[0]?.args).toEqual(runtime.launches[2]?.args);
    expect(runtime.launches[1]?.args).toEqual(runtime.launches[3]?.args);
    for (const launch of [runtime.launches[1], runtime.launches[3]]) {
      const threadStart = launch?.server?.messages.find(message => message.method === 'thread/start');
      const turnStart = launch?.server?.messages.find(message => message.method === 'turn/start');
      expect(threadStart?.params).toMatchObject({
        approvalPolicy: 'never', sandbox: 'read-only', environments: [], dynamicTools: [], ephemeral: true,
      });
      expect(turnStart?.params).toMatchObject({
        approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, environments: [],
      });
    }
    const reflectionTurn = runtime.launches[3]?.server?.messages.find(message => message.method === 'turn/start');
    expect((reflectionTurn?.params as { outputSchema?: unknown })?.outputSchema).toEqual({
      type: 'object',
      properties: { content: { type: 'string' }, rationale: { type: 'string' } },
      required: ['content', 'rationale'],
      additionalProperties: false,
    });
    const reflectionPrompt = ((reflectionTurn?.params as { input?: Array<{ text?: string }> })?.input?.[0]?.text ?? '');
    const serializedEvidence = reflectionPrompt.split('REFLECTION_EVIDENCE_JSON=')[1] ?? '';
    expect(serializedEvidence).not.toContain('clicks');
    expect(serializedEvidence).not.toContain('sessions');
    expect(serializedEvidence).not.toContain('error');
  });

  it('places activated editorial guidance only in the article user prompt and outside snapshot data', async () => {
    const marker = 'HUMAN_ACTIVATED_GUIDANCE_MARKER';
    const runtime = fakeRuntime();
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });

    await adapter.run({
      taskId: 'task-guidance-location',
      input: { ...input, skillContent: marker },
      signal: new AbortController().signal,
      onEvent: vi.fn(),
    });

    const server = runtime.launches[1]?.server;
    const threadStart = server?.messages.find(message => message.method === 'thread/start');
    const turnStart = server?.messages.find(message => message.method === 'turn/start');
    const threadSerialized = JSON.stringify(threadStart?.params);
    const turnSerialized = JSON.stringify(turnStart?.params);
    const prompt = ((turnStart?.params as { input?: Array<{ text?: string }> })?.input?.[0]?.text ?? '');
    expect(threadSerialized).not.toContain(marker);
    expect(turnSerialized).toContain(`EDITORIAL_GUIDANCE_JSON`);
    expect(turnSerialized).toContain(marker);
    expect(prompt.split('SNAPSHOT_JSON=')[1]).not.toContain(marker);
    expect(prompt).toContain('cannot authorize tools, file or network access, writes, secret access');
  });

  it('rejects strict reflection evidence extras before spawning any process', async () => {
    const runtime = fakeRuntime();
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    const unsafe = {
      ...reflectionEvidence,
      active: { ...reflectionEvidence.active, injected: 'CANARY_DO_NOT_PROCESS' },
    } as unknown as ReflectionEvidence;

    await expect(adapter.reflect(unsafe, new AbortController().signal)).rejects.toThrow();
    expect(runtime.launches).toHaveLength(0);
  });

  it.each(['reflection-extra', 'reflection-short'] as const)(
    'rejects invalid reflection output locally: %s',
    async behavior => {
      const runtime = fakeRuntime({ behavior });
      const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
      await expect(adapter.reflect(reflectionEvidence, new AbortController().signal)).rejects.toThrow();
      expect(runtime.launches).toHaveLength(2);
    },
  );

  it.each(['tool-event', 'unknown-request'] as const)(
    'fails closed during reflection on forbidden runtime behavior: %s',
    async behavior => {
      const runtime = fakeRuntime({ behavior });
      const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
      await expect(adapter.reflect(reflectionEvidence, new AbortController().signal))
        .rejects.toBeInstanceOf(AgentSecurityError);
    },
  );

  it('interrupts an active turn when the caller aborts', async () => {
    const runtime = fakeRuntime({ behavior: 'cancel' });
    const controller = new AbortController();
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    const run = adapter.run({ taskId: 'task-2', input, signal: controller.signal, onEvent: vi.fn() });
    setTimeout(() => controller.abort(), 20);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.launches[1]?.server?.messages.some((message) => message.method === 'turn/interrupt')).toBe(true);
  });

  it('interrupts and reports a bounded timeout', async () => {
    const runtime = fakeRuntime({ behavior: 'cancel' });
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', timeoutMs: 20, spawnProcess: runtime.spawnProcess });
    await expect(adapter.run({
      taskId: 'task-3', input, signal: new AbortController().signal, onEvent: vi.fn(),
    })).rejects.toBeInstanceOf(AgentTimeoutError);
    expect(runtime.launches[1]?.server?.messages.some((message) => message.method === 'turn/interrupt')).toBe(true);
  });

  it('fails closed and rejects an unknown server request', async () => {
    const runtime = fakeRuntime({ behavior: 'unknown-request' });
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    await expect(adapter.run({
      taskId: 'task-4', input, signal: new AbortController().signal, onEvent: vi.fn(),
    })).rejects.toBeInstanceOf(AgentSecurityError);
    const response = runtime.launches[1]?.server?.messages.find((message) => message.id === 900 && message.error !== undefined);
    expect(response).toBeDefined();
  });

  it('rejects forbidden tool events even when the server claims controls are disabled', async () => {
    const runtime = fakeRuntime({ behavior: 'tool-event' });
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    await expect(adapter.run({
      taskId: 'task-5', input, signal: new AbortController().signal, onEvent: vi.fn(),
    })).rejects.toBeInstanceOf(AgentSecurityError);
  });

  it('fails closed for an unknown future turn item type', async () => {
    const runtime = fakeRuntime({ behavior: 'unknown-item' });
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    await expect(adapter.run({
      taskId: 'task-unknown-item', input, signal: new AbortController().signal, onEvent: vi.fn(),
    })).rejects.toBeInstanceOf(AgentSecurityError);
  });

  it('rejects unsafe HTML returned inside otherwise valid structured output', async () => {
    const runtime = fakeRuntime({ behavior: 'unsafe-output' });
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    await expect(adapter.run({
      taskId: 'task-6', input, signal: new AbortController().signal, onEvent: vi.fn(),
    })).rejects.toBeInstanceOf(AgentSecurityError);
  });

  it('fails closed when an MCP name cannot be safely expressed as a config path', async () => {
    const runtime = fakeRuntime({ mcpName: 'unsafe.name' });
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    await expect(adapter.run({
      taskId: 'task-7', input, signal: new AbortController().signal, onEvent: vi.fn(),
    })).rejects.toBeInstanceOf(AgentSecurityError);
    expect(runtime.launches).toHaveLength(1);
  });

  it('rejects malformed MCP inventory JSON before app-server starts', async () => {
    const runtime = fakeRuntime({ inventoryRaw: '{not-json' });
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    await expect(adapter.run({
      taskId: 'task-inventory-json', input, signal: new AbortController().signal, onEvent: vi.fn(),
    })).rejects.toBeInstanceOf(AgentProtocolError);
    expect(runtime.launches).toHaveLength(1);
  });

  it('rejects a non-array MCP inventory before app-server starts', async () => {
    const runtime = fakeRuntime({ inventoryRaw: JSON.stringify({ name: 'test-mcp' }) });
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    await expect(adapter.run({
      taskId: 'task-inventory-shape', input, signal: new AbortController().signal, onEvent: vi.fn(),
    })).rejects.toBeInstanceOf(AgentProtocolError);
    expect(runtime.launches).toHaveLength(1);
  });

  it('kills an MCP inventory process whose stdout exceeds one MiB', async () => {
    const runtime = fakeRuntime({ inventoryRaw: 'x'.repeat(1_048_577) });
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    await expect(adapter.run({
      taskId: 'task-inventory-oversize', input, signal: new AbortController().signal, onEvent: vi.fn(),
    })).rejects.toBeInstanceOf(AgentSecurityError);
    expect(runtime.launches).toHaveLength(1);
    expect(runtime.launches[0]?.process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects duplicate MCP inventory names before app-server starts', async () => {
    const runtime = fakeRuntime({ inventoryRaw: JSON.stringify([{ name: 'same' }, { name: 'same' }]) });
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    await expect(adapter.run({
      taskId: 'task-inventory-duplicate', input, signal: new AbortController().signal, onEvent: vi.fn(),
    })).rejects.toBeInstanceOf(AgentSecurityError);
    expect(runtime.launches).toHaveLength(1);
  });

  it('rejects more than 128 MCP inventory entries before app-server starts', async () => {
    const inventory = Array.from({ length: 129 }, (_, index) => ({ name: `mcp-${index}` }));
    const runtime = fakeRuntime({ inventoryRaw: JSON.stringify(inventory) });
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    await expect(adapter.run({
      taskId: 'task-inventory-count', input, signal: new AbortController().signal, onEvent: vi.fn(),
    })).rejects.toBeInstanceOf(AgentSecurityError);
    expect(runtime.launches).toHaveLength(1);
  });

  it('does not retain MCP inventory stdout or stderr when the command fails', async () => {
    const secret = 'FAKE_SECRET_IN_MCP_DIAGNOSTICS';
    const runtime = fakeRuntime({
      inventoryRaw: secret,
      inventoryStderr: `token=${secret}`,
      inventoryExitCode: 7,
    });
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    let received: unknown;
    try {
      await adapter.run({
        taskId: 'task-inventory-secret', input, signal: new AbortController().signal, onEvent: vi.fn(),
      });
    } catch (error) {
      received = error;
    }
    expect(received).toBeInstanceOf(AgentProtocolError);
    expect(String(received)).not.toContain(secret);
    expect(String(received)).not.toContain('token=');
    expect(runtime.launches).toHaveLength(1);
  });

  it('fails when config read-back contains a different MCP name set', async () => {
    const runtime = fakeRuntime({ configMcpNames: ['other-mcp'] });
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    await expect(adapter.run({
      taskId: 'task-config-mismatch', input, signal: new AbortController().signal, onEvent: vi.fn(),
    })).rejects.toBeInstanceOf(AgentSecurityError);
  });

  it('fails when config read-back leaves an MCP server enabled', async () => {
    const runtime = fakeRuntime({ configEnabledNames: ['test-mcp'] });
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    await expect(adapter.run({
      taskId: 'task-config-enabled-mcp', input, signal: new AbortController().signal, onEvent: vi.fn(),
    })).rejects.toBeInstanceOf(AgentSecurityError);
  });

  it('fails when config read-back omits effective layers', async () => {
    const runtime = fakeRuntime({ omitConfigLayers: true });
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    await expect(adapter.run({
      taskId: 'task-config-layers', input, signal: new AbortController().signal, onEvent: vi.fn(),
    })).rejects.toBeInstanceOf(AgentSecurityError);
  });

  it('fails on any MCP notification after first app-server boot', async () => {
    const runtime = fakeRuntime({ emitMcpNotification: true });
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    await expect(adapter.run({
      taskId: 'task-mcp-notification', input, signal: new AbortController().signal, onEvent: vi.fn(),
    })).rejects.toBeInstanceOf(AgentSecurityError);
  });

  it('retains only allowlisted turn failure diagnostics', async () => {
    const runtime = fakeRuntime({ behavior: 'turn-failed' });
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    let received: unknown;
    try {
      await adapter.run({
        taskId: 'task-8', input, signal: new AbortController().signal, onEvent: vi.fn(),
      });
    } catch (error) {
      received = error;
    }
    expect(received).toBeInstanceOf(AgentTurnError);
    expect((received as AgentTurnError).diagnostic).toEqual({
      status: 'failed',
      codexErrorInfo: 'badRequest',
      messageCategory: 'structured_output',
    });
    expect(String(received)).not.toContain('private.example');
    expect(String(received)).not.toContain('fake-private-input');
  });

  it('classifies an incompatible Codex client without retaining the raw terminal message', async () => {
    const runtime = fakeRuntime({ behavior: 'client-too-old' });
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess: runtime.spawnProcess });
    let received: unknown;
    try {
      await adapter.run({
        taskId: 'task-client-version', input, signal: new AbortController().signal, onEvent: vi.fn(),
      });
    } catch (error) {
      received = error;
    }
    expect(received).toBeInstanceOf(AgentTurnError);
    expect((received as AgentTurnError).diagnostic).toEqual({
      status: 'failed',
      codexErrorInfo: 'other',
      messageCategory: 'client_version',
    });
    expect(String(received)).not.toContain('fake-model');
    expect(String(received)).not.toContain('upgrade');
  });
});
