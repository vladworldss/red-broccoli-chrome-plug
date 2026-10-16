import { Markmap } from 'markmap-view'
import { useEffect, useMemo, useRef } from 'react'

import type { ConceptTree } from '../../contexts/concept-mapping'
import { toMarkmapData } from './markmapData'

type Props = {
  tree: ConceptTree
  onSeek: (t: number) => void
}

/** Same tree as the list view, drawn as a zoomable mind map (markmap). */
export function MindMap({ tree, onSeek }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const mmRef = useRef<Markmap | null>(null)
  const data = useMemo(() => toMarkmapData(tree), [tree])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const mm = Markmap.create(svg, { autoFit: true, initialExpandLevel: 3, duration: 300 })
    mmRef.current = mm
    return () => {
      mm.destroy()
      mmRef.current = null
    }
  }, [])

  useEffect(() => {
    const mm = mmRef.current
    if (!mm) return
    void mm.setData(data).then(() => mm.fit())
  }, [data])

  // Timestamp links live inside markmap's foreignObjects; one delegated
  // listener catches them all and keeps markmap from treating it as a toggle.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[data-t]')
      if (!a) return
      e.preventDefault()
      e.stopPropagation()
      const t = Number(a.getAttribute('data-t'))
      if (Number.isFinite(t)) onSeek(t)
    }
    svg.addEventListener('click', onClick, true)
    return () => svg.removeEventListener('click', onClick, true)
  }, [onSeek])

  return <svg ref={svgRef} className="sh-mindmap" />
}
