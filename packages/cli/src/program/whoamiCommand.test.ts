import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

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

import {authConfigPath, writeAuthConfig} from './auth.js';
import {executeCli} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';

const ROOT = join(process.cwd(), '.tmp-dynobox-cli-tests-whoami');

function homeDir(name: string): string {
  return join(ROOT, name);
}

function stubFetch(response: typeof fetch): typeof fetch {
  const fetchMock = vi.fn(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as typeof fetch;
}

function stubIdentityFetch(identity: unknown): typeof fetch {
  return stubFetch(async () => Response.json({identity}));
}

describe('dynobox whoami', () => {
  beforeAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
    mkdirSync(ROOT, {recursive: true});
  });

  beforeEach(() => {
    stubIdentityFetch({email: 'user@example.com'});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
  });

  it('reports no token without calling the API', async () => {
    const result = await executeCli(['whoami'], {
      env: {HOME: homeDir('missing-token')},
    });

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'error: not authenticated; run `dynobox login` first',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('prints the authenticated email for a valid token', async () => {
    const home = homeDir('valid-token');
    writeAuthConfig({homeDir: home, token: 'saved-token'});

    const result = await executeCli(['whoami'], {
      env: {HOME: home},
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'Authenticated as user@example.com\nToken loaded from ~/.dynobox/config.json\n',
    );
    expect(result.stderr).toBe('');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.dynobox.xyz/auth/identity',
      {
        headers: {authorization: 'Bearer saved-token'},
        method: 'GET',
        signal: expect.any(AbortSignal),
      },
    );
  });

  it('prints a refresh message when valid tokens have no email metadata', async () => {
    stubIdentityFetch({provider: 'supabase', subjectId: 'user-123'});
    const home = homeDir('missing-email');
    writeAuthConfig({homeDir: home, token: 'saved-token'});

    const result = await executeCli(['whoami'], {
      env: {HOME: home},
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'Authenticated, but this token has no email metadata. Run `dynobox login` again to refresh it.\nToken loaded from ~/.dynobox/config.json\n',
    );
    expect(result.stderr).toBe('');
  });

  it('rejects invalid or revoked tokens', async () => {
    stubFetch(async () =>
      Response.json(
        {error: {code: 'unauthorized', message: 'Invalid or revoked token.'}},
        {status: 401},
      ),
    );
    const home = homeDir('invalid-token');
    writeAuthConfig({homeDir: home, token: 'invalid-token'});

    const result = await executeCli(['whoami'], {
      env: {HOME: home},
    });

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('error: invalid or revoked token');
  });

  it('reports expired tokens', async () => {
    stubFetch(async () =>
      Response.json(
        {error: {code: 'token_expired', message: 'Token expired.'}},
        {status: 401},
      ),
    );
    const home = homeDir('expired-token');
    writeAuthConfig({homeDir: home, token: 'expired-token'});

    const result = await executeCli(['whoami'], {
      env: {HOME: home},
    });

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'error: token expired; run `dynobox login` again to re-authenticate',
    );
  });

  it('uses DYNOBOX_API_URL for identity lookup', async () => {
    const home = homeDir('custom-api-url');
    writeAuthConfig({homeDir: home, token: 'dev-token'});

    const result = await executeCli(['whoami'], {
      env: {DYNOBOX_API_URL: 'http://localhost:8787/', HOME: home},
    });

    expect(result.exitCode).toBe(0);
    expect(fetch).toHaveBeenCalledWith('http://localhost:8787/auth/identity', {
      headers: {authorization: 'Bearer dev-token'},
      method: 'GET',
      signal: expect.any(AbortSignal),
    });
  });

  it('reports network failures', async () => {
    stubFetch(async () => {
      throw new Error('network down');
    });
    const home = homeDir('network-failure');
    writeAuthConfig({homeDir: home, token: 'saved-token'});

    const result = await executeCli(['whoami'], {
      env: {HOME: home},
    });

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'error: could not verify identity; unable to reach the Dynobox API',
    );
  });

  it('prefers DYNOBOX_TOKEN over the saved config token', async () => {
    const home = homeDir('env-token');
    const filePath = authConfigPath({homeDir: home});
    mkdirSync(join(home, '.dynobox'), {recursive: true});
    writeFileSync(filePath, JSON.stringify({token: 'saved-token'}));

    const result = await executeCli(['whoami'], {
      env: {DYNOBOX_TOKEN: 'env-token', HOME: home},
    });

    expect(result.exitCode).toBe(0);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.dynobox.xyz/auth/identity',
      {
        headers: {authorization: 'Bearer env-token'},
        method: 'GET',
        signal: expect.any(AbortSignal),
      },
    );
  });
});
