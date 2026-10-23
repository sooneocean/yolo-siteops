import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodexAgentAdapter, DemoAgentAdapter } from '../apps/server/agent/index.js';
import { makeDemoSnapshot } from '../apps/server/demo.js';
import { rankOpportunities } from '../apps/server/opportunities.js';
import { Store } from '../apps/server/store.js';
import { SQLiteWriterStorage } from '../apps/server/writer-store.js';
import { hashPostState } from '../apps/server/writer/hash.js';
import { WriterService } from '../apps/server/writer/service.js';
import { HttpWordPressAdapter } from '../apps/server/writer/wordpress-adapter.js';
import type { ChangeProposal } from '../packages/contracts.js';

const MAX_COMMAND_OUTPUT_BYTES = 2_000_000;
const DEFAULT_DOCKER_CONTEXT = 'desktop-linux';

type FixtureStage =
  | 'initialize' | 'verify_context' | 'verify_engine' | 'compose_up' | 'container_http_ready' | 'http_ready'
  | 'core_install' | 'permalink_setup' | 'app_password' | 'create_post' | 'wordpress_readback'
  | 'agent' | 'apply' | 'apply_readback' | 'rollback' | 'rollback_readback' | 'completed';

class SafeFixtureError extends Error {
  constructor(readonly code: string, readonly safeDetail?: string) {
    super('Disposable WordPress fixture operation failed');
    this.name = 'SafeFixtureError';
  }
}

interface SafeDockerDiagnostic { code: string; detail?: string }

export function classifyDockerDiagnostic(raw: string): SafeDockerDiagnostic {
  const text = raw.toLowerCase();
  if (/wp-config\.php[^\r\n]{0,80}(?:not found|does not exist|cannot find)/u.test(text)) {
    return { code: 'wp_config_not_found', detail: 'WP-CLI could not find wp-config.php in the mounted WordPress path.' };
  }
  if (/this does not seem to be a wordpress installation/u.test(text)) {
    return { code: 'wp_installation_not_ready', detail: 'WP-CLI did not recognize the mounted path as a WordPress installation.' };
  }
  if (/error establishing a database connection|could not connect to the database/u.test(text)) {
    return { code: 'wp_database_unavailable', detail: 'WP-CLI could not connect to the disposable database.' };
  }
  if (/admin_password[^\r\n]{0,80}(?:required|prompt|stdin)|(?:prompt|stdin)[^\r\n]{0,80}admin_password/u.test(text)) {
    return { code: 'wp_cli_password_input_failed', detail: 'WP-CLI rejected the non-TTY admin_password stdin prompt.' };
  }
  if (/pull access denied|manifest unknown|no matching manifest/u.test(text)) {
    return { code: 'official_image_unavailable', detail: 'Docker could not resolve the pinned official image.' };
  }
  if (/port is already allocated|address already in use/u.test(text)) return { code: 'port_unavailable' };
  if (/context deadline exceeded|i\/o timeout|timed out/u.test(text)) return { code: 'registry_timeout' };
  if (/unhealthy|dependency failed to start/u.test(text)) return { code: 'container_unhealthy' };
  return { code: 'exit_nonzero' };
}

export function sanitizedCliDiagnostic(raw: string): string | undefined {
  const candidates = raw.split(/\r?\n/u)
    .map(line => [...line].map(character => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    }).join('').trim())
    .filter(line => /(?:^|\s)(?:error|warning):/iu.test(line));
  const line = candidates.at(-1);
  if (!line) return undefined;
  const marker = line.search(/(?:error|warning):/iu);
  return line.slice(marker)
    .replace(/https?:\/\/[^\s"']+/giu, '[url]')
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/gu, '[path]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[email]')
    .replace(/\b(password|token|secret|authorization)\s*[=:]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/\b[A-F0-9]{24,}\b/giu, '[redacted]')
    .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/gu, '[redacted]')
    .slice(0, 200);
}

