import { describe, expect, it } from 'vitest'

import type { ConceptTree } from '../../src/contexts/concept-mapping'
import { escapeHtml, toMarkmapData } from '../../src/ui/sidepanel/markmapData'

describe('toMarkmapData', () => {
  const tree: ConceptTree = {
    topic: 'Calc <b>',
    roots: [
      {
        concept: { id: 'x', term: '<img src=x onerror=alert(1)>', definition: '', aliases: [], t: 734, importance: 1 },
        requires: [],
        children: [
          {
            concept: { id: 'y', term: 'Plain', definition: '', aliases: [], t: null, importance: 0.5 },
            requires: [],
            children: [],
          },
        ],
      },
    ],
  }

  it('escapes all LLM text (markmap renders content as HTML)', () => {
    const data = toMarkmapData(tree)
    expect(data.content).toBe('<strong>Calc &lt;b&gt;</strong>')
    const node = data.children[0]!
    expect(node.content).not.toContain('<img')
    expect(node.content).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('adds seekable timestamp links only where t is known', () => {
    const node = toMarkmapData(tree).children[0]!
    expect(node.content).toContain('<a href="#" data-t="734">12:14</a>')
    expect(node.children[0]!.content).toBe('<strong>Plain</strong>')
  })

  it('escapeHtml covers quotes too', () => {
    expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;')
  })
})
