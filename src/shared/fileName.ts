/**
 * File-name helpers shared by every context. Pure.
 */

/**
 * A video title as a safe file-name stem: characters illegal in Windows/macOS
 * file names become spaces, whitespace collapses, and the result is capped at
 * 80 characters. Empty when nothing usable is left.
 */
export function safeFileStem(title: string): string {
  return title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim()
}
