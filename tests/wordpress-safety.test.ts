import { describe, expect, it } from 'vitest';
import {
  createLocalDockerClient,
  classifyDockerDiagnostic,
  dockerChildEnvironment,
  wordpressCoreInstallCommand,
  wordpressHttpBridgeCommand,
  safeFixtureRedirectDiagnostic,
  sanitizedCliDiagnostic,
  type DockerCommandExecutor,
  type DockerCommandOptions,
} from '../scripts/wordpress-e2e.js';

interface CapturedCall {
  command: string;
  args: string[];
  options: DockerCommandOptions;
}

const generatedEnv = {
  SITEOPS_TEST_DB_PASSWORD: 'fixture-db-password',
  SITEOPS_TEST_WP_PORT: '18180',
};

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: '/tmp/siteops-fixture-home',
    SITEOPS_DOCKER_CONTEXT: 'siteops-local-fixture',
    ...extra,
  };
}

function fakeDocker(endpoint: string): { calls: CapturedCall[]; execute: DockerCommandExecutor } {
  const calls: CapturedCall[] = [];
  const execute: DockerCommandExecutor = async (command, args, options) => {
    calls.push({
      command,
      args: [...args],
      options: { ...options, env: { ...options.env } },
    });
    if (args.includes('inspect')) return { stdout: JSON.stringify(endpoint) };
    return { stdout: 'ok' };
  };
  return { calls, execute };
}

