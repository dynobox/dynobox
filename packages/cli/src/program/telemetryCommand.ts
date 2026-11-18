/**
 * Action handler for `dynobox telemetry [status|enable|disable]`.
 */

import type {OutputWriter} from './execute.js';
import {
  resolveTelemetryStatus,
  setTelemetryEnabled,
  TELEMETRY_DOCS_URL,
  type TelemetryEnvironment,
  type TelemetryStatus,
} from './telemetry.js';

export type TelemetryCommandActionInput = {
  action: 'status' | 'enable' | 'disable';
  writeStdout: OutputWriter;
  env?: TelemetryEnvironment;
  homeDir?: string;
};

export function telemetryCommandAction(
  input: TelemetryCommandActionInput,
): void {
  const paths = {
    ...(input.env === undefined ? {} : {env: input.env}),
    ...(input.homeDir === undefined ? {} : {homeDir: input.homeDir}),
  };

  if (input.action === 'enable' || input.action === 'disable') {
    const enabled = input.action === 'enable';
    setTelemetryEnabled(enabled, paths);
    const status = resolveTelemetryStatus(paths);
    input.writeStdout(`Telemetry ${enabled ? 'enabled' : 'disabled'}.\n`);
    if (status.enabled !== enabled) {
      input.writeStdout(
        `Note: ${status.source} overrides this setting, so telemetry is still ${status.enabled ? 'enabled' : 'disabled'}.\n`,
      );
    }
    return;
  }

  const status = resolveTelemetryStatus(paths);
  input.writeStdout(
    [
      `Telemetry: ${describeStatus(status)}`,
      `Install ID: ${status.installId ?? 'none yet'}`,
      ...(status.debug
        ? [
            'Debug: DYNOBOX_TELEMETRY_DEBUG is set; batches are printed, not sent',
          ]
        : []),
      `Details: ${TELEMETRY_DOCS_URL}`,
      '',
    ].join('\n'),
  );
}

function describeStatus(status: TelemetryStatus): string {
  const state = status.enabled ? 'enabled' : 'disabled';
  switch (status.source) {
    case 'DO_NOT_TRACK':
      return `${state} (DO_NOT_TRACK is set)`;
    case 'unreadable':
      return `${state} (~/.dynobox/telemetry.json could not be read; fix it or run \`dynobox telemetry enable|disable\`)`;
    case 'DYNOBOX_TELEMETRY':
      return `${state} (DYNOBOX_TELEMETRY is set)`;
    case 'config':
      return `${state} (dynobox telemetry ${status.enabled ? 'enable' : 'disable'})`;
    case 'CI':
      return `${state} in CI (set DYNOBOX_TELEMETRY=1 to enable)`;
    case 'default':
      return state;
  }
}
