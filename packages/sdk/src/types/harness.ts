/**
 * Identifiers for the agent harnesses Dynobox can drive.
 *
 * Adding a value here is non-breaking; removing one is.
 */
export const HARNESS_IDS = ['claude-code', 'codex', 'opencode', 'pi'] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

export const PERMISSION_MODES = ['default', 'dangerous'] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type HarnessRunConfig =
  | HarnessId
  | {
      id: HarnessId;
      model?: string | undefined;
      permissionMode?: PermissionMode | undefined;
    };
