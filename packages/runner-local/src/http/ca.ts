import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

import {generateCACertificate} from 'mockttp';

export type DynoboxCA = {
  certPath: string;
  keyPath: string;
  generated: boolean;
};

const initializationByDirectory = new Map<string, Promise<DynoboxCA>>();

export async function ensureDynoboxCA(
  options: {
    homeDir?: string;
  } = {},
): Promise<DynoboxCA> {
  const dynoboxDir = join(options.homeDir ?? homedir(), '.dynobox');
  const pending = initializationByDirectory.get(dynoboxDir);
  if (pending !== undefined) return pending;

  const initialization = initializeDynoboxCA(dynoboxDir);
  initializationByDirectory.set(dynoboxDir, initialization);
  try {
    return await initialization;
  } finally {
    if (initializationByDirectory.get(dynoboxDir) === initialization) {
      initializationByDirectory.delete(dynoboxDir);
    }
  }
}

async function initializeDynoboxCA(dynoboxDir: string): Promise<DynoboxCA> {
  const certPath = join(dynoboxDir, 'ca.pem');
  const keyPath = join(dynoboxDir, 'ca-key.pem');

  const existing = await readExistingCA(certPath, keyPath);
  if (existing) return {certPath, keyPath, generated: false};

  await mkdir(dynoboxDir, {recursive: true, mode: 0o700});
  const ca = await generateCACertificate({
    subject: {
      commonName: 'Dynobox local HTTP assertion CA',
      organizationName: 'Dynobox',
    },
  });
  await writeFile(certPath, ca.cert, {mode: 0o644});
  await writeFile(keyPath, ca.key, {mode: 0o600});

  return {certPath, keyPath, generated: true};
}

async function readExistingCA(
  certPath: string,
  keyPath: string,
): Promise<boolean> {
  try {
    const [cert, key] = await Promise.all([
      readFile(certPath, 'utf8'),
      readFile(keyPath, 'utf8'),
    ]);
    return cert.trim().length > 0 && key.trim().length > 0;
  } catch {
    return false;
  }
}
