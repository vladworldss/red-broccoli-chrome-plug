import type { JsonSchema } from './JsonSchema'

/**
 * Our schemas are written once, in Gemini's OpenAPI dialect. OpenAI-compatible
 * providers want standard JSON Schema — and strict mode adds rules: every
 * property listed in `required`, `additionalProperties: false` on every
 * object, and nullability as a type union instead of `nullable: true`.
 */
export function toStandardJsonSchema(s: JsonSchema): Record<string, unknown> {
  const base = s.type.toLowerCase()
  const out: Record<string, unknown> = { type: s.nullable ? [base, 'null'] : base }
  if (s.description) out.description = s.description
  if (s.enum) out.enum = s.nullable ? [...s.enum, null] : [...s.enum]
  if (s.items) out.items = toStandardJsonSchema(s.items)
  if (s.properties) {
    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(s.properties)) props[k] = toStandardJsonSchema(v)
    out.properties = props
    out.required = Object.keys(s.properties)
    out.additionalProperties = false
  }
  return out
}

/**
 * The schema as compact JSON, for providers that only get it in the prompt
 * (json-object / prompt modes). Same conversion, so all providers are told
 * the same shape.
 */
export function schemaForPrompt(s: JsonSchema): string {
  return JSON.stringify(toStandardJsonSchema(s))
}
