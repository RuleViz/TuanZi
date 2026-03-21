import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mainPath = join(process.cwd(), 'src', 'main', 'index.ts')
const mainSource = readFileSync(mainPath, 'utf8')

test('windows window config keeps transparent shell without acrylic tint fallback', () => {
  assert.match(mainSource, /transparent:\s*true/)
  assert.doesNotMatch(mainSource, /backgroundMaterial:\s*'acrylic'/)
})
