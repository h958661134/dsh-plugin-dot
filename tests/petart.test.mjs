import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PET_CATALOG, characterOf, poseAt, POSE, validateCatalog, parseCatalog } from '../lib/petart.js'
import { checkPetLook } from '../lib/routes.js'
import { normalizeState } from '../lib/store.js'

test('角色图鉴：三种形象同用一个渲染契约；未知 ID 回退，不丢掉保存的选择', () => {
  assert.deepEqual(PET_CATALOG.characters.map(c => c.id), ['dot', 'bunny', 'mochi'])
  for (const c of PET_CATALOG.characters) assert.equal(c.renderer, 'dot-vector-v1')
  assert.equal(characterOf('removed-character').id, 'dot')
  assert.equal(characterOf(null).id, 'dot')
  const saved = normalizeState({ prefs: { pet: { name: '小棉', color: 'green', character: 'removed-character', motion: 'reduced' } } }).prefs.pet
  assert.deepEqual(saved, { name: '小棉', color: 'green', character: 'removed-character', motion: 'reduced' })
  assert.equal(characterOf(saved.character).id, 'dot')
  assert.deepEqual(checkPetLook({ character: 'bunny', motion: 'reduced' }), { character: 'bunny', motion: 'reduced' })
  assert.throws(() => checkPetLook({ character: 'missing' }), /形象/)
  assert.throws(() => checkPetLook({ motion: 'always' }), /动作/)
})

test('图鉴拒绝脚本、外部资源、未知渲染器、重复 ID 与越界动作', () => {
  const raw = JSON.parse(readFileSync(new URL('../lib/pets/catalog.json', import.meta.url), 'utf8'))
  for (const mutate of [
    x => { x.version = 2 },
    x => { x.characters[0].renderer = 'remote-script' },
    x => { x.characters[1].id = 'dot' },
    x => { x.characters[1].back[0].fill = 'url(https://example.com/track)' },
    x => { x.characters[1].back[0].d = '<script>run()</script>' },
    x => { x.gestures[0].frames[1].sx = 10 },
    x => { x.gestures[0].frames[2].at = 0.1 },
    x => { x.gestures[0].frames.at(-1).tilt = 20 },
  ]) { const bad = structuredClone(raw); mutate(bad); assert.throws(() => validateCatalog(bad)) }
  const warnings = []
  const fallback = parseCatalog('{broken', message => warnings.push(message))
  assert.deepEqual(fallback.characters.map(c => c.id), ['dot'])
  assert.equal(warnings.length, 1)
})

test('六种仪态：关键帧首尾复位，任意帧率都得到有限且有边界的姿态', () => {
  assert.equal(PET_CATALOG.gestures.length, 6)
  for (const g of PET_CATALOG.gestures) {
    assert.deepEqual(poseAt(g, 0), POSE)
    assert.deepEqual(poseAt(g, 1), POSE)
    assert.deepEqual(poseAt(g, -1), POSE)
    assert.deepEqual(poseAt(g, 9), POSE)
    for (let i = 0; i <= 100; i++) {
      const p = poseAt(g, i / 100)
      assert.ok(Object.values(p).every(Number.isFinite))
      assert.ok(p.sx >= 0.7 && p.sx <= 1.3 && p.sy >= 0.7 && p.sy <= 1.3)
    }
    assert.notDeepEqual(poseAt(g, 0.45), POSE)
  }
})

test('Windows 的中文适配层带 BOM，发布资源都位于 lib 内', () => {
  for (const path of ['../lib/desktop/pet-art.ps1', '../lib/desktop/pet-win.ps1']) {
    assert.deepEqual([...readFileSync(new URL(path, import.meta.url)).subarray(0, 3)], [0xef, 0xbb, 0xbf])
  }
  assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).files.includes('lib'), true)
})
