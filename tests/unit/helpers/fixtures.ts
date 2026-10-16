import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function fixture(name: string): string {
  return readFileSync(resolve(__dirname, '../../fixtures', name), 'utf8')
}
