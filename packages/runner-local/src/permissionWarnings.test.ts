import {describe, expect, it} from 'vitest';

import {permissionWarningsFromToolEvents} from './permissionWarnings.js';

describe('permissionWarningsFromToolEvents', () => {
  it('recognizes Cursor permission configuration denials', () => {
    expect(
      permissionWarningsFromToolEvents([
        {
          kind: 'shell',
          rawName: 'shell',
          input: {command: 'printf denied-review'},
          command: 'printf denied-review',
          status: 'failure',
          message: 'Command blocked by permissions configuration',
        },
      ]),
    ).toMatchObject([
      {
        kind: 'permission_denied',
        tool: {
          kind: 'shell',
          rawName: 'shell',
          command: 'printf denied-review',
        },
      },
    ]);
  });
});