function fixedFailureCode(error: unknown, stage: FixtureStage): string {
  if (error instanceof SafeFixtureError) return error.code;
  if (error instanceof Error) {
    const known: Record<string, string> = {
      'WordPress edit response did not match the required schema': 'wp_edit_schema_invalid',
      'WordPress public response did not match the required schema': 'wp_public_schema_invalid',
      'WordPress public REST text did not match the authenticated body': 'wp_public_text_mismatch',
      'WordPress public page canonical did not match the authenticated post URL': 'wp_canonical_mismatch',
      'WordPress public page did not contain the approved visible body text': 'wp_page_text_mismatch',
      'WordPress redirects are not allowed': 'wp_redirect_rejected',
    };
    if (known[error.message]) return known[error.message];
    if (/^WordPress (?:edit|public(?: page)?) read failed with HTTP \d{3}$/.test(error.message)) return `wp_http_${error.message.slice(-3)}`;
  }
  if (error instanceof assert.AssertionError) return `assertion_failed_${stage}`;
  if (error instanceof DOMException && error.name === 'TimeoutError') return `timeout_${stage}`;
  return `failed_${stage}`;
}

export interface DockerCommandOptions {
  env: NodeJS.ProcessEnv;
  timeout: number;
  input?: string;
}

export type DockerCommandExecutor = (
  command: string,
  args: readonly string[],
  options: DockerCommandOptions,
) => Promise<{ stdout: string }>;

export interface DockerClient {
  context: string;
  endpoint: string;
  run(args: readonly string[], options?: { timeout?: number; input?: string }): Promise<string>;
}

export function dockerChildEnvironment(
  source: NodeJS.ProcessEnv,
  generated: { SITEOPS_TEST_DB_PASSWORD: string; SITEOPS_TEST_WP_PORT: string },
): NodeJS.ProcessEnv {
  if (!source.PATH || !source.HOME) throw new Error('Docker requires PATH and HOME');
  return {
    PATH: source.PATH,
    HOME: source.HOME,
    SITEOPS_TEST_DB_PASSWORD: generated.SITEOPS_TEST_DB_PASSWORD,
    SITEOPS_TEST_WP_PORT: generated.SITEOPS_TEST_WP_PORT,
  };
}

export async function spawnDockerCommand(
  command: string,
  args: readonly string[],
  options: DockerCommandOptions,
): Promise<{ stdout: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderrInspection = '';
    let stdoutInspection = '';
    const stdout: Buffer[] = [];
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout).toString('utf8') });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new SafeFixtureError('docker_timeout'));
    }, options.timeout);
    child.stdout.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      stdoutInspection = `${stdoutInspection}${buffer.toString()}`.slice(-8192);
      if (stdoutBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        finish(new SafeFixtureError('docker_output_limit'));
        return;
      }
      stdout.push(buffer);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      stderrInspection = `${stderrInspection}${chunk.toString()}`.slice(-8192);
      if (stderrBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        finish(new SafeFixtureError('docker_output_limit'));
      }
    });
    child.on('error', () => finish(new SafeFixtureError('docker_start_failed')));
    child.on('exit', (code, signal) => {
      if (code === 0) finish();
      else {
        void code;
        void signal;
        const inspected = `${stderrInspection}\n${stdoutInspection}`;
        const diagnostic = classifyDockerDiagnostic(inspected);
        finish(new SafeFixtureError(`docker_${diagnostic.code}`, diagnostic.detail ?? sanitizedCliDiagnostic(inspected)));
      }
    });
    child.stdin.end(options.input);
  });
}

function validateContextName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value)) throw new Error('Invalid Docker context name');
  return value;
}

