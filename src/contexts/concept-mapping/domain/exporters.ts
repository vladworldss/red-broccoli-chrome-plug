import { formatTimestamp } from '../../../shared/time'
import type { ConceptMap } from './ConceptMap'
import { walkTree, type ConceptTree } from './tree'

export type ExportOptions = {
  /**
   * Builds a link for a timestamp. Injected because this context knows nothing
   * about where the video lives (YouTube is the video-capture context's business).
   */
  linkFor?: (t: number) => string
}

/**
 * Nested Markdown list, one bullet per concept:
 *   - **Derivative** [12:14](…) — rate of change… _(requires: Limit, Function)_
 * Pastes cleanly into Obsidian/Notion and is also the "Copy" format.
 */
export function toMarkdown(map: ConceptMap, tree: ConceptTree, opts: ExportOptions = {}): string {
  const lines: string[] = [`# ${escapeMd(tree.topic || map.title)}`, '']
  if (map.title && map.title !== tree.topic) lines.push(`_Source: ${escapeMd(map.title)}_`, '')

  walkTree(tree, (node, depth) => {
    const c = node.concept
    let line = `${'  '.repeat(depth)}- **${escapeMd(c.term)}**`
    if (c.t !== null) {
      const ts = formatTimestamp(c.t)
      line += opts.linkFor ? ` [${ts}](${opts.linkFor(c.t)})` : ` [${ts}]`
    }
    if (c.definition) line += ` — ${escapeMd(c.definition)}`
    if (node.requires.length) {
      line += ` _(requires: ${node.requires.map((r) => escapeMd(r.term)).join(', ')})_`
    }
    lines.push(line)
  })

  return lines.join('\n') + '\n'
}

/**
 * Mermaid flowchart of the full DAG (not just the tree):
 *   parent --> child              for part-of
 *   x -.->|requires| prereq       for requires (reads "x requires prereq")
 * Node ids are positional (n0, n1, …) so no term can break the syntax; labels
 * are quoted with `"` escaped as Mermaid's `#quot;`.
 */
export function toMermaid(map: ConceptMap): string {
  const idOf = new Map(map.concepts.map((c, i) => [c.id, `n${i}`]))
  const lines = ['graph TD']
  for (const c of map.concepts) {
    const label = c.term.replace(/"/g, '#quot;').replace(/[\r\n]+/g, ' ')
    lines.push(`  ${idOf.get(c.id)}["${label}"]`)
  }
  for (const r of map.relations) {
    const from = idOf.get(r.from)
    const to = idOf.get(r.to)
    if (!from || !to) continue
    lines.push(r.type === 'part-of' ? `  ${to} --> ${from}` : `  ${from} -.->|requires| ${to}`)
  }
  return lines.join('\n') + '\n'
}

function escapeMd(s: string): string {
  return s.replace(/([\\`*_[\]<>])/g, '\\$1')
}
