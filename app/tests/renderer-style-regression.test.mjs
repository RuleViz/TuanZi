import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const stylesPath = join(process.cwd(), 'src', 'renderer', 'assets', 'styles.css')
const styles = readFileSync(stylesPath, 'utf8')

test('glass surface styles avoid diagonal sheen overlays', () => {
  assert.doesNotMatch(styles, /--frost-sheen:\s*linear-gradient\(155deg/i)
  assert.doesNotMatch(styles, /repeating-linear-gradient\(135deg/i)
})

test('primary glass surfaces share the workbench drawer background style', () => {
  assert.doesNotMatch(styles, /\.sidebar\s*\{[\s\S]*?background:\s*var\(--frost-sheen\)/)
  assert.doesNotMatch(styles, /\.main-content\s*\{[\s\S]*?background:\s*var\(--frost-sheen\)/)
  assert.doesNotMatch(styles, /\.top-bar\s*\{[\s\S]*?background:\s*var\(--frost-sheen\)/)
  assert.doesNotMatch(styles, /\.message\.user \.msg-bubble\s*\{[\s\S]*?background:\s*var\(--frost-sheen\)/)
  assert.doesNotMatch(styles, /\.message\.assistant \.msg-content\s*\{[\s\S]*?background:\s*var\(--frost-sheen\)/)
  assert.doesNotMatch(styles, /\.agent-modal-content\s*\{[\s\S]*?background:\s*var\(--frost-sheen\)/)
})

test('shell chrome uses dark base while inner cards keep frosted glass', () => {
  assert.match(styles, /--glass-shell-bg:\s*rgba\(/)
  assert.match(styles, /--glass-shell-bg-strong:\s*rgba\(/)
  assert.match(styles, /--glass-card-bg:\s*rgba\(/)
  assert.match(styles, /\.sidebar\s*\{[\s\S]*?background:\s*var\(--glass-shell-bg\)/)
  assert.match(styles, /\.main-content\s*\{[\s\S]*?background:\s*var\(--glass-shell-bg-strong\)/)
  assert.match(styles, /\.top-bar\s*\{[\s\S]*?background:\s*var\(--glass-shell-bg\)/)
  assert.match(styles, /\.input-box\s*\{[\s\S]*?background:\s*var\(--glass-card-bg\)/)
  assert.match(styles, /\.input-box\s*\{[\s\S]*?backdrop-filter:\s*blur\(46px\)\s+saturate\(1\.65\);/)
  assert.doesNotMatch(styles, /\.sidebar\s*\{[^}]*backdrop-filter:/)
  assert.doesNotMatch(styles, /\.main-content\s*\{[^}]*backdrop-filter:/)
  assert.doesNotMatch(styles, /\.top-bar\s*\{[^}]*backdrop-filter:/)
})

test('global mesh does not add a full-window gray blur veil', () => {
  assert.match(styles, /\.glass-bg-mesh\s*\{[\s\S]*?backdrop-filter:\s*none;/)
  assert.match(styles, /\.glass-bg-mesh\s*\{[\s\S]*?-webkit-backdrop-filter:\s*none;/)
})

test('context bar uses lightweight icon buttons with popover dropdowns', () => {
  assert.match(styles, /\.ctx-bar\s*\{/)
  assert.match(styles, /\.ctx-icon-btn\s*\{/)
  assert.match(styles, /\.ctx-popover\s*\{/)
  assert.match(styles, /\.ctx-item\.expanded\s+\.ctx-popover\s*\{[\s\S]*?display:\s*block;/)
  assert.match(styles, /\.ctx-item\.hidden\s*\{[\s\S]*?display:\s*none;/)
  assert.match(styles, /\.ctx-badge\s*\{/)
})

test('workbench task detail wraps long tokens to avoid horizontal overflow', () => {
  assert.match(styles, /\.workbench-task-detail[\s\S]*?overflow-wrap:\s*anywhere;/)
})

test('old workbench drawer styles are fully removed', () => {
  assert.doesNotMatch(styles, /\.workbench-drawer\s*\{/)
  assert.doesNotMatch(styles, /\.workbench-drawer\.open\s*\{/)
  assert.doesNotMatch(styles, /\.workbench-page-switcher\s*\{/)
  assert.doesNotMatch(styles, /\.workbench-page-btn\s*\{/)
  assert.doesNotMatch(styles, /\.workbench-close-btn\s*\{/)
})
