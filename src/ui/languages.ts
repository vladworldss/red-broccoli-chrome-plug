/**
 * The "Map language" choices in Settings, with their language codes. The
 * names go into the prompt as-is; the codes pick the local Wikipedia for
 * reading links.
 */
const CODES: Record<string, string> = {
  English: 'en',
  Russian: 'ru',
  Ukrainian: 'uk',
  German: 'de',
  French: 'fr',
  Spanish: 'es',
  Portuguese: 'pt',
  Chinese: 'zh',
}

/** "auto" = the lecture's own language. */
export const LANGUAGES = ['auto', ...Object.keys(CODES)]

/**
 * Language code of a map's terms: the chosen map language, or for "auto"
 * (and maps from before 0.5.0) the transcript's language.
 */
export function termsLang(map: { lang: string; outputLanguage?: string }): string {
  const chosen = map.outputLanguage && map.outputLanguage !== 'auto' ? CODES[map.outputLanguage] : undefined
  return chosen ?? map.lang
}
