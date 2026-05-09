/** Compiler-facing SDK entrypoint used by the CLI and integrations. */

export {DynoboxConfigError} from './errors.js';
export {compile} from './ir/compile.js';
export {configSchema} from './schema/config-schema.js';
export {resolveConfigModule} from './schema/resolve-module.js';
