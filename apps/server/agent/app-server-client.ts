import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AgentProtocolError, AgentSecurityError } from './errors.js';

type JsonObject = Record<string, unknown>;

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface AppServerConnectionOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnProcess?: SpawnProcess;
  onNotification: (method: string, params: unknown) => void;
  onFatal: (error: Error) => void;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const MAX_MESSAGE_BYTES = 1_048_576;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestId(value: unknown): number | string | undefined {
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}

export class AppServerConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private closed = false;
  private stderrBytes = 0;

  constructor(private readonly options: AppServerConnectionOptions) {
    const launch = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.child = launch(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderrBytes += Buffer.byteLength(chunk);
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.handleLine(line));
    this.child.on('error', () => this.fail(new AgentProtocolError('Unable to start Codex app-server')));
    this.child.on('exit', (code, signal) => {
      if (!this.closed) {
        const suffix = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
        this.fail(new AgentProtocolError(`Codex app-server exited unexpectedly (${suffix})`));
      }
    });
  }

  get diagnosticStderrBytes(): number {
    return this.stderrBytes;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new AgentProtocolError('Codex app-server connection is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.write({ method, id, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) throw new AgentProtocolError('Codex app-server connection is closed');
    this.write({ method, params });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new AgentProtocolError('Codex app-server connection closed before the response arrived'));
    }
    this.pending.clear();
    this.child.stdin.end();
    this.child.kill('SIGTERM');
  }

  private write(message: JsonObject): void {
    const encoded = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES) {
      this.fail(new AgentProtocolError('Codex app-server request exceeded the message limit'));
      return;
    }
    this.child.stdin.write(encoded);
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
      this.fail(new AgentProtocolError('Codex app-server response exceeded the message limit'));
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      this.fail(new AgentProtocolError('Codex app-server emitted invalid JSON'));
      return;
    }
    if (!isObject(decoded)) {
      this.fail(new AgentProtocolError('Codex app-server emitted an invalid message envelope'));
      return;
    }

    const id = requestId(decoded.id);
    if (id !== undefined && ('result' in decoded || 'error' in decoded)) {
      if (typeof id !== 'number') {
        this.fail(new AgentProtocolError('Codex app-server returned a non-numeric response ID'));
        return;
      }
      const pending = this.pending.get(id);
      if (!pending) {
        this.fail(new AgentProtocolError('Codex app-server returned an unknown response ID'));
        return;
      }
      this.pending.delete(id);
      if ('error' in decoded && decoded.error !== undefined) {
        const code = isObject(decoded.error) && typeof decoded.error.code === 'number'
          ? decoded.error.code
          : 'unknown';
        pending.reject(new AgentProtocolError(`Codex RPC ${pending.method} failed (${code})`));
      } else {
        pending.resolve(decoded.result);
      }
      return;
    }

    if (typeof decoded.method !== 'string') {
      this.fail(new AgentProtocolError('Codex app-server message omitted its method'));
      return;
    }
    if (id !== undefined) {
      this.write({
        id,
        error: { code: -32601, message: 'YOLO SiteOps rejects server-initiated requests' },
      });
      this.fail(new AgentSecurityError(`Codex attempted a forbidden server request: ${decoded.method}`));
      return;
    }
    try {
      this.options.onNotification(decoded.method, decoded.params);
    } catch (error) {
      this.fail(error instanceof Error ? error : new AgentProtocolError('Notification handling failed'));
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.options.onFatal(error);
    this.close();
  }
}

export function safeCodexEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = [
    'HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'SHELL', 'USER', 'LOGNAME', 'CODEX_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ];
  return Object.fromEntries(allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]));
}
