import type {IrScenario} from '@dynobox/sdk/ir';

export type CliMockConfig = IrScenario['cliMocks'][string];

export type CliMockFailure = {
  executable: string;
  argv: string[];
  message: string;
};

export type CliMockResponse = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CliMockAssignment =
  | {response: CliMockResponse; failure?: CliMockFailure}
  | {
      handler: Extract<CliMockConfig, {handler: unknown}>['handler'];
    };

export type CliMockResponseResolver = {
  reserve(
    executable: string,
    argv: string[],
    config: CliMockConfig,
  ): CliMockAssignment;
};

export function createCliMockResponseResolver(
  mocks: IrScenario['cliMocks'],
): CliMockResponseResolver {
  for (const [executable, config] of Object.entries(mocks)) {
    validateConfiguredResponses(executable, config);
  }

  const responseIndexes = new Map<string, number>();
  return {
    reserve(executable, argv, config) {
      if ('response' in config) return {response: config.response};
      if ('handler' in config) return {handler: config.handler};

      const index = responseIndexes.get(executable) ?? 0;
      responseIndexes.set(executable, index + 1);
      if (index < config.responses.length) {
        return {response: config.responses[index]!};
      }
      if (config.onExhausted === 'repeat-last') {
        return {response: config.responses.at(-1)!};
      }
      if (config.onExhausted !== undefined && config.onExhausted !== 'error') {
        return {response: config.onExhausted};
      }

      const message = mockFailureMessage(
        executable,
        argv,
        'exhausted its configured responses',
      );
      return {
        response: internalError(message),
        failure: {executable, argv: [...argv], message},
      };
    },
  };
}

export function normalizeHandlerResponse(value: unknown): CliMockResponse {
  if (!isRecord(value)) {
    throw new Error('returned an invalid response');
  }
  assertProcessExitCode(value.exitCode, 'returned an invalid response');
  if (value.stdout !== undefined && typeof value.stdout !== 'string') {
    throw new Error('returned an invalid response: stdout must be a string');
  }
  if (value.stderr !== undefined && typeof value.stderr !== 'string') {
    throw new Error('returned an invalid response: stderr must be a string');
  }
  return {
    exitCode: value.exitCode as number,
    stdout: (value.stdout as string | undefined) ?? '',
    stderr: (value.stderr as string | undefined) ?? '',
  };
}

export function mockFailureMessage(
  executable: string,
  argv: readonly string[],
  reason: string,
): string {
  const command = [executable, ...argv].join(' ');
  return `Dynobox CLI mock "${command}" ${reason}.`;
}

export function internalError(message: string): CliMockResponse {
  return {
    exitCode: 1,
    stdout: '',
    stderr: message.startsWith('Dynobox')
      ? `${message}\n`
      : `Dynobox CLI mock error: ${message}\n`,
  };
}

function validateConfiguredResponses(
  executable: string,
  config: CliMockConfig,
): void {
  if ('handler' in config) return;
  const responses =
    'response' in config
      ? [config.response]
      : [
          ...config.responses,
          ...(typeof config.onExhausted === 'object'
            ? [config.onExhausted]
            : []),
        ];
  for (const response of responses) {
    assertProcessExitCode(
      response.exitCode,
      `Invalid CLI mock response for ${JSON.stringify(executable)}`,
    );
  }
}

function assertProcessExitCode(
  value: unknown,
  context: string,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 255
  ) {
    throw new Error(
      `${context}: exitCode must be an integer between 0 and 255`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
