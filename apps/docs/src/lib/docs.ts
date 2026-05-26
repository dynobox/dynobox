import {readFile} from 'node:fs/promises';
import path from 'node:path';

import Markdoc, {type Config, type RenderableTreeNode} from '@markdoc/markdoc';
import {createHighlighter, type HighlighterCore} from 'shiki';

const repoRoot = path.resolve(process.cwd(), '../..');
const docsRoot = path.join(repoRoot, 'docs');
const githubSourceBase = 'https://github.com/dynobox/dynobox/blob/main';
export const docsSite = 'https://docs.dynobox.xyz';

const docFiles = [
  'README.md',
  'getting-started.md',
  'config-authoring.md',
  'cli.md',
  'ci.md',
] as const;

const highlighter = createHighlighter({
  langs: [
    'bash',
    'javascript',
    'json',
    'markdown',
    'shellscript',
    'text',
    'typescript',
    'yaml',
  ],
  themes: ['github-light', 'github-dark'],
});

export type DocFile = (typeof docFiles)[number];

export type DocPage = {
  agentSummary: string;
  description: string;
  file: DocFile;
  headings: DocHeading[];
  html: string;
  markdownRoute: string;
  route: string;
  source: string;
  sourceUrl: string;
  slug: string;
  topics: readonly string[];
  title: string;
};

export type DocHeading = {
  id: string;
  level: 2 | 3;
  title: string;
};

export type DocNavItem = {
  route: string;
  title: string;
};

const docMetadata: Record<
  DocFile,
  {
    agentSummary: string;
    description: string;
    topics: readonly string[];
  }
> = {
  'README.md': {
    agentSummary:
      'Overview of Dynobox, supported harnesses, config formats, observable assertions, and current local runner limits.',
    description:
      'Dynobox documentation for local agent and skill workflow testing.',
    topics: [
      'overview',
      'agent testing',
      'harnesses',
      'assertions',
      'config formats',
    ],
  },
  'getting-started.md': {
    agentSummary:
      'Install the Dynobox CLI, scaffold a first dyno, choose harnesses, run targets, and debug local agent evals.',
    description:
      'Install Dynobox, create a first dyno, choose a harness, and run local agent workflow tests.',
    topics: ['install', 'init', 'run', 'harnesses', 'debug'],
  },
  'config-authoring.md': {
    agentSummary:
      'Author JavaScript, TypeScript, and YAML dynos with @dynobox/sdk helpers, assertions, harness options, HTTP capture, and reusable scenarios.',
    description:
      'Write Dynobox configs with SDK helpers, YAML objects, harness settings, assertions, HTTP checks, and path helpers.',
    topics: [
      '@dynobox/sdk',
      'defineDyno',
      'YAML',
      'assertions',
      'HTTP capture',
      'skills',
    ],
  },
  'cli.md': {
    agentSummary:
      'Reference for dynobox init and dynobox run commands, flags, output modes, JSON reports, exit codes, and harness requirements.',
    description:
      'Dynobox CLI command reference, including init, run, reporters, exit codes, and harness requirements.',
    topics: [
      'CLI',
      'dynobox init',
      'dynobox run',
      'JSON reporter',
      'exit codes',
    ],
  },
  'ci.md': {
    agentSummary:
      'Run Dynobox in CI, use harness matrices, write NDJSON reports, upload artifacts, and parse summary records.',
    description:
      'Run Dynobox in CI with quiet output, JSON reports, GitHub Actions, and artifact naming patterns.',
    topics: ['CI', 'GitHub Actions', 'JSON reports', 'artifacts'],
  },
};

export function getDocRoute(file: string): string {
  if (file === 'README.md') return '/';
  return `/${file.replace(/\.md$/, '')}/`;
}

export function getDocMarkdownRoute(file: string): string {
  if (file === 'README.md') return '/README.md';
  return `/${file}`;
}

export function getDocSlug(file: string): string {
  if (file === 'README.md') return '';
  return file.replace(/\.md$/, '');
}

