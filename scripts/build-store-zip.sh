#!/usr/bin/env bash
# Build a Chrome Web Store submission zip from a clean production build.
# (Ported from chrome_ai_plug; assertions adapted to StudHelper's manifest.)
#
# The zip is created FROM build/chrome-mv3-prod only, so dev artifacts
# (.git, node_modules, tests, docs, sources, .env*) can never leak into it.
# Output: dist/studhelper-v<version>.zip
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT/build/chrome-mv3-prod"
DIST_DIR="$ROOT/dist"

cd "$ROOT"

echo "==> Production build (plasmo, hermetic env)"
# .env.local holds the developer's personal Gemini key for `make smoke-live`.
# Plasmo only inlines PLASMO_PUBLIC_* vars, but the package must not depend on
# that: stash every .env* (except the committed template) for the build and
# restore afterwards. Their VALUES are remembered first so the output can be
# scanned for them below.
STASH_DIR="$(mktemp -d)"
SECRETS_FILE="$(mktemp)"
restore_env() {
  find "$STASH_DIR" -maxdepth 1 -name '.env*' -exec mv {} "$ROOT/" \; 2>/dev/null || true
  rmdir "$STASH_DIR" 2>/dev/null || true
  rm -f "$SECRETS_FILE"
}
trap restore_env EXIT
for f in "$ROOT"/.env*; do
  [[ -e "$f" ]] || continue
  [[ "$(basename "$f")" == ".env.example" ]] && continue
  # KEY=VALUE → VALUE (quotes/whitespace stripped); keep only secret-length values.
  # (awk 1 re-terminates each line: BSD sed emits no newline after a last line
  # that had none, which would glue two files' values into one bogus pattern.)
  sed -nE 's/^[^#=]+=[[:space:]]*["'"'"']?([^"'"'"'[:space:]]{8,})["'"'"']?[[:space:]]*$/\1/p' "$f" | awk 1 >>"$SECRETS_FILE"
  mv "$f" "$STASH_DIR/"
done
rm -rf "$ROOT/build/chrome-mv3-prod"
npm run build

if [[ ! -f "$BUILD_DIR/manifest.json" ]]; then
  echo "ERROR: $BUILD_DIR/manifest.json not found — build failed?" >&2
  exit 1
fi

VERSION="$(node -p "require('$BUILD_DIR/manifest.json').version")"
ZIP="$DIST_DIR/studhelper-v$VERSION.zip"

echo "==> Sanity checks"
MV="$(node -p "require('$BUILD_DIR/manifest.json').manifest_version")"
if [[ "$MV" != "3" ]]; then
  echo "ERROR: manifest_version is $MV, expected 3" >&2
  exit 1
fi

# Secrets: Google API keys (classic "AIza…" and the newer "AQ.…" format),
# bearer tokens, and the literal values of the developer's local .env files.
SECRET_RE='AIza[0-9A-Za-z_-]{35}|(^|[^A-Za-z0-9])AQ\.[A-Za-z0-9_-]{20,}|Bearer [A-Za-z0-9._-]{10,}'
if grep -rInE "$SECRET_RE" "$BUILD_DIR" >/dev/null 2>&1; then
  echo "ERROR: potential secret found in build output:" >&2
  grep -rlE "$SECRET_RE" "$BUILD_DIR" >&2
  exit 1
fi
if [[ -s "$SECRETS_FILE" ]] && grep -rqF -f "$SECRETS_FILE" "$BUILD_DIR"; then
  echo "ERROR: a value from a local .env file was found in the build output:" >&2
  grep -rlF -f "$SECRETS_FILE" "$BUILD_DIR" >&2
  exit 1
fi

# Manifest assertions are set-EQUALITY, so a regression in either direction
# (a permission added OR silently dropped) fails the build. Each entry here is
# justified in docs/store/listing.md — update both together, deliberately.
node - "$BUILD_DIR" <<'EOF'
const fs = require('fs')
const path = require('path')
const dir = process.argv[2]
const m = require(`${dir}/manifest.json`)

// scripting: Plasmo registers the MAIN-world caption hook (youtube-main) via
//            chrome.scripting.registerContentScripts — the only way it can set
//            world:"MAIN" + document_start.
// sidePanel: the UI.  storage: settings + cache.
const EXPECTED_PERMISSIONS = ['scripting', 'sidePanel', 'storage']
// Required: Google's Gemini API (default provider; Gemma uses it too).
const EXPECTED_HOSTS = ['https://generativelanguage.googleapis.com/*']
// Optional, requested at runtime only for providers the user enables in
// Settings (0.3.0). Must match PROVIDERS[*].host where optionalHost is true —
// a unit test (tests/unit/providers.test.ts) holds that side.
const EXPECTED_OPTIONAL_HOSTS = [
  'https://api.mistral.ai/*',
  'https://api.groq.com/*',
  'https://openrouter.ai/*',
  'https://api.deepseek.com/*',
]
// Content scripts touch YouTube watch pages only. No host permission is needed
// for that; reach comes from these match patterns.
const EXPECTED_MATCHES = ['https://www.youtube.com/*']

const errors = []
const eq = (actual, expected) =>
  actual.length === expected.length &&
  [...actual].sort().every((v, i) => v === [...expected].sort()[i])