describe('WordPress Docker fixture safety', () => {
  it('uses fixed WP-CLI diagnostics and does not confuse config lookup with image lookup', () => {
    const canary = 'FAKE_PASSWORD_AND_PATH_CANARY';
    const config = classifyDockerDiagnostic(`Error: wp-config.php not found at /private/${canary}`);
    expect(config).toEqual({
      code: 'wp_config_not_found',
      detail: 'WP-CLI could not find wp-config.php in the mounted WordPress path.',
    });
    expect(JSON.stringify(config)).not.toContain(canary);
    expect(classifyDockerDiagnostic('Error response from daemon: manifest unknown')).toEqual({
      code: 'official_image_unavailable', detail: 'Docker could not resolve the pinned official image.',
    });
  });

  it('retains at most one sanitized WP-CLI error line', () => {
    const secret = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';
    const detail = sanitizedCliDiagnostic([
      'untrusted progress output',
      `Error: request to https://private.example/path failed at /var/www/html/wp-config.php password=${secret}`,
    ].join('\n'));
    expect(detail).toBe('Error: request to [url] failed at [path] password=[redacted]');
    expect(detail?.length).toBeLessThanOrEqual(200);
    expect(detail).not.toContain(secret);
    expect(detail).not.toContain('private.example');
    expect(detail).not.toContain('/var/www');
    expect(sanitizedCliDiagnostic('raw docker progress without an allowlisted prefix')).toBeUndefined();
  });

  it('rejects DOCKER_HOST before invoking Docker', async () => {
    const fake = fakeDocker('unix:///tmp/siteops-docker.sock');

    await expect(createLocalDockerClient({
      sourceEnv: baseEnv({ DOCKER_HOST: 'tcp://production.example:2376' }),
      generatedEnv,
      execute: fake.execute,
    })).rejects.toThrow('DOCKER_HOST is forbidden');

    expect(fake.calls).toEqual([]);
  });

  it.each([
    'tcp://remote.example:2376',
    'ssh://operator@remote.example',
    'http://127.0.0.1:2375',
    'unix://remote.example/tmp/docker.sock',
    'unix:///tmp/docker.sock?unsafe=1',
  ])('rejects unsafe Docker endpoint %s before any mutation', async endpoint => {
    const fake = fakeDocker(endpoint);

    await expect(createLocalDockerClient({
      sourceEnv: baseEnv(),
      generatedEnv,
      execute: fake.execute,
    })).rejects.toThrow('Docker context must use a local unix socket');

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.args).toEqual([
      '--context', 'siteops-local-fixture', 'context', 'inspect',
      'siteops-local-fixture', '--format', '{{json .Endpoints.docker.Host}}',
    ]);
    expect(fake.calls[0]?.args).not.toEqual(expect.arrayContaining(['up']));
    expect(fake.calls[0]?.args).not.toEqual(expect.arrayContaining(['run']));
    expect(fake.calls[0]?.args).not.toEqual(expect.arrayContaining(['down']));
  });

  it('rejects invalid context names without invoking Docker', async () => {
    const fake = fakeDocker('unix:///tmp/siteops-docker.sock');

    await expect(createLocalDockerClient({
      sourceEnv: baseEnv({ SITEOPS_DOCKER_CONTEXT: 'local context; compose up' }),
      generatedEnv,
      execute: fake.execute,
    })).rejects.toThrow('Invalid Docker context name');

    expect(fake.calls).toEqual([]);
  });

  it('pins every Docker call to the verified local context', async () => {
    const fake = fakeDocker('unix:///tmp/siteops-docker.sock');
    const client = await createLocalDockerClient({
      sourceEnv: baseEnv(),
      generatedEnv,
      execute: fake.execute,
    });

    await client.run(['info']);
    await client.run(['compose', '-p', 'fixture', 'ps']);

    expect(client.endpoint).toBe('unix:///tmp/siteops-docker.sock');
    expect(fake.calls).toHaveLength(3);
    for (const call of fake.calls) {
      expect(call.command).toBe('docker');
      expect(call.args.slice(0, 2)).toEqual(['--context', 'siteops-local-fixture']);
    }
  });

  it('replaces executor failures with a fixed error that cannot expose dependency output', async () => {
    const secret = 'FAKE_DOCKER_DIAGNOSTIC_SECRET';
    const execute: DockerCommandExecutor = async () => { throw new Error(`credential=${secret}`); };
    let received: unknown;
    try {
      await createLocalDockerClient({ sourceEnv: baseEnv(), generatedEnv, execute });
    } catch (error) { received = error; }
    expect(received).toBeInstanceOf(Error);
    expect(String(received)).toContain('Disposable WordPress fixture operation failed');
    expect(String(received)).not.toContain(secret);
    expect(String(received)).not.toContain('credential=');
  });

  it('passes only the child environment allowlist', async () => {
    const productionSentinel = 'PRODUCTION_SECRET_SENTINEL_DO_NOT_EXPORT';
    const sourceEnv = baseEnv({
      OPENAI_API_KEY: productionSentinel,
      WORDPRESS_PASSWORD: productionSentinel,
      AWS_SECRET_ACCESS_KEY: productionSentinel,
      DOCKER_CONFIG: '/tmp/production-docker-config',
      NODE_OPTIONS: '--require=/tmp/unsafe-hook.js',
    });
    const fake = fakeDocker('unix:///tmp/siteops-docker.sock');
    const client = await createLocalDockerClient({ sourceEnv, generatedEnv, execute: fake.execute });

    await client.run(['info']);

    for (const call of fake.calls) {
      expect(Object.keys(call.options.env).sort()).toEqual([
        'HOME', 'PATH', 'SITEOPS_TEST_DB_PASSWORD', 'SITEOPS_TEST_WP_PORT',
      ]);
      expect(Object.values(call.options.env)).not.toContain(productionSentinel);
      expect(call.args.join('\0')).not.toContain(productionSentinel);
    }
  });

  it('keeps the generated WordPress admin password out of argv and child env', async () => {
    const adminPassword = 'FAKE_ADMIN_PASSWORD_SENTINEL_123456789';
    const install = wordpressCoreInstallCommand(adminPassword);
    const fake = fakeDocker('unix:///tmp/siteops-docker.sock');
    const client = await createLocalDockerClient({
      sourceEnv: baseEnv({ WORDPRESS_ADMIN_PASSWORD: adminPassword }),
      generatedEnv,
      execute: fake.execute,
    });

    await client.run(['compose', 'run', '--rm', '-T', 'cli', ...install.args], {
      input: install.input,
    });

    const installCall = fake.calls.at(-1);
    expect(install.args).toContain('--prompt=admin_password');
    expect(install.args.join('\0')).not.toContain(adminPassword);
    expect(installCall?.args.join('\0')).not.toContain(adminPassword);
    expect(Object.values(installCall?.options.env ?? {})).not.toContain(adminPassword);
    expect(installCall?.options.input).toBe(`${adminPassword}\n`);
  });

  it('passes WordPress HTTP credentials and bodies only through stdin to a fixed localhost bridge', () => {
    const secret = 'FAKE_APPLICATION_PASSWORD_SENTINEL';
    const bridge = wordpressHttpBridgeCommand({
      url: 'https://siteops-wp.test/wp-json/wp/v2/posts/42?context=edit',
      method: 'POST', headers: { Authorization: `Basic ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `<p>${secret}</p>` }),
    });
    expect(bridge.args.slice(0, 5)).toEqual(['exec', '-T', 'wordpress', 'php', '-r']);
    expect(bridge.args.join('\0')).not.toContain(secret);
    expect(bridge.args.join('\0')).toContain('http://127.0.0.1');
    expect(bridge.args.join('\0')).toContain('X-Forwarded-Proto: https');
    expect(bridge.args.join('\0')).toContain('X-Forwarded-Port: 443');
    expect(bridge.input).toContain(secret);
  });

  it('records only fixed same-origin redirect categories without leaking URL data', () => {
    const canary = 'FAKE_QUERY_SECRET_CANARY';
    const detail = safeFixtureRedirectDiagnostic({
      requestUrl: `https://siteops-wp.test/wp-json/wp/v2/posts/42?context=edit&secret=${canary}`,
      status: 301,
      headers: { Location: `https://siteops-wp.test/wp-json/wp/v2/posts/42?context=view&secret=${canary}` },
    });
    expect(detail).toBe('redirect_301 request=rest_post location=rest_post samePath=true trailingSlashOnly=false sameQuery=false');
    expect(detail).not.toContain(canary);
    expect(detail).not.toContain('context=');
  });

  it('does not retain redirect diagnostics for destinations outside the fixture origin', () => {
    const canary = 'FAKE_EXTERNAL_LOCATION_CANARY';
    expect(safeFixtureRedirectDiagnostic({
      requestUrl: 'https://siteops-wp.test/wp-json/wp/v2/posts/42?context=edit',
      status: 302,
      headers: { location: `https://outside.invalid/${canary}` },
    })).toBeUndefined();
  });

  it('rejects HTTP bridge destinations outside the fixed fixture origin', () => {
    expect(() => wordpressHttpBridgeCommand({ url: 'https://production.example/wp-json/wp/v2/posts/1' }))
      .toThrow('Disposable WordPress fixture operation failed');
  });

  it('requires PATH and HOME instead of inheriting process.env', () => {
    expect(() => dockerChildEnvironment({ HOME: '/tmp/home' }, generatedEnv)).toThrow('PATH and HOME');
    expect(() => dockerChildEnvironment({ PATH: '/usr/bin' }, generatedEnv)).toThrow('PATH and HOME');
  });
});