function validateLocalDockerEndpoint(raw: string): string {
  let endpoint: unknown;
  try {
    endpoint = JSON.parse(raw.trim());
  } catch {
    throw new Error('Docker context returned an invalid endpoint');
  }
  if (typeof endpoint !== 'string') throw new Error('Docker context returned an invalid endpoint');
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('Docker context returned an invalid endpoint');
  }
  if (parsed.protocol !== 'unix:' || parsed.host !== '' || parsed.username !== ''
    || parsed.password !== '' || parsed.search !== '' || parsed.hash !== ''
    || !path.posix.isAbsolute(parsed.pathname)) {
    throw new Error('Docker context must use a local unix socket');
  }
  return endpoint;
}

export async function createLocalDockerClient(args: {
  sourceEnv: NodeJS.ProcessEnv;
  generatedEnv: { SITEOPS_TEST_DB_PASSWORD: string; SITEOPS_TEST_WP_PORT: string };
  execute?: DockerCommandExecutor;
}): Promise<DockerClient> {
  if (args.sourceEnv.DOCKER_HOST !== undefined) {
    throw new Error('DOCKER_HOST is forbidden for the disposable WordPress fixture');
  }
  const context = validateContextName(args.sourceEnv.SITEOPS_DOCKER_CONTEXT ?? DEFAULT_DOCKER_CONTEXT);
  const env = dockerChildEnvironment(args.sourceEnv, args.generatedEnv);
  const execute = args.execute ?? spawnDockerCommand;
  const invoke = async (
    dockerArgs: readonly string[],
    options: { timeout?: number; input?: string } = {},
  ): Promise<string> => {
    const result = await execute('docker', ['--context', context, ...dockerArgs], {
      env, timeout: options.timeout ?? 120_000, input: options.input,
    }).catch((error: unknown) => {
      if (error instanceof SafeFixtureError) throw error;
      throw new SafeFixtureError('docker_executor_failed');
    });
    return result.stdout.trim();
  };
  const endpoint = validateLocalDockerEndpoint(await invoke([
    'context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}',
  ], { timeout: 15_000 }));
  return { context, endpoint, run: invoke };
}

export function wordpressCoreInstallCommand(adminPassword: string): { args: string[]; input: string } {
  if (adminPassword.length < 20 || /[\r\n]/u.test(adminPassword)) {
    throw new Error('Invalid generated WordPress admin password');
  }
  return {
    args: [
      'core', 'install', '--url=https://siteops-wp.test', '--title=SiteOps disposable fixture',
      '--admin_user=siteops-test', '--admin_email=fixture@example.invalid', '--skip-email',
      '--prompt=admin_password',
    ],
    input: `${adminPassword}\n`,
  };
}

const WORDPRESS_HTTP_BRIDGE = [
  '$r=json_decode(stream_get_contents(STDIN),true);',
  'if(!is_array($r)||!is_string($r["path"]??null)||!is_string($r["method"]??null)||!is_array($r["headers"]??null))exit(2);',
  '$h=["Host: siteops-wp.test","X-Forwarded-Proto: https","X-Forwarded-Port: 443"];',
  'foreach($r["headers"] as $k=>$v){if(!is_string($k)||!is_string($v)||preg_match("/[\\r\\n:]/",$k)||preg_match("/[\\r\\n]/",$v))exit(3);$h[]=$k.": ".$v;}',
  '$o=["http"=>["method"=>$r["method"],"header"=>implode("\\r\\n",$h),"content"=>(string)($r["body"]??""),"ignore_errors"=>true,"follow_location"=>0,"timeout"=>30]];',
  '$b=@file_get_contents("http://127.0.0.1".$r["path"],false,stream_context_create($o));',
  'if($b===false&&!isset($http_response_header))exit(4);',
  '$s=0;$out=[];foreach(($http_response_header??[]) as $i=>$line){if($i===0&&preg_match("/ HTTP\\/\\S+ (\\d{3}) /"," ".$line." ",$m)){$s=(int)$m[1];continue;}if(str_contains($line,":")){[$k,$v]=explode(":",$line,2);$out[trim($k)]=trim($v);}}',
  'echo json_encode(["status"=>$s,"headers"=>$out,"body"=>base64_encode($b===false?"":$b)]);',
].join('');