const permissions = m.permissions ?? []
if (!eq(permissions, EXPECTED_PERMISSIONS)) {
  errors.push(`permissions must be ${JSON.stringify(EXPECTED_PERMISSIONS)}, found: ${JSON.stringify(permissions)}`)
}
if ((m.optional_permissions ?? []).length > 0) {
  errors.push(`optional_permissions must be absent, found: ${JSON.stringify(m.optional_permissions)}`)
}

const hosts = m.host_permissions ?? []
if (!eq(hosts, EXPECTED_HOSTS)) {
  errors.push(`host_permissions must be ${JSON.stringify(EXPECTED_HOSTS)}, found: ${JSON.stringify(hosts)}`)
}
const optionalHosts = m.optional_host_permissions ?? []
if (!eq(optionalHosts, EXPECTED_OPTIONAL_HOSTS)) {
  errors.push(
    `optional_host_permissions must be ${JSON.stringify(EXPECTED_OPTIONAL_HOSTS)}, found: ${JSON.stringify(optionalHosts)}`,
  )
}

const matches = (m.content_scripts ?? []).flatMap((cs) => cs.matches ?? [])
if (!eq([...new Set(matches)], EXPECTED_MATCHES)) {
  errors.push(`content_scripts matches must be ${JSON.stringify(EXPECTED_MATCHES)}, found: ${JSON.stringify(matches)}`)
}

if (!m.side_panel?.default_path) errors.push('side_panel.default_path missing')

// The MAIN-world hook is registered from the service worker, not the manifest:
// make sure that registration (and its match pattern) actually made it in.
const bgFile = path.join(dir, m.background?.service_worker ?? '')
const bg = fs.existsSync(bgFile) ? fs.readFileSync(bgFile, 'utf8') : ''
if (!/world:\s*"MAIN"/.test(bg) || !/runAt:\s*"document_start"/.test(bg)) {
  errors.push('background does not register the MAIN-world document_start content script')
}
for (const pattern of bg.match(/matches:\[[^\]]*\]/g) ?? []) {
  if (pattern !== 'matches:["https://www.youtube.com/*"]') errors.push(`unexpected dynamic match pattern: ${pattern}`)
}

const raw = JSON.stringify(m)
if (raw.includes('PLASMO_') || raw.includes('$')) {
  errors.push('manifest contains an unsubstituted "$"/"PLASMO_" literal')
}

if (errors.length) {
  console.error('ERROR: Store manifest assertions failed:')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
EOF

# No remote code: no importScripts, no <script src="http…">, no literal
# https://….js URLs. (markmap's loader helpers contain CDN URL *templates*
# such as `https://cdn.jsdelivr.net/npm/${path}`; the extension never calls
# them, and they don't match this pattern.)
REMOTE_RE='importScripts\(|<script[^>]+src=["'"'"']https?:|https?://[^"'"'"' `$]+\.js(["'"'"' ?#]|$)'
if grep -rInE "$REMOTE_RE" "$BUILD_DIR" --include='*.js' --include='*.html' >/dev/null 2>&1; then
  echo "ERROR: remote code reference found in build output:" >&2
  grep -rnoE "$REMOTE_RE" "$BUILD_DIR" --include='*.js' --include='*.html' | head >&2
  exit 1
fi
echo "    manifest_version=3, permissions=[scripting, sidePanel, storage],"
echo "    hosts=[generativelanguage], optional hosts=[mistral, groq, openrouter, deepseek],"
echo "    matches=[youtube], MAIN hook registered,"
echo "    no secrets, no remote code — OK"

# Prune web_accessible_resources entries pointing at files absent from the
# build, so the manifest has no dangling references (a red flag in review).
node - "$BUILD_DIR" <<'EOF'
const fs = require('fs')
const path = require('path')
const dir = process.argv[2]
const file = path.join(dir, 'manifest.json')
const m = JSON.parse(fs.readFileSync(file, 'utf8'))
if (Array.isArray(m.web_accessible_resources)) {
  m.web_accessible_resources = m.web_accessible_resources
    .map((e) => ({
      ...e,
      resources: (e.resources ?? []).filter((r) => {
        const ok = fs.existsSync(path.join(dir, r))
        if (!ok) console.log(`    pruned dangling web_accessible_resource: ${r}`)
        return ok
      }),
    }))
    .filter((e) => e.resources.length > 0)
  if (m.web_accessible_resources.length === 0) delete m.web_accessible_resources
  fs.writeFileSync(file, JSON.stringify(m))
}
// Plasmo emits an empty "css": [] on content scripts; harmless but noisy.
for (const cs of m.content_scripts ?? []) if (Array.isArray(cs.css) && cs.css.length === 0) delete cs.css
fs.writeFileSync(file, JSON.stringify(m))
EOF

echo "==> Packing $ZIP"
mkdir -p "$DIST_DIR"
rm -f "$ZIP"
# Zip the CONTENTS of the build dir (manifest.json at zip root — Store requirement).
(cd "$BUILD_DIR" && zip -r -q -X "$ZIP" . -x '.*')

echo "==> Contents"
unzip -l "$ZIP"

SIZE="$(du -h "$ZIP" | cut -f1)"
echo "==> Done: $ZIP ($SIZE)"
