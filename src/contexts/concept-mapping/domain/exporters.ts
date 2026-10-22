import { safeFileStem } from '../../../shared/fileName'
import { formatTimestamp } from '../../../shared/time'
import type { Concept } from './Concept'
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

export type NotesOptions = {
  /** Seek link for a timestamp (injected: this context doesn't know YouTube). */
  linkFor?: (t: number) => string
  /** The video itself, for the meta table. */
  videoUrl?: string
  /** "Where to read more" for a concept (injected from the references context). */
  linksFor?: (c: Concept) => readonly { source: string; query: string; url: string }[]
  /** Already formatted by the UI, which owns time zones, model labels and the version. */
  meta: { exportedAt: string; builtAt: string; modelLabel: string; appVersion: string }
}

/**
 * Lecture notes as a Markdown document: one chapter per tree node, nested
 * as the tree is, in order of the video.
 *
 *   ## [12:14](…) Derivative
 *   How fast something changes at one instant — like a speedometer reading.
 *
 *   **Needs:** Limit
 *
 *   **For self-study:**
 *   - [Wikipedia: Derivative](…)
 *
 * The chapter text is the concept's plain-language `summary`; maps built
 * before prompt p2 have none and use the one-line definition instead.
 * Nothing here calls a model: the file is rebuilt from the cached map on
 * every download, so its "Exported" line is always current.
 */
export function toLectureNotes(map: ConceptMap, tree: ConceptTree, opts: NotesOptions): string {
  const title = map.title || tree.topic || 'Lecture'
  const cell = (s: string) => escapeMd(s).replace(/\|/g, '\\|')
  const rows: [string, string][] = [
    ['Video', opts.videoUrl ? `[${cell(title)}](${opts.videoUrl})` : cell(title)],
    ...(tree.topic ? ([['Topic', cell(tree.topic)]] as [string, string][]) : []),
    ['Exported', cell(opts.meta.exportedAt)],
    ['Map built', cell(opts.meta.builtAt)],
    ['Model', cell(opts.meta.modelLabel)],
    ['Made with', `RedBroccoli ${cell(opts.meta.appVersion)}`],
  ]
  const lines: string[] = [`# ${escapeMd(title)}`, '', '| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)]

  walkTree(tree, (node, depth) => {
    const c = node.concept
    // Markdown has six heading levels; deeper chapters stay at the last one.
    let heading = `${'#'.repeat(Math.min(depth + 2, 6))} `
    if (c.t !== null) {
      const ts = formatTimestamp(c.t)
      heading += opts.linkFor ? `[${ts}](${opts.linkFor(c.t)}) ` : `[${ts}] `
    }
    lines.push('', heading + escapeMd(c.term))

    const text = c.summary || c.definition
    if (text) lines.push('', escapeMd(text))
    if (node.requires.length) lines.push('', `**Needs:** ${node.requires.map((r) => escapeMd(r.term)).join(', ')}`)

    const links = opts.linksFor?.(c) ?? []
    if (links.length) {
      lines.push('', '**For self-study:**')
      for (const l of links) lines.push(`- [${escapeMd(`${l.source}: ${l.query}`)}](${l.url})`)
    }
  })

  return lines.join('\n') + '\n'
}

/** "1. Algorithms and Computation-lecture.md"; the video id when the title is unusable. */
export function notesFileName(title: string, videoId: string): string {
  return `${safeFileStem(title) || videoId}-lecture.md`
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
