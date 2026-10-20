import { useState } from 'react'

import type { Concept, ConceptTree as Tree, TreeNode } from '../../contexts/concept-mapping'
import type { ReferenceLink } from '../../contexts/references'
import { formatTimestamp } from '../../shared/time'

type LinksFor = (c: Concept) => ReferenceLink[]

type Props = {
  tree: Tree
  onSeek: (t: number) => void
  /** Where to read more about a concept; shown when its details are open. */
  linksFor?: LinksFor
}

/**
 * Collapsible reading tree. Term click → definition, plain-language summary
 * and reading links; timestamp chip → seek.
 */
export function ConceptTree({ tree, onSeek, linksFor }: Props) {
  return (
    <ul className="sh-tree">
      {tree.roots.map((n) => (
        <Item key={n.concept.id} node={n} depth={0} onSeek={onSeek} linksFor={linksFor} />
      ))}
    </ul>
  )
}

function Item({
  node,
  depth,
  onSeek,
  linksFor,
}: {
  node: TreeNode
  depth: number
  onSeek: (t: number) => void
  linksFor: LinksFor | undefined
}) {
  const c = node.concept
  const [open, setOpen] = useState(depth < 2)
  const [details, setDetails] = useState(false)
  const hasChildren = node.children.length > 0
  const weight = c.importance >= 0.75 ? 'sh-imp-high' : c.importance >= 0.45 ? 'sh-imp-mid' : ''

  return (
    <li className="sh-node">
      <div className="sh-node-row">
        <button
          className="sh-caret"
          aria-label={open ? 'Collapse' : 'Expand'}
          aria-expanded={hasChildren ? open : undefined}
          onClick={() => setOpen((v) => !v)}
          style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
        >
          {open ? '▼' : '▶'}
        </button>
        <button
          className={`sh-term ${weight}`}
          aria-expanded={details}
          onClick={() => setDetails((v) => !v)}
          title={c.definition}
        >
          {c.term}
        </button>
        {c.t !== null && (
          <button className="sh-ts" onClick={() => onSeek(c.t!)} title="Jump to this moment">
            {formatTimestamp(c.t)}
          </button>
        )}
      </div>

      {details && (
        <div className="sh-details">
          {c.definition || <em>No definition.</em>}
          {c.summary && (
            <p className="sh-plain">
              <strong>In plain words:</strong> {c.summary}
            </p>
          )}
          {(node.requires.length > 0 || c.aliases.length > 0) && (
            <div className="sh-tags">
              {node.requires.map((r) => (
                <span key={r.id} className="sh-tag" title="Learn this first">
                  needs: {r.term}
                </span>
              ))}
              {c.aliases.map((a) => (
                <span key={a} className="sh-tag" title="Also called">
                  {a}
                </span>
              ))}
            </div>
          )}
          {linksFor && <ReadingLinks links={linksFor(c)} />}
        </div>
      )}

      {hasChildren && open && (
        <ul>
          {node.children.map((ch) => (
            <Item key={ch.concept.id} node={ch} depth={depth + 1} onSeek={onSeek} linksFor={linksFor} />
          ))}
        </ul>
      )}
    </li>
  )
}

function ReadingLinks({ links }: { links: ReferenceLink[] }) {
  if (links.length === 0) return null
  return (
    <div className="sh-links">
      <span>Read more:</span>
      {links.map((l) => (
        <a key={l.url} href={l.url} target="_blank" rel="noreferrer" title={`${l.source}: ${l.query}`}>
          {l.source}
        </a>
      ))}
    </div>
  )
}