export async function getAllDocs(): Promise<DocPage[]> {
  return Promise.all(docFiles.map((file) => getDoc(file)));
}

export async function getDoc(file: DocFile): Promise<DocPage> {
  const source = await readFile(path.join(docsRoot, file), 'utf8');
  const metadata = docMetadata[file];
  const title = extractTitle(source);
  const resolvedHighlighter = await highlighter;

  return {
    agentSummary: metadata.agentSummary,
    description: metadata.description,
    file,
    headings: extractHeadings(source),
    html: renderMarkdown(source, file, resolvedHighlighter),
    markdownRoute: getDocMarkdownRoute(file),
    route: getDocRoute(file),
    source,
    sourceUrl: `${githubSourceBase}/docs/${file}`,
    slug: getDocSlug(file),
    topics: metadata.topics,
    title,
  };
}

export async function getDocNav(): Promise<DocNavItem[]> {
  const docs = await getAllDocs();
  return docs.map(({route, title}) => ({route, title}));
}

export function getDocFileBySlug(slug: string | undefined): DocFile {
  const file = slug ? `${slug}.md` : 'README.md';

  if (!isDocFile(file)) {
    throw new Error(`Unknown docs slug: ${slug ?? '/'}`);
  }

  return file;
}

function isDocFile(file: string): file is DocFile {
  return docFiles.includes(file as DocFile);
}

