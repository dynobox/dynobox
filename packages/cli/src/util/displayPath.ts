import {isAbsolute, relative, sep} from 'node:path';

export function displayPath(filePath: string, cwd = process.cwd()): string {
  const rel = relative(cwd, filePath);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return filePath;
  }
  return rel;
}
