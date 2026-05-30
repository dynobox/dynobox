import {describe, expect, it} from 'vitest';

import {
  authenticateBearerToken,
  authenticateForwardedIdentity,
  authenticateSupabaseUser,
  createCliToken,
  hashApiToken,
} from './auth.js';
import {createTestEnv, type TokenRow} from './test-support.js';

describe('api auth', () => {
  it('hashes API tokens with the Worker pepper', async () => {
    await expect(hashApiToken('token', 'pepper-a')).resolves.not.toBe(
      await hashApiToken('token', 'pepper-b'),
    );
    await expect(hashApiToken('token', 'pepper-a')).resolves.toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it('authenticates bearer tokens and updates last_used_at', async () => {
    const tokenHash = await hashApiToken('cli-token', 'test-pepper');
    const rows: TokenRow[] = [
      {
        last_used_at: null,
        provider: 'supabase',
        revoked_at: null,
        subject_id: 'user-123',
        token_hash: tokenHash,
      },
    ];

    const identity = await authenticateBearerToken(
      new Request('https://api.dynobox.xyz/runs', {
        headers: {authorization: 'Bearer cli-token'},
      }),
      createTestEnv(rows),
    );

    expect(identity).toEqual({provider: 'supabase', subjectId: 'user-123'});
    expect(rows[0]?.last_used_at).toEqual(expect.any(String));
  });

  it('rejects revoked bearer tokens', async () => {
    const tokenHash = await hashApiToken('cli-token', 'test-pepper');
    const rows: TokenRow[] = [
      {
        last_used_at: null,
        provider: 'supabase',
        revoked_at: '2026-05-30T00:00:00.000Z',
        subject_id: 'user-123',
        token_hash: tokenHash,
      },
    ];

    await expect(
      authenticateBearerToken(
        new Request('https://api.dynobox.xyz/runs', {
          headers: {authorization: 'Bearer cli-token'},
        }),
        createTestEnv(rows),
      ),
    ).resolves.toBeNull();
    expect(rows[0]?.last_used_at).toBeNull();
  });

  it('extracts forwarded identity behind a browser auth secret', () => {
    const identity = authenticateForwardedIdentity(
      new Request('https://api.dynobox.xyz/cli-tokens', {
        headers: {
          authorization: 'Bearer browser-secret',
          'x-dynobox-auth-provider': 'supabase',
          'x-dynobox-subject-id': 'user-123',
        },
      }),
      createTestEnv(),
    );

    expect(identity).toEqual({provider: 'supabase', subjectId: 'user-123'});
  });

  it('authenticates Supabase browser access tokens', async () => {
    const identity = await authenticateSupabaseUser(
      new Request('https://api.dynobox.xyz/cli-tokens', {
        headers: {authorization: 'Bearer supabase-token'},
      }),
      createTestEnv(),
      async (input, init) => {
        expect(input).toBe('https://supabase.example.test/auth/v1/user');
        expect(init?.headers).toEqual({
          apikey: 'supabase-anon-key',
          authorization: 'Bearer supabase-token',
        });
        return Response.json({id: 'user-123'});
      },
    );

    expect(identity).toEqual({provider: 'supabase', subjectId: 'user-123'});
  });

  it('fails token creation when TOKEN_PEPPER is missing', async () => {
    const env = {...createTestEnv(), TOKEN_PEPPER: ''};

    await expect(
      createCliToken(env, {provider: 'supabase', subjectId: 'user-123'}),
    ).rejects.toThrow('TOKEN_PEPPER is not configured.');
  });
});
