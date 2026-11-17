import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    // `runCli` tests use the real process entry point; keep them from writing
    // ~/.dynobox/telemetry.json or sending usage data.
    env: {DYNOBOX_TELEMETRY: '0'},
  },
});
