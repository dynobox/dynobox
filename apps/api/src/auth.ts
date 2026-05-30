import type {ApiBindings, Identity} from './types.js';

type ApiTokenRow = {
  provider: string;
  subject_id: string;
};

const API_TOKEN_BYTES = 32;
const TOKEN_PREFIX = 'dyno_';
const DEFAULT_BROWSER_PROVIDER = 'supabase';
const PROVIDER_HEADER = 'x-dynobox-auth-provider';
const SUBJECT_ID_HEADER = 'x-dynobox-subject-id';

/** Generates the opaque token shown once to CLI users. D1 stores only its hash. */
export function generateApiToken(): string {
  const bytes = new Uint8Array(API_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return `${TOKEN_PREFIX}${base64UrlEncode(bytes)}`;
}

/** Hashes tokens with a Worker secret pepper so leaked D1 rows are not enough to authenticate. */
export async function hashApiToken(
  token: string,
  pepper: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${pepper}:${token}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function authenticateBearerToken(
  request: Request,
  env: ApiBindings,
): Promise<Identity | null> {
  const token = getBearerToken(request);
  if (token === null || env.TOKEN_PEPPER.length === 0) {
    return null;
  }

  const tokenHash = await hashApiToken(token, env.TOKEN_PEPPER);
  const row = await env.DB.prepare(
    `SELECT provider, subject_id
     FROM api_tokens
     WHERE token_hash = ? AND revoked_at IS NULL`,
  )
    .bind(tokenHash)
    .first<ApiTokenRow>();

  if (row === null) {
    return null;
  }

  await env.DB.prepare(
    `UPDATE api_tokens
     SET last_used_at = ?
     WHERE token_hash = ? AND revoked_at IS NULL`,
  )
    .bind(new Date().toISOString(), tokenHash)
    .run();

  return {provider: row.provider, subjectId: row.subject_id};
}

export function authenticateBrowserIdentity(
  request: Request,
  env: ApiBindings,
): Identity | null {
  // The app validates Supabase sessions, then calls this Worker with a server-held secret.
  // Identity headers are only trusted after that secret check succeeds.
  const token = getBearerToken(request);
  if (
    token === null ||
    env.BROWSER_AUTH_SECRET.length === 0 ||
    token !== env.BROWSER_AUTH_SECRET
  ) {
    return null;
  }

  const provider =
    request.headers.get(PROVIDER_HEADER) ?? DEFAULT_BROWSER_PROVIDER;
  const subjectId = request.headers.get(SUBJECT_ID_HEADER);

  if (!isValidProvider(provider) || !isValidSubjectId(subjectId)) {
    return null;
  }

  return {provider, subjectId};
}

export async function createCliToken(
  env: ApiBindings,
  identity: Identity,
): Promise<string> {
  if (env.TOKEN_PEPPER.length === 0) {
    throw new Error('TOKEN_PEPPER is not configured.');
  }

  const token = generateApiToken();
  const tokenHash = await hashApiToken(token, env.TOKEN_PEPPER);

  await env.DB.prepare(
    `INSERT INTO api_tokens (id, subject_id, provider, token_hash)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), identity.subjectId, identity.provider, tokenHash)
    .run();

  return token;
}

function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  return match?.[1]?.trim() || null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function isValidProvider(provider: string): boolean {
  return /^[a-z][a-z0-9_-]{0,31}$/.test(provider);
}

function isValidSubjectId(subjectId: string | null): subjectId is string {
  return subjectId !== null && subjectId.length > 0 && subjectId.length <= 256;
}
