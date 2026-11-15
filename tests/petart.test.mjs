import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PET_CATALOG, characterOf, poseAt, POSE, validateCatalog, parseCatalog, atlasesOf } from '../lib/petart.js'
import { checkPetLook } from '../lib/routes.js'
import { normalizeState, DotStore } from '../lib/store.js'
import { emptyLife, startFocus } from '../lib/petlife.js'

test('角色图鉴：七种形象使用人物与线条两种契约；未知 ID 回退，不丢掉保存的选择', () => {
  assert.deepEqual(PET_CATALOG.characters.map(c => c.id), ['whale-maiden', 'young-man', 'young-woman', 'scholar', 'dot', 'bunny', 'mochi'])
  assert.equal(PET_CATALOG.characters.filter(c=>c.renderer==='dot-atlas-v1').length,4)
  for(const id of ['dot','bunny','mochi'])assert.equal(characterOf(id).style,'soft-line-v2')
  assert.equal(characterOf('removed-character').id, 'whale-maiden')
  assert.equal(characterOf(null).id, 'whale-maiden')
  const saved = normalizeState({ prefs: { pet: { name: '小棉', color: 'green', character: 'removed-character', motion: 'reduced' } } }).prefs.pet
  assert.deepEqual(saved, { name: '小棉', color: 'green', character: 'removed-character', motion: 'reduced' })
  assert.equal(characterOf(saved.character).id, 'whale-maiden')
  assert.deepEqual(checkPetLook({ character: 'young-man', motion: 'reduced' }), { character: 'young-man', motion: 'reduced' })
  assert.throws(() => checkPetLook({ character: 'missing' }), /形象/)
  assert.throws(() => checkPetLook({ motion: 'always' }), /动作/)
})

test('图鉴拒绝脚本、外部资源、未知渲染器、重复 ID 与越界动作', () => {
  const raw = JSON.parse(readFileSync(new URL('../lib/pets/catalog.json', import.meta.url), 'utf8'))
  for (const mutate of [
    x => { x.version = 2 },
    x => { x.characters[0].renderer = 'remote-script' },
    x => { x.characters[1].id = x.characters[0].id },
    x => { x.defaultCharacter = 'missing' },
    x => { x.characters[1].atlas.file = '../outside.png' },
    x => { x.characters[1].atlas.file = 'https://example.com/a.png' },
    x => { x.characters[1].atlas.file = 'code.svg' },
    x => { x.characters[1].atlas.columns = 4 },
    x => { x.characters[1].atlas.width = 1535 },
    x => { x.characters[1].atlas.height = 512 },
    x => { x.characters[0].animations.life.file = '../outside.png' },
    x => { x.characters[0].animations.typing.width = 100 },
    x => { x.characters[0].animations.seatY = 2 },
    x => { x.characters[0].animations.edgeX = -1 },
    x => { x.characters[0].animations.style = 'remote' },
    x => { x.characters[0].animations.peekScale = 2 },
    x => { x.characters[0].animations.fingers.left.source = [500,0,50,50] },
    x => { x.characters[0].animations.blink.desk.source = [500,0,50,50] },
    x => { x.characters[0].animations.blink.desk.frame = 6 },
    x => { x.characters[0].animations.blink.desk.sheet = 'remote' },
    x => { x.gestures[0].frames[1].sx = 10 },
    x => { x.gestures[0].frames[2].at = 0.1 },
    x => { x.gestures[0].frames.at(-1).tilt = 20 },
  ]) { const bad = structuredClone(raw); mutate(bad); assert.throws(() => validateCatalog(bad)) }
  const warnings = []
  const fallback = parseCatalog('{broken', message => warnings.push(message))
  assert.deepEqual(fallback.characters.map(c => c.id), ['dot'])
  assert.equal(warnings.length, 1)
})

test('八种仪态：关键帧首尾复位，任意帧率都得到有限且有边界的姿态', () => {
  assert.equal(PET_CATALOG.gestures.length, 8)
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
  for (const path of ['../lib/desktop/pet-art.ps1', '../lib/desktop/pet-win.ps1', '../lib/desktop/pet-companion.ps1', '../lib/desktop/pet-atlas.ps1', '../lib/desktop/pet-seated.ps1']) {
    assert.deepEqual([...readFileSync(new URL(path, import.meta.url)).subarray(0, 3)], [0xef, 0xbb, 0xbf])
  }
  assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).files.includes('lib'), true)
})

test('人物图片是真正的 RGBA PNG，尺寸和六格清单一致', () => {
  for (const atlas of PET_CATALOG.characters.flatMap(atlasesOf)) {
    const png = readFileSync(new URL('../lib/pets/assets/' + atlas.file, import.meta.url))
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(png.readUInt32BE(16), atlas.width)
    assert.equal(png.readUInt32BE(20), atlas.height)
    assert.equal(png[25], 6, 'RGBA preserves transparent edges')
  }
})

test('保留的矢量兜底仍拒绝外部资源和可执行路径', () => {
  const fallback = parseCatalog('{broken', () => {})
  for (const layer of [{ d: 'M0 0 L1 1', fill: 'url(https://example.com/a)' }, { d: '<script>run()</script>', fill: 'body' }]) {
    const bad = structuredClone(fallback); bad.characters[0].back = [layer]
    assert.throws(() => validateCatalog(bad))
  }
})

test('陪伴姿态与输入回应独立保存，旧偏好和非法输入不被误改', () => {
  assert.deepEqual(checkPetLook({ posture: 'desk', followInput: true }), { posture: 'desk', followInput: true })
  for (const bad of [{ posture: 'walk' }, { followInput: 'false' }, { followInput: 1 }]) assert.throws(() => checkPetLook(bad))
  const pet = { name: '小棉', character: 'bunny', color: 'green', posture: 'classic', followInput: false, motion: 'reduced' }
  const state = normalizeState({ prefs: { pet, life: { outfit: 'scarf', activity: { keys: false, hours: {} } } } })
  assert.deepEqual(state.prefs.pet, pet)
  assert.equal(state.prefs.life.outfit, 'scarf')
  assert.equal(state.prefs.life.activity.keys, false)
  assert.deepEqual(normalizeState({ prefs: { pet: { posture: 'invalid', followInput: 'true' } } }).prefs.pet, {})
})

test('从磁盘重新启动，装扮、正在专注的事务、统计和陪伴设置都保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dot-companion-reload-'))
  try {
    const file = join(dir, 'state.json'), first = new DotStore(file)
    const life = startFocus(emptyLife(), { id: 't1', title: '保留已有好功能' }, 25, new Date('2026-11-14T10:00:00+08:00'))
    life.outfit = 'scarf'; life.activity.hours = { '2026-11-14T10': { active: 8, keys: 0 } }
    await first.mutate(s => { s.prefs.life = life; s.prefs.pet = { name: '小棉', posture: 'classic', followInput: true } })
    const restarted = new DotStore(file); await restarted.load()
    assert.deepEqual(restarted.snapshot().prefs.life, life)
    assert.deepEqual(restarted.snapshot().prefs.pet, first.snapshot().prefs.pet)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
