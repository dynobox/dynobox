import {docsSite, getAllDocs} from '../lib/docs';

export async function GET() {
  const docs = await getAllDocs();
  const absoluteUrl = (route: string) => new URL(route, docsSite).toString();
  const overview = docs.find((doc) => doc.file === 'README.md');
  const pages = docs.filter((doc) => doc.file !== 'README.md');

  const lines = [
    '# Dynobox',
    '',
    overview?.agentSummary ??
      'Dynobox is a local test runner for agent and skill workflows.',
    '',
    'Canonical docs: https://docs.dynobox.xyz/',
    'Source repository: https://github.com/dynobox/dynobox',
    'CLI package: dynobox',
    'SDK package: @dynobox/sdk',
    'Install CLI: npm install -g dynobox',
    '',
    '## Start Here',
    '',
    `- [Dynobox Docs](${absoluteUrl('/')})`,
    `- [Markdown overview](${absoluteUrl('/README.md')})`,
    `- [Full documentation text](${absoluteUrl('/llms-full.txt')})`,
    `- [Machine-readable docs index](${absoluteUrl('/docs-index.json')})`,
    '',
    '## Documentation Pages',
    '',
    ...pages.flatMap((doc) => [
      `- [${doc.title}](${absoluteUrl(doc.route)}): ${doc.agentSummary}`,
      `  - Markdown: ${absoluteUrl(doc.markdownRoute)}`,
      `  - Source: ${doc.sourceUrl}`,
    ]),
    '',
    '## Core Commands',
    '',
    '- Install: `npm install -g dynobox`',
    '- Create a starter dyno: `dynobox init`',
    '- Run discovered dynos: `dynobox run`',
    '- Run a target: `dynobox run [path]`',
    '- Select a harness: `dynobox run --harness claude-code` or `dynobox run --harness codex`',
    '- Emit machine-readable reports: `dynobox run --reporter json`',
    '',
    '## Agent Retrieval Notes',
    '',
    '- Prefer markdown URLs for ingestion when available.',
    '- Use `/llms-full.txt` when a single fetch should include the full docs corpus.',
    '- Use `/docs-index.json` to route questions by page title, topic, and heading.',
  ];

  return new Response(`${lines.join('\n')}\n`, {
    headers: {'content-type': 'text/plain; charset=utf-8'},
  });
}
