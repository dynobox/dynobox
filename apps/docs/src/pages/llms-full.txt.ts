import {docsSite, getAllDocs} from '../lib/docs';

export async function GET() {
  const docs = await getAllDocs();
  const absoluteUrl = (route: string) => new URL(route, docsSite).toString();

  const sections = docs.map((doc) =>
    [
      `# Page: ${doc.title}`,
      '',
      `Canonical URL: ${absoluteUrl(doc.route)}`,
      `Markdown URL: ${absoluteUrl(doc.markdownRoute)}`,
      `Source: ${doc.sourceUrl}`,
      `Topics: ${doc.topics.join(', ')}`,
      '',
      doc.source.trim(),
    ].join('\n'),
  );

  const body = [
    '# Dynobox Documentation Corpus',
    '',
    'This file concatenates the public Dynobox documentation into one plain-text corpus for agent ingestion.',
    '',
    ...sections,
  ].join('\n\n---\n\n');

  return new Response(`${body}\n`, {
    headers: {'content-type': 'text/plain; charset=utf-8'},
  });
}
