const LINK_HEADER = [
  '</.well-known/api-catalog>; rel="api-catalog"',
  '</>; rel="service-doc"',
  '</README.md>; rel="alternate"; type="text/markdown"',
  '</llms.txt>; rel="alternate"; type="text/plain"',
  '</docs-index.json>; rel="service-desc"; type="application/json"',
].join(', ');

const MARKDOWN_ROUTES = new Map([
  ['/', '/README.md'],
  ['/getting-started/', '/getting-started.md'],
  ['/config-authoring/', '/config-authoring.md'],
  ['/cli/', '/cli.md'],
  ['/ci/', '/ci.md'],
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (prefersMarkdown(request)) {
      const markdownPath = markdownPathFor(url.pathname);

      if (markdownPath !== undefined) {
        const markdownUrl = new URL(request.url);
        markdownUrl.pathname = markdownPath;
        const markdownResponse = await env.ASSETS.fetch(
          new Request(markdownUrl, request),
        );

        if (markdownResponse.ok) {
          return withAgentHeaders(
            await responseWithMarkdownTokens(markdownResponse),
            request,
          );
        }
      }
    }

    return withAgentHeaders(await env.ASSETS.fetch(request), request);
  },
};

function prefersMarkdown(request) {
  const accept = request.headers.get('accept') ?? '';
  return accept
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .some(
      (entry) =>
        entry === 'text/markdown' || entry.startsWith('text/markdown;'),
    );
}

function markdownPathFor(pathname) {
  if (MARKDOWN_ROUTES.has(pathname)) return MARKDOWN_ROUTES.get(pathname);

  if (!pathname.endsWith('/') && MARKDOWN_ROUTES.has(`${pathname}/`)) {
    return MARKDOWN_ROUTES.get(`${pathname}/`);
  }

  return undefined;
}

async function responseWithMarkdownTokens(response) {
  const body = await response.text();
  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/markdown; charset=utf-8');
  headers.set('x-markdown-tokens', String(estimateTokens(body)));

  return new Response(body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function withAgentHeaders(response, request) {
  const headers = new Headers(response.headers);
  headers.set('link', LINK_HEADER);
  headers.set('content-signal', 'ai-train=yes, search=yes, ai-input=yes');

  if (isHtmlResponse(response)) {
    appendVary(headers, 'Accept');
  }

  if (request.headers.get('accept')?.includes('text/markdown')) {
    appendVary(headers, 'Accept');
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function isHtmlResponse(response) {
  return response.headers.get('content-type')?.includes('text/html') ?? false;
}

function appendVary(headers, value) {
  const current = headers.get('vary');
  if (!current) {
    headers.set('vary', value);
    return;
  }

  const entries = current.split(',').map((entry) => entry.trim().toLowerCase());
  if (!entries.includes(value.toLowerCase())) {
    headers.set('vary', `${current}, ${value}`);
  }
}

function estimateTokens(markdown) {
  return Math.max(1, Math.ceil(markdown.length / 4));
}
