import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {authConfigPath, DYNOBOX_CONFIG_MODE, resolveAuthToken} from './auth.js';
import {executeCli} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';
import {readProcessStdin} from './loginCommand.js';

const ROOT = join(process.cwd(), '.tmp-dynobox-cli-tests-login');

function homeDir(name: string): string {
  return join(ROOT, name);
}

function stubFetch(response: typeof fetch): typeof fetch {
  const fetchMock = vi.fn(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as typeof fetch;
}

function stubValidTokenFetch(): typeof fetch {
  return stubFetch(async () =>
    Response.json({
      identity: {provider: 'supabase', subjectId: 'user-123'},
    }),
  );
}

function stubUnauthorizedFetch(): typeof fetch {
  return stubFetch(async () =>
    Response.json(
      {error: {code: 'unauthorized', message: 'Invalid or revoked token.'}},
      {status: 401},
    ),
  );
}

function stubExpiredFetch(): typeof fetch {
  return stubFetch(async () =>
    Response.json(
      {error: {code: 'token_expired', message: 'Token expired.'}},
      {status: 401},
    ),
  );
}

describe('masked token input', () => {
  it('masks pasted characters and erases the mask on backspace', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode: vi.fn(),
    });
    const output: string[] = [];
    const result = readProcessStdin(
      (value) => output.push(value),
      stdin as unknown as typeof process.stdin,
    );

    stdin.write('\x7fabc\x7fd\r');

    await expect(result).resolves.toBe('abd');
    expect(output.join('')).toBe('***\b \b*');
    expect(stdin.setRawMode.mock.calls).toEqual([[true], [false]]);
  });

  it('restores terminal state when mask output fails', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode: vi.fn(),
    });
    const pause = vi.spyOn(stdin, 'pause');
    const outputError = new Error('stdout unavailable');
    const result = readProcessStdin(
      () => {
        throw outputError;
      },
      stdin as unknown as typeof process.stdin,
    );

    stdin.write('a');

    await expect(result).rejects.toBe(outputError);
    expect(stdin.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(pause).toHaveBeenCalledOnce();
    expect(stdin.listenerCount('data')).toBe(0);
  });
});

describe('dynobox login', () => {
  beforeAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
    mkdirSync(ROOT, {recursive: true});
  });

  beforeEach(() => {
    stubValidTokenFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
  });

  it('prints the CLI auth URL, reads a pasted token, and writes config', async () => {
    const home = homeDir('default-url');
    const result = await executeCli(['login'], {
      env: {HOME: home},
      readStdin: async () => ' pasted-token\n',
    });

    const filePath = authConfigPath({homeDir: home});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('https://dash.dynobox.xyz/cli-auth');
    expect(result.stdout).toContain('Paste your Dynobox token:');
    expect(result.stdout).toContain('Saved token to ~/.dynobox/config.json');
    expect(result.stderr).toBe('');
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      token: 'pasted-token',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.dynobox.xyz/auth/identity',
      {
        headers: {authorization: 'Bearer pasted-token'},
        method: 'GET',
        signal: expect.any(AbortSignal),
      },
    );
    expect(resolveAuthToken({env: {}, homeDir: home})).toBe('pasted-token');
    expect(statSync(filePath).mode & 0o777).toBe(DYNOBOX_CONFIG_MODE);
  });

  it('uses DYNOBOX_DASHBOARD_URL for development auth links', async () => {
    const home = homeDir('custom-url');
    const result = await executeCli(['login'], {
      env: {
        HOME: home,
        DYNOBOX_API_URL: 'http://localhost:8787/',
        DYNOBOX_DASHBOARD_URL: 'http://localhost:5173/',
      },
      readStdin: async () => 'dev-token',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('http://localhost:5173/cli-auth');
    expect(fetch).toHaveBeenCalledWith('http://localhost:8787/auth/identity', {
      headers: {authorization: 'Bearer dev-token'},
      method: 'GET',
      signal: expect.any(AbortSignal),
    });
  });

  it('rejects empty pasted tokens', async () => {
    const home = homeDir('empty-token');
    const result = await executeCli(['login'], {
      env: {HOME: home},
      readStdin: async () => '   \n',
    });

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stderr).toContain('error: token cannot be empty');
    expect(resolveAuthToken({env: {}, homeDir: home})).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects invalid or revoked pasted tokens without writing config', async () => {
    stubUnauthorizedFetch();
    const home = homeDir('invalid-token');
    const filePath = authConfigPath({homeDir: home});

    const result = await executeCli(['login'], {
      env: {HOME: home},
      readStdin: async () => 'invalid-token',
    });

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stderr).toContain('error: invalid or revoked token');
    expect(existsSync(filePath)).toBe(false);
    expect(resolveAuthToken({env: {}, homeDir: home})).toBeNull();
  });

  it('rejects expired pasted tokens without writing config', async () => {
    stubExpiredFetch();
    const home = homeDir('expired-token');
    const filePath = authConfigPath({homeDir: home});

    const result = await executeCli(['login'], {
      env: {HOME: home},
      readStdin: async () => 'expired-token',
    });

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stderr).toContain(
      'error: token expired; run `dynobox login` again to re-authenticate',
    );
    expect(existsSync(filePath)).toBe(false);
    expect(resolveAuthToken({env: {}, homeDir: home})).toBeNull();
  });

  it('rejects unreachable token validation without writing config', async () => {
    stubFetch(async () => {
      throw new Error('network down');
    });
    const home = homeDir('network-failure');
    const filePath = authConfigPath({homeDir: home});

    const result = await executeCli(['login'], {
      env: {HOME: home},
      readStdin: async () => 'pasted-token',
    });

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stderr).toContain(
      'error: could not validate token; unable to reach the Dynobox API',
    );
    expect(existsSync(filePath)).toBe(false);
  });

  it('bounds token validation duration with an abort signal', async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    const home = homeDir('timeout-signal');

    const result = await executeCli(['login'], {
      env: {HOME: home},
      readStdin: async () => 'pasted-token',
    });

    expect(result.exitCode).toBe(0);
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.dynobox.xyz/auth/identity',
      {
        headers: {authorization: 'Bearer pasted-token'},
        method: 'GET',
        signal,
      },
    );
  });

  it('leaves existing config unchanged when validation fails', async () => {
    stubUnauthorizedFetch();
    const home = homeDir('unchanged-config');
    const filePath = authConfigPath({homeDir: home});
    mkdirSync(join(home, '.dynobox'), {recursive: true});
    writeFileSync(filePath, '{"token":"existing-token"}\n');

    const result = await executeCli(['login'], {
      env: {HOME: home},
      readStdin: async () => 'replacement-token',
    });

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(readFileSync(filePath, 'utf8')).toBe('{"token":"existing-token"}\n');
    expect(resolveAuthToken({env: {}, homeDir: home})).toBe('existing-token');
  });

  it('overwrites existing malformed config', async () => {
    const home = homeDir('overwrite-malformed');
    const filePath = authConfigPath({homeDir: home});
    mkdirSync(join(home, '.dynobox'), {recursive: true});
    writeFileSync(filePath, 'not json');

    const result = await executeCli(['login'], {
      env: {HOME: home},
      readStdin: async () => 'replacement-token',
    });

    expect(result.exitCode).toBe(0);
    expect(resolveAuthToken({env: {}, homeDir: home})).toBe(
      'replacement-token',
    );
    expect(statSync(filePath).mode & 0o777).toBe(DYNOBOX_CONFIG_MODE);
  });
});
