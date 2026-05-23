import {docsSite, getAllDocs} from '../lib/docs';

export async function GET() {
  const docs = await getAllDocs();
  const absoluteUrl = (route: string) => new URL(route, docsSite).toString();

  const index = {
    product: 'Dynobox',
    description:
      'Local test runner for agent and skill workflows, with assertions over tools, files, transcripts, HTTP requests, and final messages.',
    package: 'dynobox',
    sdkPackage: '@dynobox/sdk',
    docs: {
      canonical: absoluteUrl('/'),
      llms: absoluteUrl('/llms.txt'),
      fullText: absoluteUrl('/llms-full.txt'),
    },
    pages: docs.map((doc) => ({
      title: doc.title,
      description: doc.description,
      agentSummary: doc.agentSummary,
      url: absoluteUrl(doc.route),
      markdown: absoluteUrl(doc.markdownRoute),
      source: doc.sourceUrl,
      topics: doc.topics,
      headings: doc.headings.map((heading) => ({
        title: heading.title,
        level: heading.level,
        url: `${absoluteUrl(doc.route)}#${heading.id}`,
      })),
    })),
  };

  return new Response(`${JSON.stringify(index, null, 2)}\n`, {
    headers: {'content-type': 'application/json; charset=utf-8'},
  });
}
