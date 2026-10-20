/**
 * "Where to read more" about a concept, as links. Built ONLY from fixed URL
 * templates plus `encodeURIComponent` — never from a URL the model wrote — so
 * a link can't be invented, broken by odd characters, or point anywhere else.
 * The model contributes only the search words (the term and its exact
 * Wikipedia title) and the lecture's subject.
 *
 * Search URLs verified 2026-10-20: Wikipedia `Special:Search…&go=Go` redirects
 * straight to an exactly-titled article (en and ru); Khan Academy, MathWorld,
 * GeeksforGeeks and CS StackExchange search pages answer 200. Investopedia's
 * own search refuses non-browser clients, so it goes through Google `site:`.
 */

export type ReferenceLink = {
  /** Source name: "Wikipedia", "Khan Academy", … */
  source: string
  /** What the link searches for, for link text: "Big O notation". */
  query: string
  url: string
}

export type ReferenceInput = {
  /** The concept as shown in the map (in the map's language). */
  term: string
  /** Exact English Wikipedia title from the model, when it gave one. */
  refTitle?: string | undefined
  /** The lecture's subject: math, cs, physics, chemistry, biology, economics, other. */
  field?: string | undefined
  /** Language code of the map's terms ("en", "ru"…); "und" or empty when unknown. */
  lang?: string | undefined
}

/**
 * `encodeURIComponent` plus the characters it leaves alone but Markdown and
 * some chat apps treat as link syntax — "Predicate (mathematical logic)" must
 * not end a `[text](url)` link at its first ")".
 */
const q = (s: string) => encodeURIComponent(s).replace(/[()'!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

export function referenceLinks(input: ReferenceInput): ReferenceLink[] {
  const term = input.term.trim()
  if (!term) return []
  const english = input.refTitle?.trim() || term
  // Wikipedia needs the exact title, qualifier and all, to land on the article;
  // every other search reads better without the brackets: "Predicate mathematical logic".
  const words = english.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()
  const lang = normalizeLang(input.lang)
  const links: ReferenceLink[] = [
    { source: 'Wikipedia', query: english, url: `https://en.wikipedia.org/wiki/Special:Search?search=${q(english)}&go=Go` },
  ]
  // A map in another language also gets that language's Wikipedia, searched by
  // the term as the student reads it.
  if (lang && lang !== 'en') {
    links.push({
      source: `Wikipedia (${lang})`,
      query: term,
      url: `https://${lang}.wikipedia.org/wiki/Special:Search?search=${q(term)}&go=Go`,
    })
  }
  const video = `${words} explained`
  links.push({ source: 'YouTube', query: video, url: `https://www.youtube.com/results?search_query=${q(video)}` })

  const khan = { source: 'Khan Academy', query: words, url: `https://www.khanacademy.org/search?page_search_query=${q(words)}` }
  switch (input.field) {
    case 'math':
      links.push(khan, { source: 'MathWorld', query: words, url: `https://mathworld.wolfram.com/search/?query=${q(words)}` })
      break
    case 'physics':
    case 'chemistry':
    case 'biology':
      links.push(khan)
      break
    case 'cs':
      links.push(
        { source: 'GeeksforGeeks', query: words, url: `https://www.geeksforgeeks.org/search/?gq=${q(words)}` },
        { source: 'CS StackExchange', query: words, url: `https://cs.stackexchange.com/search?q=${q(words)}` },
      )
      break
    case 'economics':
      links.push(khan, {
        source: 'Investopedia',
        query: words,
        url: `https://www.google.com/search?q=${q(`site:investopedia.com ${words}`)}`,
      })
      break
  }
  return links
}

/** "ru-RU" → "ru"; anything that isn't a plain language code → "" (no local link). */
function normalizeLang(lang: string | undefined): string {
  const base = (lang ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return /^[a-z]{2,3}$/.test(base) && base !== 'und' ? base : ''
}