export function wordpressHttpBridgeCommand(args: {
  url: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
}): { args: string[]; input: string } {
  const url = new URL(args.url);
  if (url.origin !== 'https://siteops-wp.test' || url.username || url.password || url.hash) {
    throw new SafeFixtureError('invalid_fixture_http_url');
  }
  if (args.body !== undefined && args.body !== null && typeof args.body !== 'string') {
    throw new SafeFixtureError('invalid_fixture_http_body');
  }
  return {
    args: ['exec', '-T', 'wordpress', 'php', '-r', WORDPRESS_HTTP_BRIDGE],
    input: JSON.stringify({
      path: `${url.pathname}${url.search}`,
      method: args.method ?? 'GET',
      headers: Object.fromEntries(new Headers(args.headers).entries()),
      body: args.body ?? '',
    }),
  };
}

function fixtureRouteCategory(pathname: string): string {
  if (/^\/wp-json\/wp\/v2\/posts\/\d+\/?$/u.test(pathname)) return 'rest_post';
  if (pathname === '/wp-admin/install.php') return 'installer';
  if (pathname === '/') return 'home';
  return 'public_post';
}

export function safeFixtureRedirectDiagnostic(args: {
  requestUrl: string;
  status: number;
  headers: Record<string, unknown>;
}): string | undefined {
  if (!Number.isInteger(args.status) || args.status < 300 || args.status >= 400) return undefined;
  let request: URL;
  try { request = new URL(args.requestUrl); } catch { return undefined; }
  if (request.origin !== 'https://siteops-wp.test' || request.username || request.password || request.hash) return undefined;
  const locationValue = Object.entries(args.headers)
    .find(([name, value]) => name.toLowerCase() === 'location' && typeof value === 'string')?.[1];
  if (typeof locationValue !== 'string' || locationValue.length > 2_048 || /[\r\n]/u.test(locationValue)) return undefined;
  let location: URL;
  try { location = new URL(locationValue, request); } catch { return undefined; }
  if (location.origin !== request.origin || location.username || location.password || location.hash) return undefined;
  const withoutTrailingSlash = (value: string): string => value === '/' ? value : value.replace(/\/$/u, '');
  return [
    `redirect_${args.status}`,
    `request=${fixtureRouteCategory(request.pathname)}`,
    `location=${fixtureRouteCategory(location.pathname)}`,
    `samePath=${String(location.pathname === request.pathname)}`,
    `trailingSlashOnly=${String(
      location.pathname !== request.pathname
      && withoutTrailingSlash(location.pathname) === withoutTrailingSlash(request.pathname)
    )}`,
    `sameQuery=${String(location.search === request.search)}`,
  ].join(' ').slice(0, 200);
}

