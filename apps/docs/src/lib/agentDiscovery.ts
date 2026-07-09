import {createHash} from 'node:crypto';

import {docsSite} from './docs';

export const discoveryLinks = [
  {
    href: '/.well-known/api-catalog',
    rel: 'api-catalog',
  },
  {
    href: '/',
    rel: 'service-doc',
  },
  {
    href: '/README.md',
    rel: 'alternate',
    type: 'text/markdown',
  },
  {
    href: '/llms.txt',
    rel: 'alternate',
    type: 'text/plain',
  },
  {
    href: '/docs-index.json',
    rel: 'service-desc',
    type: 'application/json',
  },
] as const;

export const dynoboxDocsSkill = `---
name: dynobox-docs
description: Use the Dynobox documentation site to answer questions about installing, configuring, running, and debugging Dynobox agent workflow tests.
---

# Dynobox Docs

Use this skill when a user asks about Dynobox documentation, CLI usage, config authoring, CI setup, harnesses, assertions, or local agent workflow testing.

Start with the machine-readable docs index:

- Docs index: https://docs.dynobox.xyz/docs-index.json
- LLM overview: https://docs.dynobox.xyz/llms.txt
- Full docs corpus: https://docs.dynobox.xyz/llms-full.txt

Prefer page-specific Markdown URLs when fetching content:

- Overview: https://docs.dynobox.xyz/README.md
- Getting started: https://docs.dynobox.xyz/getting-started.md
- Agent skills: https://docs.dynobox.xyz/agent-skills.md
- Config authoring: https://docs.dynobox.xyz/config-authoring.md
- CLI reference: https://docs.dynobox.xyz/cli.md
- CI: https://docs.dynobox.xyz/ci.md

When answering, cite the page URL that supplied the answer and distinguish current local runner limits from planned behavior.
`;

export function absoluteDocsUrl(route: string): string {
  return new URL(route, docsSite).toString();
}

export function formatLinkHeader(): string {
  return discoveryLinks
    .map((link) => {
      const params = [
        `rel="${link.rel}"`,
        'type' in link && link.type ? `type="${link.type}"` : undefined,
      ].filter(Boolean);

      return `<${link.href}>; ${params.join('; ')}`;
    })
    .join(', ');
}

export function sha256Digest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
