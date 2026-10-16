import type { ConceptTree, TreeNode } from '../../contexts/concept-mapping'
import { formatTimestamp } from '../../shared/time'

/** Structural twin of markmap-common's IPureNode — no import needed. */
export type MarkmapNode = {
  content: string
  children: MarkmapNode[]
  payload?: { fold?: number }
}

/**
 * ConceptTree → markmap data. markmap renders `content` as raw HTML inside a
 * foreignObject, so EVERY piece of LLM-produced text is escaped here — a term
 * like "<img onerror=…>" must render as text, never as markup.
 *
 * Timestamps become `<a data-t="734">12:14</a>`; MindMap.tsx intercepts clicks
 * on them and seeks the video.
 */
export function toMarkmapData(tree: ConceptTree): MarkmapNode {
  const node = (n: TreeNode): MarkmapNode => {
    const c = n.concept
    let content = `<strong>${escapeHtml(c.term)}</strong>`
    if (c.t !== null) content += ` <a href="#" data-t="${Math.floor(c.t)}">${formatTimestamp(c.t)}</a>`
    return { content, children: n.children.map(node) }
  }
  return { content: `<strong>${escapeHtml(tree.topic)}</strong>`, children: tree.roots.map(node) }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
