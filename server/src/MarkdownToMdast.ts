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
import remarkFrontmatter from 'remark-frontmatter';
import remarkMath from 'remark-math';
import katex from 'katex';
import { parse as parseYaml } from 'yaml';

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

function remarkKatexHtml() {
  return (tree: any) => {
    attachKatexHtml(tree);
  };
}

function attachKatexHtml(node: any): void {
  if (!node || typeof node !== 'object') return;
  if (
    (node.type === 'math' || node.type === 'inlineMath') &&
    typeof node.value === 'string'
  ) {
    node.html = katex.renderToString(node.value, {
      displayMode: node.type === 'math',
      throwOnError: false,
      output: 'html',
    });
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) attachKatexHtml(child);
  }
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

/**
 * Pull a YAML frontmatter object out of the leading `---\n…\n---` block of a
 * markdown source string. Returns `undefined` when the document has no
 * frontmatter or when the block is malformed; callers treat both the same way
 * (no fiber header rendered).
 *
 * Kept separate from `markdownToMdast` so callers that just need the
 * frontmatter (e.g. for a client-side fiber-shape detection in a non-render
 * context) don't pay for a full mdast parse.
 */
export function extractFrontmatter(content: string): Record<string, unknown> | undefined {
  if (!content.startsWith('---')) return undefined;
  // Allow `---\n` or `---\r\n` opener; require a closing `---` on its own line.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  const yamlText = match[1];
  if (!yamlText.trim()) return undefined;
  const parsed = parseYaml(yamlText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

export function markdownToMdast(content: string): unknown {
  const processor = unified()
    .use(remarkParse)
    // YAML frontmatter support — without this, a leading `---\n…\n---` block
    // is misparsed as a setext-heading underline plus a thematic break, and
    // the keys leak into the rendered prose. With it, frontmatter ends up as
    // a single `yaml` node at the top of mdast.children which PretextProse
    // hides (same way mystra hides it server-side for fiber bodies).
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkMath)
    .use(remarkGfm)
    .use(remarkStripMystTargets)
    .use(remarkWikiLinks)
    .use(remarkKatexHtml);
  const tree = processor.parse(content);
  return processor.runSync(tree);
}