async function main(): Promise<void> {
  // A real disposable WordPress installation. Never reads live configuration.
  const runId = crypto.randomUUID();
  const project = `siteops-test-${runId.slice(0, 8)}`;
  const root = path.resolve('work', project);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const port = Number(process.env.SITEOPS_TEST_WP_PORT ?? 18180);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local fixture port');
  const generatedEnv = {
    SITEOPS_TEST_DB_PASSWORD: crypto.randomBytes(24).toString('hex'),
    SITEOPS_TEST_WP_PORT: String(port),
  };
  const composeArgs = ['compose', '-p', project, '-f', path.resolve('tests/wordpress/compose.yml')];
  let docker: DockerClient | undefined;
  const compose = async (command: string[], timeout = 120_000, input?: string): Promise<string> => {
    if (!docker) throw new Error('Docker context is not verified');
    try {
      return await docker.run([...composeArgs, ...command], { timeout, input });
    } catch (error) {
      if (error instanceof SafeFixtureError) throw error;
      throw new SafeFixtureError('docker_compose_failed');
    }
  };
  const wp = (command: string[], input?: string) => compose(['run', '--rm', '-T', 'cli', 'wp', ...command], 120_000, input);
  const siteOrigin = 'https://siteops-wp.test';
  let lastRedirectDiagnostic: string | undefined;
  const localFetch: typeof fetch = async (request, init) => {
    const original = new URL(request instanceof Request ? request.url : String(request));
    assert.equal(original.origin, siteOrigin);
    const bridge = wordpressHttpBridgeCommand({ url: original.href, method: init?.method, headers: init?.headers, body: init?.body });
    const raw = await compose(bridge.args, 40_000, bridge.input);
    let decoded: unknown;
    try { decoded = JSON.parse(raw); } catch { throw new SafeFixtureError('invalid_fixture_http_response'); }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw new SafeFixtureError('invalid_fixture_http_response');
    const result = decoded as Record<string, unknown>;
    if (!Number.isInteger(result.status) || (result.status as number) < 100 || (result.status as number) > 599
      || typeof result.body !== 'string' || typeof result.headers !== 'object' || result.headers === null || Array.isArray(result.headers)) {
      throw new SafeFixtureError('invalid_fixture_http_response');
    }
    lastRedirectDiagnostic = safeFixtureRedirectDiagnostic({
      requestUrl: original.href,
      status: result.status as number,
      headers: result.headers as Record<string, unknown>,
    });
    let body: Buffer;
    try { body = Buffer.from(result.body, 'base64'); } catch { throw new SafeFixtureError('invalid_fixture_http_response'); }
    return new Response(Uint8Array.from(body), { status: result.status as number, headers: result.headers as Record<string, string> });
  };
  let store: Store | undefined;
  let mutationAttempted = false;
  let stage: FixtureStage = 'initialize';
  let status: 'passed' | 'failed' = 'failed';
  let errorCode: string | undefined;
  let debug: string | undefined;
  let cleanup: 'not_required' | 'passed' | 'failed' = 'not_required';
  let mode: 'demo' | 'codex' = 'demo';
  try {
    stage = 'verify_context';
    docker = await createLocalDockerClient({ sourceEnv: process.env, generatedEnv });
    stage = 'verify_engine';
    await docker.run(['info', '--format', '{{.ServerVersion}}'], { timeout: 15_000 });
    mutationAttempted = true;
    stage = 'compose_up';
    await compose(['up', '-d', '--wait', '--wait-timeout', '90'], 180_000);
    stage = 'container_http_ready';
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await compose(['exec', '-T', 'wordpress', 'php', '-r', '$s=@fsockopen("127.0.0.1",80); if (!$s) exit(1); fclose($s);'], 10_000);
        break;
      } catch {
        if (attempt === 59) throw new SafeFixtureError('wordpress_container_http_unavailable');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    stage = 'http_ready';
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await localFetch(`${siteOrigin}/wp-admin/install.php`, { signal: AbortSignal.timeout(2000) });
        break;
      } catch {
        if (attempt === 59) throw new SafeFixtureError('wordpress_host_http_unavailable');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    stage = 'core_install';
    const install = wordpressCoreInstallCommand(crypto.randomBytes(24).toString('hex'));
    await wp(install.args, install.input);
    stage = 'permalink_setup';
    await wp(['rewrite', 'structure', '/%postname%/', '--hard']);
    stage = 'app_password';
    const appPassword = await wp(['user', 'application-password', 'create', 'siteops-test', 'isolated-e2e', '--porcelain']);
    const snapshot = makeDemoSnapshot();
    stage = 'create_post';
    const postId = Number(await wp(['post', 'create', '--post_type=post', '--post_status=publish', '--post_title=Local editorial fixture', `--post_content=${snapshot.pages[0].bodyHtml}`, '--porcelain']));
    assert.ok(Number.isSafeInteger(postId) && postId > 0);
    const wordpress = new HttpWordPressAdapter({ siteOrigin, username: 'siteops-test', applicationPassword: appPassword, fetch: localFetch });
    stage = 'wordpress_readback';
    const original = await wordpress.getPostForEdit(postId);
    await wordpress.checkPublicReadback(original);
    mode = process.env.SITEOPS_TEST_AGENT === 'codex' ? 'codex' : 'demo';
    const agent = mode === 'codex'
      ? new CodexAgentAdapter({ command: process.env.SITEOPS_CODEX_COMMAND, cwd: process.cwd() })
      : new DemoAgentAdapter();
    const opportunity = { ...rankOpportunities(snapshot)[0], postId, url: original.url, title: original.protectedFields.title };
    stage = 'agent';
    const result = await agent.run({ taskId: runId, input: {
      page: { ...snapshot.pages[0], postId, url: original.url, title: original.protectedFields.title, bodyHtml: original.bodyHtml, protectedHash: hashPostState(original) },
      opportunity, evidence: snapshot.evidence, relatedPages: [],
      skillContent: 'Preserve every supported fact and add one brief practical suggestion without claiming improved traffic.', skillVersion: 'fixture-v1',
    }, signal: AbortSignal.timeout(180_000), onEvent: () => undefined });
    store = new Store(path.join(root, 'fixture.sqlite'));
    const storage = new SQLiteWriterStorage(store);
    const writer = new WriterService({ storage, adapter: wordpress, siteOrigin, lockPath: path.join(root, 'writer.lock') });
    const proposal: ChangeProposal = { id: runId, taskId: runId, postId, title: original.protectedFields.title, url: original.url,
      beforeHtml: original.bodyHtml, afterHtml: result.bodyHtml, summary: result.summary, evidenceIds: result.evidenceIds,
      baseHash: hashPostState(original), patchHash: hashPostState({ ...original, bodyHtml: result.bodyHtml }), status: 'pending', createdAt: new Date().toISOString() };
    await storage.saveProposal(proposal);
    const sessionId = crypto.randomUUID();
    stage = 'apply';
    const approval = await writer.approve({ proposalId: runId, sessionId, expectedPatchHash: proposal.patchHash });
    assert.equal((await writer.apply({ proposalId: runId, approvalId: approval.id, sessionId })).status, 'applied');
    stage = 'apply_readback';
    assert.equal(hashPostState(await wordpress.getPostForEdit(postId)), proposal.patchHash);
    stage = 'rollback';
    const rollback = await writer.approveRollback({ proposalId: runId, sessionId });
    assert.equal((await writer.rollback({ proposalId: runId, approvalId: rollback.id, sessionId })).status, 'rolled_back');
    stage = 'rollback_readback';
    assert.equal(hashPostState(await wordpress.getPostForEdit(postId)), proposal.baseHash);
    stage = 'completed';
    status = 'passed';
  } catch (error) {
    errorCode = fixedFailureCode(error, stage);
    if (error instanceof SafeFixtureError && error.safeDetail) debug = error.safeDetail.slice(0, 200);
    else if (errorCode === 'wp_redirect_rejected' && lastRedirectDiagnostic) debug = lastRedirectDiagnostic;
    process.exitCode = 1;
  } finally {
    store?.close();
    if (mutationAttempted) {
      cleanup = 'passed';
      await compose(['down', '--volumes']).catch(() => {
        cleanup = 'failed';
        status = 'failed';
        errorCode ??= 'cleanup_failed';
        process.exitCode = 1;
      });
    }
    const evidence = {
      schemaVersion: 1, runId, agent: mode, wordpress: 'real-local-container', status,
      stage, ...(errorCode ? { errorCode } : {}), ...(debug ? { debug } : {}), cleanup,
      appliedAndRestored: status === 'passed', productionWrites: 0, at: new Date().toISOString(),
      controls: { rawStdoutStored: false, rawStderrStored: false, configStored: false, credentialsStored: false },
    };
    try { await fs.writeFile(path.join(root, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 }); }
    catch { process.exitCode = 1; }
    console.log(JSON.stringify(evidence));
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) await main();
