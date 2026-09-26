import {execa} from 'execa';

const VERSION_PROBE_TIMEOUT_MS = 5_000;

export function createVersionProbe(
  executable: string,
): () => Promise<string | null> {
  let version: Promise<string | null> | undefined;
  return () => (version ??= probeVersion(executable));
}

async function probeVersion(executable: string): Promise<string | null> {
  try {
    const result = await execa(executable, ['--version'], {
      reject: false,
      stdin: 'ignore',
      timeout: VERSION_PROBE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return null;
    return parseVersion(result.stdout);
  } catch {
    return null;
  }
}

export function parseVersion(output: string): string | null {
  return (
    output.match(
      /\b(?:v)?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/,
    )?.[1] ?? null
  );
}

/** True when a parsed `major.minor.patch` version is at least `minimum`. */
export function isAtLeastVersion(
  version: string | null,
  minimum: string,
): boolean {
  const parse = (value: string) =>
    value.split(/[-+]/)[0]!.split('.').map(Number);
  if (version === null) return false;
  const actual = parse(version);
  const wanted = parse(minimum);
  if (actual.some((part) => !Number.isInteger(part))) return false;
  for (let index = 0; index < wanted.length; index++) {
    const difference = (actual[index] ?? 0) - wanted[index]!;
    if (difference !== 0) return difference > 0;
  }
  return true;
}
