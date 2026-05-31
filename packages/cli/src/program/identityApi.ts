import type {AuthEnvironment} from './auth.js';

export const DEFAULT_API_URL = 'https://api.dynobox.xyz';
export const IDENTITY_REQUEST_TIMEOUT_MS = 10_000;

export type CliIdentity = {
  email?: string;
  provider?: string;
  subjectId?: string;
};

export type IdentityResult =
  | {status: 'authenticated'; identity: CliIdentity}
  | {status: 'expired'}
  | {status: 'unauthorized'}
  | {status: 'network_failure'}
  | {status: 'api_error'; httpStatus: number};

export async function fetchAuthenticatedIdentity(input: {
  apiUrl: string;
  token: string;
}): Promise<IdentityResult> {
  let response: Response;
  try {
    response = await fetch(`${input.apiUrl}/auth/identity`, {
      headers: {authorization: `Bearer ${input.token}`},
      method: 'GET',
      signal: AbortSignal.timeout(IDENTITY_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return {status: 'network_failure'};
  }

  if (response.status === 401) {
    const body = await response.json().catch(() => null);
    if (hasErrorCode(body, 'token_expired')) {
      return {status: 'expired'};
    }

    return {status: 'unauthorized'};
  }

  if (!response.ok) {
    return {status: 'api_error', httpStatus: response.status};
  }

  const body = await response.json().catch(() => null);
  return {status: 'authenticated', identity: parseIdentity(body)};
}

function hasErrorCode(body: unknown, code: string): boolean {
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return false;
  }

  const error = body.error;
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  return error.code === code;
}

export function resolveApiUrl(env: AuthEnvironment = process.env): string {
  return normalizeUrl(env.DYNOBOX_API_URL, DEFAULT_API_URL);
}

export function normalizeUrl(
  value: string | undefined,
  fallback: string,
): string {
  const raw = value?.trim() || fallback;
  return raw.replace(/\/+$/, '');
}

function parseIdentity(body: unknown): CliIdentity {
  if (typeof body !== 'object' || body === null || !('identity' in body)) {
    return {};
  }

  const identity = body.identity;
  if (typeof identity !== 'object' || identity === null) {
    return {};
  }

  return {
    ...readStringProperty(identity, 'email'),
    ...readStringProperty(identity, 'provider'),
    ...readStringProperty(identity, 'subjectId'),
  };
}

function readStringProperty(
  value: object,
  key: keyof CliIdentity,
): Partial<CliIdentity> {
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'string' && property.trim().length > 0
    ? {[key]: property.trim()}
    : {};
}
