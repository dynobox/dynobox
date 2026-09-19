import {readFile, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';

import {parse, type ParseError} from 'jsonc-parser';

import {isRecord} from './parsing.js';

/** Prevent the pinned CLI's schema insertion and legacy migration writes. */
export async function checkOpenCodeConfigReads(
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  const home = env.HOME ?? homedir();
  const global = join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode');
  const directories = new Set([global, join(home, '.opencode')]);
  const files = new Set<string>([join(global, 'config.json')]);
  // Conservatively check all ancestors, including configs beyond a git root.
  for (let dir = cwd; ; dir = dirname(dir)) {
    directories.add(join(dir, '.opencode'));
    files.add(join(dir, 'opencode.json'));
    files.add(join(dir, 'opencode.jsonc'));
    if (dirname(dir) === dir) break;
  }
  if (env.OPENCODE_CONFIG) files.add(resolve(cwd, env.OPENCODE_CONFIG));
  if (env.OPENCODE_CONFIG_DIR)
    directories.add(resolve(cwd, env.OPENCODE_CONFIG_DIR));
  directories.add(
    env.OPENCODE_TEST_MANAGED_CONFIG_DIR ??
      (process.platform === 'darwin'
        ? '/Library/Application Support/opencode'
        : process.platform === 'win32'
          ? join(env.ProgramData ?? 'C:\\ProgramData', 'opencode')
          : '/etc/opencode'),
  );
  for (const dir of directories) {
    files.add(join(dir, 'opencode.json'));
    files.add(join(dir, 'opencode.jsonc'));
  }
  const read = async (path: string) => {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error();
      return await readFile(path, 'utf8');
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return undefined;
      throw error; // The adapter converts filesystem errors to a safe category.
    }
  };
  if ((await read(join(global, 'config'))) !== undefined) throw new Error();
  for (const path of files) {
    const text = await read(path);
    if (text === undefined || text === '') continue;
    const errors: ParseError[] = [];
    const value: unknown = parse(text, errors, {allowTrailingComma: true});
    if (
      errors.length ||
      !isRecord(value) ||
      typeof value.$schema !== 'string' ||
      !value.$schema ||
      value.$schema.includes('{')
    )
      throw new Error('OpenCode MCP requires a literal config schema.');
  }
}
