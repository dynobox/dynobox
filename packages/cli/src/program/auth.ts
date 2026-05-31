import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

export const DYNOBOX_CONFIG_DIR = '.dynobox';
export const DYNOBOX_CONFIG_FILE = 'config.json';
export const DYNOBOX_CONFIG_MODE = 0o600;

export type AuthEnvironment = Record<string, string | undefined>;

export type ResolveAuthTokenInput = {
  env?: AuthEnvironment;
  homeDir?: string;
};

export type WriteAuthConfigInput = {
  token: string;
  env?: AuthEnvironment;
  homeDir?: string;
};

export function resolveAuthToken(input: ResolveAuthTokenInput = {}): string | null {
  const env = input.env ?? process.env;
  const envToken = normalizeToken(env.DYNOBOX_TOKEN);
  if (envToken !== null) return envToken;

  const configPath = authConfigPath(input);
  if (!existsSync(configPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    if (!isObject(parsed)) return null;
    return normalizeToken(parsed.token);
  } catch {
    return null;
  }
}

export function writeAuthConfig(input: WriteAuthConfigInput): string {
  const configPath = authConfigPath(input);
  mkdirSync(authConfigDir(input), {recursive: true});
  writeFileSync(
    configPath,
    `${JSON.stringify({token: input.token}, null, 2)}\n`,
    {mode: DYNOBOX_CONFIG_MODE},
  );
  chmodSync(configPath, DYNOBOX_CONFIG_MODE);
  return configPath;
}

export function authConfigPath(input: ResolveAuthTokenInput = {}): string {
  return join(authConfigDir(input), DYNOBOX_CONFIG_FILE);
}

export function authConfigDisplayPath(): string {
  return `~/${DYNOBOX_CONFIG_DIR}/${DYNOBOX_CONFIG_FILE}`;
}

function authConfigDir(input: ResolveAuthTokenInput = {}): string {
  return join(resolveHomeDir(input), DYNOBOX_CONFIG_DIR);
}

function resolveHomeDir(input: ResolveAuthTokenInput = {}): string {
  return input.homeDir ?? input.env?.HOME ?? process.env.HOME ?? homedir();
}

function normalizeToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return token.length > 0 ? token : null;
}

function isObject(value: unknown): value is {token?: unknown} {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
