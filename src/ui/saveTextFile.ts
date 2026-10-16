/**
 * Saves text as a file on the user's machine through an `<a download>` click.
 * Works from extension pages without the `downloads` permission, so the
 * manifest (and the store guard) stay unchanged.
 */
export function saveTextFile(filename: string, text: string, mime: string, opts: { bom?: boolean } = {}): void {
  // A UTF-8 BOM makes older subtitle players read non-Latin text correctly.
  const blob = new Blob([opts.bom ? '﻿' : '', text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking immediately can cancel the download in some Chrome versions.
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
