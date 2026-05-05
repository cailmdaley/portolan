export interface CanonicalFiberRef {
  host: string;
  fiberId: string;
}

/**
 * Derive a fiber's canonical-store id from its realpath'd md file path.
 * Walks up to the nearest enclosing `.felt/` directory and returns the
 * fiber-shaped id within that store — i.e. the same id `felt ls` reports
 * when run from inside the canonical store. Returns undefined when the
 * path doesn't sit under a `.felt/` directory or has an unexpected
 * `<slug>/<slug>.md` shape.
 */
export function canonicalStoreRelativeId(canonicalPath: string): string | undefined {
  const segments = canonicalPath.split('/');
  const feltIdx = segments.lastIndexOf('.felt');
  if (feltIdx === -1) return undefined;
  const tail = segments.slice(feltIdx + 1);
  if (tail.length === 0) return undefined;
  const file = tail[tail.length - 1];
  if (!file.endsWith('.md')) return undefined;
  const slug = file.slice(0, -'.md'.length);
  if (tail.length === 1) return slug;
  const parent = tail[tail.length - 2];
  if (parent !== slug) return undefined;
  return tail.slice(0, -1).join('/');
}

/**
 * Canonical `(felt host, fiber id)` pair for a realpath'd markdown file.
 * The host is the directory containing the owning `.felt/` root.
 */
export function canonicalFiberRefFromPath(canonicalPath: string): CanonicalFiberRef | undefined {
  const segments = canonicalPath.split('/');
  const feltIdx = segments.lastIndexOf('.felt');
  const fiberId = canonicalStoreRelativeId(canonicalPath);
  if (feltIdx === -1 || fiberId === undefined) return undefined;
  return {
    host: segments.slice(0, feltIdx).join('/') || '/',
    fiberId,
  };
}
