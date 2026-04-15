/**
 * Parse markdown body to an mdast tree suitable for vellum's FiberContent.
 *
 * Mirrors mystra/src/transform/render-markdown.ts — the same remark stack plus
 * a small [[wikilink]] plugin so portolan fiber cross-references render as
 * clickable links in the vellum reader. Kept in-repo (rather than importing
 * mystra) because portolan fibers don't need the full ASTRA transform; plain
 * markdown + wikilinks is the whole surface area.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]*?))?\]\]/g;

// MyST target: `(label)=` on its own line. Remark parses it as a paragraph
// with a single text child. Strip these so they don't render as literal
// `(label)=` artifacts in card bodies.
const MYST_TARGET_RE = /^\(([^\s()]+)\)=\s*$/;

function remarkStripMystTargets() {
  return (tree: any) => {
    if (!Array.isArray(tree.children)) return;
    tree.children = tree.children.filter((node: any) => {
      if (node.type !== 'paragraph') return true;
      if (!Array.isArray(node.children) || node.children.length !== 1) return true;
      const only = node.children[0];
      if (only?.type !== 'text' || typeof only.value !== 'string') return true;
      return !MYST_TARGET_RE.test(only.value);
    });
  };
}

function remarkWikiLinks() {
  return (tree: any) => {
    transformNode(tree);
  };
}

function transformNode(node: any): void {
  if (!Array.isArray(node.children)) return;

  const newChildren: any[] = [];
  let changed = false;

  for (const child of node.children) {
    if (child.type === 'text' && WIKILINK_RE.test(child.value)) {
      changed = true;
      newChildren.push(...splitTextNode(child.value));
    } else {
      transformNode(child);
      newChildren.push(child);
    }
  }

  if (changed) {
    node.children = newChildren;
  }
}

function splitTextNode(value: string): any[] {
  const nodes: any[] = [];
  WIKILINK_RE.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = WIKILINK_RE.exec(value)) !== null) {
    const [full, slug, label] = match;
    const start = match.index;

    if (start > lastIndex) {
      nodes.push({ type: 'text', value: value.slice(lastIndex, start) });
    }

    const displayText = (label ?? slug).trim() || slug;
    nodes.push({
      type: 'link',
      url: `/${slug.trim()}`,
      children: [{ type: 'text', value: displayText }],
    });

    lastIndex = start + full.length;
  }

  if (lastIndex < value.length) {
    nodes.push({ type: 'text', value: value.slice(lastIndex) });
  }

  return nodes;
}

export function markdownToMdast(content: string): unknown {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkStripMystTargets)
    .use(remarkWikiLinks);
  const tree = processor.parse(content);
  return processor.runSync(tree);
}
