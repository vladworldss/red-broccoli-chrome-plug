# DESIGN.md

The visual system for RedBroccoli's extension pages (side panel and
Settings). Product principles are in [PRODUCT.md](PRODUCT.md). All styles
live in [src/ui/styles.css](src/ui/styles.css). Plain CSS with `sh-` classes
(a legacy StudHelper prefix that stays), no Tailwind or CSS-in-JS.

## Tokens

Defined on `:root` and redefined under `prefers-color-scheme: dark`. Use the
token, never a raw color.

| Token | Use |
| --- | --- |
| `--bg`, `--bg-soft` | Page; raised or open surfaces (an expanded provider) |
| `--fg`, `--muted` | Primary text; every secondary text (hints, labels' asides, quiet links) |
| `--border` | Hairlines, inactive status dot |
| `--accent`, `--accent-soft` | Primary buttons, focus, link hover. Not for resting secondary links |
| `--ok`, `--warn`, `--danger` | Ready; needs the user (key missing, needs access); failed |
| `--chip` | Ghost-button hover, tags |
| `--radius` | 8px on cards, inputs, buttons |

## Type scale

System font stack, 13px/1.45 body.

| Size | Weight | Use |
| --- | --- | --- |
| 20 | 600 | Page title (Settings) |
| 15 | 600 | Section heading |
| 14 | 600 | Provider name: the thing the eye scans for |
| 13 | 400 | Body, inputs, buttons |
| 12 | 400–600 | Hints (`.sh-hint`, muted), field labels (600), status, save state |

Secondary links ("Get a key ↗") use `.sh-quiet-link`: 12px, muted, accent
only on hover, so they never compete with the field or the Test button.

## Settings page

- **Width** 640px max, 16px side padding. Sections are separated by 28px, no
  rules. The version footer is the only bordered section.
- **Provider list** is one bordered list with hairline dividers, not a stack
  of cards.
  - Collapsed row (min 44px): checkbox · name + chevron (the expand button) ·
    save state · readiness · ↑↓.
  - Expanded row: `--bg-soft` background, body indented to the name (36px),
    12px gaps. It holds the note (`.sh-hint`), the API key, the model
    (marked "optional") and Test with its result.
- **Readiness** (`.sh-readiness-*`): a 7px dot and one word, colored ok /
  warn / muted. Never a pill or a badge.
- **Save state** (`SaveIndicator`): 12px muted "Saving…" / "Saved", shown
  only next to what changed. "Saved" clears after 2s. Errors stay, in
  `--danger`, with Retry.
- **Key field**: `.sh-input-group`, with Show/Hide as a ghost button inside
  the input's border. The focus ring is on the group.
- **Buttons**: `.sh-btn` for actions (Test, Clear cache); `.sh-btn-ghost` for
  in-row utilities (↑↓, Show), borderless and muted until hover;
  `.sh-btn-primary` is for the side panel's main action, not Settings.
  Settings has no primary action: it saves by itself.

## Interaction rules

- Text fields save 400ms after typing stops, and at once on blur, tab hide
  and `pagehide`. Toggles, reorder and selects save at once.
- A host-permission prompt runs first in a click handler (Test). An `await`
  before it can spend the user gesture.
- Collapsible rows use a real `<button aria-expanded aria-controls>`. The
  checkbox stays outside it: no nested interactive controls.
