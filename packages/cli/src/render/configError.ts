/**
 * Stderr message rendered when `dynobox run <config>` fails to load or
 * validate the config module.
 */

export function renderConfigErrorMessage(
  command: 'run' | 'validate',
  configPath: string,
  message: string,
): string {
  return `dynobox ${command}

config: ${configPath}
error: ${message}
`;
}

export function renderRunConfigErrorMessage(
  configPath: string,
  message: string,
): string {
  return renderConfigErrorMessage('run', configPath, message);
}
