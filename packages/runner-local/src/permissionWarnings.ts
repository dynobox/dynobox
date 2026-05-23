import type {
  HarnessResult,
  HarnessRunOutput,
  ShellToolEvent,
  ToolEvent,
} from './harnesses/index.js';
import type {LocalRunnerWarning} from './runTypes.js';

export function permissionWarningsFromToolEvents(
  toolEvents: readonly ToolEvent[],
): LocalRunnerWarning[] {
  return dedupeWarnings(
    toolEvents.flatMap((event) => {
      if (event.status !== 'failure') return [];
      if (event.message === undefined) return [];
      if (!isPermissionDeniedText(event.message)) return [];
      return [permissionWarningForTool(event)];
    }),
  );
}

export function permissionWarningsFromHarnessFailure(
  harnessOutput: HarnessRunOutput,
  harnessResult: HarnessResult,
): LocalRunnerWarning[] {
  const text = [harnessOutput.stderr, harnessResult.transcript]
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .join('\n');

  if (!isPermissionDeniedText(text)) return [];
  return [
    {
      kind: 'permission_denied',
      message:
        'Harness blocked an action. Use --permission-mode dangerous only for trusted evals that intentionally need this access.',
    },
  ];
}

function permissionWarningForTool(event: ToolEvent): LocalRunnerWarning {
  return {
    kind: 'permission_denied',
    message:
      'Harness blocked a tool action. Use --permission-mode dangerous only for trusted evals that intentionally need this access.',
    tool: {
      kind: event.kind,
      rawName: event.rawName,
      ...(isShellToolEvent(event) ? {command: event.command} : {}),
    },
  };
}

function dedupeWarnings(
  warnings: readonly LocalRunnerWarning[],
): LocalRunnerWarning[] {
  const seen = new Set<string>();
  const deduped: LocalRunnerWarning[] = [];
  for (const warning of warnings) {
    const key = [
      warning.kind,
      warning.tool?.kind ?? '',
      warning.tool?.rawName ?? '',
      warning.tool?.command ?? '',
      warning.message,
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(warning);
  }
  return deduped;
}

function isShellToolEvent(event: ToolEvent): event is ShellToolEvent {
  return event.kind === 'shell' && 'command' in event;
}

function isPermissionDeniedText(value: string): boolean {
  return PERMISSION_DENIED_PATTERNS.some((pattern) => pattern.test(value));
}

const PERMISSION_DENIED_PATTERNS = [
  /\bpermission denied\b/i,
  /\boperation not permitted\b/i,
  /\bnot approved\b/i,
  /\bapproval denied\b/i,
  /\brequires approval\b/i,
  /\bdenied by policy\b/i,
  /\bblocked by sandbox\b/i,
  /\bsandbox denied\b/i,
] as const;
