import {AsyncLocalStorage} from 'node:async_hooks';

const dynoModuleUrlStorage = new AsyncLocalStorage<string>();

export function withDynoModuleUrl<T>(moduleUrl: string, callback: () => T): T {
  return dynoModuleUrlStorage.run(moduleUrl, callback);
}

export function currentDynoModuleUrl(): string | undefined {
  return dynoModuleUrlStorage.getStore();
}
