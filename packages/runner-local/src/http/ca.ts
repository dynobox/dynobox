import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {rootCertificates} from 'node:tls';

import {generateCACertificate} from 'mockttp';

export type DynoboxCA = {
  certPath: string;
  keyPath: string;
  /** The public roots plus the Dynobox CA, for clients that trust one file only. */
  bundlePath: string;
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
  const bundlePath = join(dynoboxDir, 'ca-bundle.pem');

  const generated = !(await readExistingCA(certPath, keyPath));
  if (generated) {
    await mkdir(dynoboxDir, {recursive: true, mode: 0o700});
    const ca = await generateCACertificate({
      subject: {
        commonName: 'Dynobox local HTTP assertion CA',
        organizationName: 'Dynobox',
      },
    });
    await writeFile(certPath, ca.cert, {mode: 0o644});
    await writeFile(keyPath, ca.key, {mode: 0o600});
  }
  await writeBundle(certPath, bundlePath);

  return {certPath, keyPath, bundlePath, generated};
}

// Clients that read SSL_CERT_FILE, REQUESTS_CA_BUNDLE, or CURL_CA_BUNDLE trust
// only that file, so it needs the public roots too, or every host not
// intercepted fails TLS. Written to a temp file and renamed, because
// concurrent jobs may read it.
async function writeBundle(certPath: string, bundlePath: string) {
  const cert = await readFile(certPath, 'utf8');
  const temp = `${bundlePath}.${randomUUID()}.tmp`;
  await writeFile(temp, [...rootCertificates, cert].join('\n'), {mode: 0o644});
  await rename(temp, bundlePath);
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
