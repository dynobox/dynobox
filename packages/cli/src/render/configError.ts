/**
 * Stderr message rendered when `dynobox run <config>` fails to load or
 * validate the config module.
 */

export function renderRunConfigErrorMessage(
  configPath: string,
  message: string,
): string {
  return `dynobox run

config: ${configPath}
error: ${message}
`;
}
