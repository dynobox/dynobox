/**
 * Slugifies a name into a stable, lowercase, hyphenated identifier.
 *
 * @param input The string to slugify.
 * @returns A slug safe for use in stable IDs. Empty inputs become `'unnamed'`.
 */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'unnamed';
}

/**
 * Returns a slug uniquified against the set of slugs already taken,
 * mutating the set to record the new entry.
 *
 * @param slug The candidate slug.
 * @param taken The set of slugs already in use.
 * @returns A unique slug, with `-2`, `-3`, ... suffixes on collision.
 */
export function uniquify(slug: string, taken: Set<string>): string {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  while (taken.has(`${slug}-${n}`)) n += 1;
  const next = `${slug}-${n}`;
  taken.add(next);
  return next;
}
