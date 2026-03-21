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

test('workbench drawer uses split collapsed and open sizing tokens', () => {
  assert.match(styles, /--workbench-drawer-width-collapsed:\s*[^;]+;/)
  assert.match(styles, /--workbench-drawer-width-open:\s*[^;]+;/)
  assert.match(styles, /--workbench-collapsed-top:\s*[^;]+;/)
  assert.match(styles, /--workbench-open-bottom:\s*[^;]+;/)
  assert.match(styles, /\.workbench-drawer\s*\{[\s\S]*?top:\s*var\(--workbench-collapsed-top\);/)
  assert.match(styles, /\.workbench-drawer\.open\s*\{[\s\S]*?width:\s*var\(--workbench-drawer-width-open\);/)
})

test('workbench drawer no longer has neon rail pseudo element', () => {
  assert.doesNotMatch(styles, /\.workbench-drawer::before\s*\{/)
})

test('workbench sections cap height and allow inner scrolling', () => {
  assert.match(styles, /\.workbench-section-body\s*\{[\s\S]*?overflow-y:\s*auto;/)
  assert.match(styles, /#workbenchTasks\.workbench-section-body\s*\{[\s\S]*?max-height:\s*var\(--workbench-tasks-max-height\);/)
  assert.match(styles, /\.workbench-terminals-body\s*\{[\s\S]*?max-height:\s*var\(--workbench-terminals-max-height\);/)
  assert.match(styles, /#workbenchFiles\.workbench-section-body\s*\{[\s\S]*?max-height:\s*var\(--workbench-files-max-height\);/)
})

test('workbench supports single-page switching for tasks terminals and files', () => {
  assert.match(styles, /\.workbench-page-switcher\s*\{/)
  assert.match(styles, /\.workbench-page-btn\.active\s*\{/)
  assert.match(styles, /\.workbench-drawer\[data-workbench-page="tasks"\]\s+\.workbench-section\[data-section="tasks"\]/)
  assert.match(styles, /\.workbench-drawer\[data-workbench-page="terminals"\]\s+\.workbench-section\[data-section="terminals"\]/)
  assert.match(styles, /\.workbench-drawer\[data-workbench-page="files"\]\s+\.workbench-section\[data-section="files"\]/)
})
