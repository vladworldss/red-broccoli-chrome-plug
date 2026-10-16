/**
 * The only thing the rest of the extension knows about language models.
 * Implementations: GeminiApiAdapter (BYOK cloud). A local Gemini Nano adapter
 * is the planned v2 addition and must fit this same port.
 */

/** OpenAPI-3 subset accepted by Gemini's `responseSchema`. */
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

export type LlmRequest = {
  system: string
  prompt: string
  schema: JsonSchema
  signal?: AbortSignal
}

export interface LlmPort {
  /** Part of the cache key: a different model must not reuse another's map. */
  readonly modelId: string
  /** Resolves to parsed JSON matching `schema` in shape; throws LlmError. */
  generateJson(req: LlmRequest): Promise<unknown>
}
