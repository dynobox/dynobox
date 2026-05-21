import {readFile} from 'node:fs/promises';
import path from 'node:path';

import Markdoc, {type Config, type RenderableTreeNode} from '@markdoc/markdoc';

const repoRoot = path.resolve(process.cwd(), '../..');
const docsRoot = path.join(repoRoot, 'docs');
const githubSourceBase = 'https://github.com/dynobox/dynobox/blob/main';

const docFiles = [
  'README.md',
  'getting-started.md',
  'config-authoring.md',
  'cli.md',
  'ci.md',
] as const;

export type DocFile = (typeof docFiles)[number];

export type DocPage = {
  file: DocFile;
  headings: DocHeading[];
  html: string;
  route: string;
  slug: string;
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

export function getDocRoute(file: string): string {
  if (file === 'README.md') return '/';
  return `/${file.replace(/\.md$/, '')}/`;
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
  const title = extractTitle(source);

  return {
    file,
    headings: extractHeadings(source),
    html: renderMarkdown(source, file),
    route: getDocRoute(file),
    slug: getDocSlug(file),
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

function renderMarkdown(source: string, file: DocFile): string {
  const headingCounts = new Map<string, number>();
  const config: Config = {
    nodes: {
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

          return new Markdoc.Tag(
            `h${level}`,
            {id: count === 0 ? baseId : `${baseId}-${count}`},
            children,
          );
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
