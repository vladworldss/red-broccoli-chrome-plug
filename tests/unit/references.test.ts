import { describe, expect, it } from 'vitest'

import { referenceLinks } from '../../src/contexts/references'

const sources = (links: ReturnType<typeof referenceLinks>) => links.map((l) => l.source)

describe('referenceLinks', () => {
  it('always: Wikipedia (straight to the article) and a YouTube explainer, by the exact English title', () => {
    const links = referenceLinks({ term: 'Big O', refTitle: 'Big O notation', lang: 'en' })
    expect(links).toEqual([
      {
        source: 'Wikipedia',
        query: 'Big O notation',
        url: 'https://en.wikipedia.org/wiki/Special:Search?search=Big%20O%20notation&go=Go',
      },
      {
        source: 'YouTube',
        query: 'Big O notation explained',
        url: 'https://www.youtube.com/results?search_query=Big%20O%20notation%20explained',
      },
    ])
  })

  it('sources depend on the subject', () => {
    expect(sources(referenceLinks({ term: 'Derivative', field: 'math' }))).toEqual([
      'Wikipedia',
      'YouTube',
      'Khan Academy',
      'MathWorld',
    ])
    expect(sources(referenceLinks({ term: 'Heap', field: 'cs' }))).toEqual([
      'Wikipedia',
      'YouTube',
      'GeeksforGeeks',
      'CS StackExchange',
    ])
    expect(sources(referenceLinks({ term: 'Entropy', field: 'physics' }))).toEqual(['Wikipedia', 'YouTube', 'Khan Academy'])
    expect(sources(referenceLinks({ term: 'Inflation', field: 'economics' }))).toEqual([
      'Wikipedia',
      'YouTube',
      'Khan Academy',
      'Investopedia',
    ])
    expect(sources(referenceLinks({ term: 'Meme', field: 'other' }))).toEqual(['Wikipedia', 'YouTube'])
  })

  it('every URL is a fixed template with the words encoded: C++, f\'(x), &, Cyrillic', () => {
    for (const term of ['C++', "f'(x)", 'A & B', 'Производная']) {
      for (const l of referenceLinks({ term, field: 'math' })) {
        expect(l.url).toMatch(/^https:\/\/(en\.wikipedia\.org|www\.youtube\.com|www\.khanacademy\.org|mathworld\.wolfram\.com)\//)
        expect(l.url).not.toMatch(/\s/)
        // The words round-trip through a query parameter (outside Wikipedia, without brackets).
        const words = term.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()
        const values = [...new URL(l.url).searchParams.values()]
        expect(values.some((v) => v.includes(l.source === 'Wikipedia' ? term : words))).toBe(true)
      }
    }
    const cpp = referenceLinks({ term: 'C++' })[0]!
    expect(new URL(cpp.url).searchParams.get('search')).toBe('C++')
  })

  it('Wikipedia keeps the exact "(qualifier)" title, encoded so it can sit inside a Markdown link; other sources drop the brackets', () => {
    const [wiki, yt, gfg] = referenceLinks({ term: 'Predicate', refTitle: 'Predicate (mathematical logic)', field: 'cs' })
    expect(wiki!.url).toBe('https://en.wikipedia.org/wiki/Special:Search?search=Predicate%20%28mathematical%20logic%29&go=Go')
    expect(new URL(wiki!.url).searchParams.get('search')).toBe('Predicate (mathematical logic)')
    expect(yt!.query).toBe('Predicate mathematical logic explained')
    expect(gfg!.query).toBe('Predicate mathematical logic')
    for (const l of referenceLinks({ term: "f'(x)!*", field: 'cs' })) expect(l.url).not.toMatch(/[()'!*]/)
  })

  it('a map in another language also gets that Wikipedia, searched by the term as shown', () => {
    const links = referenceLinks({ term: 'Производная', refTitle: 'Derivative', lang: 'ru-RU', field: 'math' })
    expect(links[0]!.url).toContain('en.wikipedia.org/wiki/Special:Search?search=Derivative')
    expect(links[1]).toEqual({
      source: 'Wikipedia (ru)',
      query: 'Производная',
      url: `https://ru.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent('Производная')}&go=Go`,
    })
    // Unknown or junk language: no local link.
    expect(sources(referenceLinks({ term: 'X', lang: 'und' }))).toEqual(['Wikipedia', 'YouTube'])
    expect(sources(referenceLinks({ term: 'X', lang: 'evil.com/' }))).toEqual(['Wikipedia', 'YouTube'])
  })

  it('without refTitle the term is the search; an empty term gives no links', () => {
    expect(referenceLinks({ term: ' Limit ' })[0]!.query).toBe('Limit')
    expect(referenceLinks({ term: 'Limit', refTitle: '  ' })[0]!.query).toBe('Limit')
    expect(referenceLinks({ term: '  ' })).toEqual([])
  })
})