function extractTitle(source: string): string {
  const title = source.match(/^#\s+(.+)$/m)?.[1]?.trim();

  if (!title) {
    throw new Error('Docs page is missing a top-level heading');
  }

  return title;
}

function extractHeadings(source: string): DocHeading[] {
  const headingCounts = new Map<string, number>();
  const headings: DocHeading[] = [];

  for (const match of source.matchAll(/^(#{1,3})\s+(.+)$/gm)) {
    const level = match[1]?.length;
    const title = match[2]?.trim();

    if (!level || !title) continue;

    const baseId = slugify(title);
    const count = headingCounts.get(baseId) ?? 0;
    headingCounts.set(baseId, count + 1);

    if (level === 2 || level === 3) {
      headings.push({
        id: count === 0 ? baseId : `${baseId}-${count}`,
        level,
        title: stripInlineMarkdown(title),
      });
    }
  }

  return headings;
}

function renderMarkdown(
  source: string,
  file: DocFile,
  highlighter: HighlighterCore,
): string {
  const headingCounts = new Map<string, number>();
  const config: Config = {
    nodes: {
      fence: {
        render: 'pre',
        attributes: {
          content: {type: String, required: true},
          language: {type: String},
        },
        transform(node) {
          const language = normalizeCodeLanguage(
            String(node.attributes.language ?? ''),
          );
          const highlighted = highlighter.codeToTokens(
            String(node.attributes.content),
            {
              lang: language,
              themes: {
                dark: 'github-dark',
                light: 'github-light',
              },
            },
          );
          const lines = highlighted.tokens.flatMap((line, index) => {
            const children: RenderableTreeNode[] = line.map((token) => {
              const style = styleObjectToString(token.htmlStyle);

              return new Markdoc.Tag('span', style ? {style} : {}, [
                token.content,
              ]);
            });

            return index === highlighted.tokens.length - 1
              ? children
              : [...children, '\n'];
          });

          return new Markdoc.Tag('pre', {class: `shiki language-${language}`}, [
            new Markdoc.Tag('code', {class: `language-${language}`}, lines),
          ]);
        },
      },
      heading: {
        children: ['inline'],
        attributes: {
          level: {type: Number, render: false, required: true},
        },
        transform(node, config) {
          const children = node.transformChildren(config);
          const level = Number(node.attributes.level);
          const text = getTextContent(children);
          const baseId = slugify(text);
          const count = headingCounts.get(baseId) ?? 0;
          headingCounts.set(baseId, count + 1);
          const id = count === 0 ? baseId : `${baseId}-${count}`;

          return new Markdoc.Tag(`h${level}`, {id}, [
            ...children,
            new Markdoc.Tag(
              'a',
              {
                'aria-label': `Copy link to ${text}`,
                class: 'heading-anchor',
                href: `#${id}`,
                title: 'Copy link to this section',
              },
              [
                new Markdoc.Tag(
                  'svg',
                  {
                    'aria-hidden': 'true',
                    class: 'heading-anchor-icon',
                    fill: 'none',
                    height: '16',
                    viewBox: '0 0 24 24',
                    width: '16',
                    xmlns: 'http://www.w3.org/2000/svg',
                  },
                  [
                    new Markdoc.Tag('path', {
                      d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.08l-1.72 1.71',
                      stroke: 'currentColor',
                      'stroke-linecap': 'round',
                      'stroke-linejoin': 'round',
                      'stroke-width': '2',
                    }),
                    new Markdoc.Tag('path', {
                      d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.08l1.71-1.71',
                      stroke: 'currentColor',
                      'stroke-linecap': 'round',
                      'stroke-linejoin': 'round',
                      'stroke-width': '2',
                    }),
                  ],
                ),
              ],
            ),
          ]);
        },
      },
      link: {
        render: 'a',
        children: ['strong', 'em', 's', 'code', 'text', 'tag'],
        attributes: {
          href: {type: String, required: true},
          title: {type: String},
        },
        transform(node, config) {
          const attributes = node.transformAttributes(config);
          const href = String(attributes.href);

          return new Markdoc.Tag(
            'a',
            {
              ...attributes,
              href: rewriteHref(href, file),
            },
            node.transformChildren(config),
          );
        },
      },
    },
  };

  const ast = Markdoc.parse(source);
  const errors = Markdoc.validate(ast, config).filter(
    (error) =>
      error.error.level === 'error' || error.error.level === 'critical',
  );

  if (errors.length > 0) {
    throw new Error(
      `Invalid Markdoc in ${file}: ${errors.map((error) => error.error.message).join(', ')}`,
    );
  }

  return Markdoc.renderers.html(Markdoc.transform(ast, config));
}

function rewriteHref(href: string, file: DocFile): string {
  if (isExternalHref(href) || href.startsWith('#') || href.startsWith('/')) {
    return href;
  }

  const [hrefPath = '', hash = ''] = href.split('#', 2);
  const resolvedPath = path
    .relative(repoRoot, path.resolve(docsRoot, path.dirname(file), hrefPath))
    .replaceAll(path.sep, '/');

  if (resolvedPath.startsWith('docs/') && resolvedPath.endsWith('.md')) {
    const targetFile = path.basename(resolvedPath);
    const route = getDocRoute(targetFile);
    return hash ? `${route}#${hash}` : route;
  }

  if (resolvedPath.startsWith('examples/')) {
    return `${githubSourceBase}/${resolvedPath}`;
  }

  return href;
}

function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

function normalizeCodeLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();

  if (!normalized) return 'text';
  if (normalized === 'js' || normalized === 'mjs') return 'javascript';
  if (normalized === 'ts' || normalized === 'mts') return 'typescript';
  if (normalized === 'yml') return 'yaml';
  if (normalized === 'sh' || normalized === 'shell') return 'shellscript';

  return normalized;
}

function styleObjectToString(
  style: Record<string, string> | undefined,
): string {
  if (style === undefined) return '';

  return Object.entries(style)
    .map(([property, value]) => `${property}:${value}`)
    .join(';');
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return slug || 'section';
}

function stripInlineMarkdown(value: string): string {
  return value.replace(/[`*_]/g, '');
}

function getTextContent(nodes: RenderableTreeNode[]): string {
  return nodes
    .map((node) => {
      if (typeof node === 'string' || typeof node === 'number') {
        return String(node);
      }

      if (
        node &&
        typeof node === 'object' &&
        'children' in node &&
        Array.isArray(node.children)
      ) {
        return getTextContent(node.children);
      }

      return '';
    })
    .join('');
}
