/**
 * OpenAPI-3 subset accepted by Gemini's `responseSchema`. Prompts define their
 * output shapes once in this dialect; `toStandardJsonSchema` converts it for
 * OpenAI-compatible providers.
 */
export type JsonSchema = {
  type: 'OBJECT' | 'ARRAY' | 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN'
  description?: string
  nullable?: boolean
  enum?: string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  propertyOrdering?: string[]
  items?: JsonSchema
}
