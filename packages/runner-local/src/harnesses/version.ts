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
