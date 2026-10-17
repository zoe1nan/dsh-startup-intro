#!/usr/bin/env node
/**
 * Seed the demo intro clips into the local DSH startup-intro library and select
 * them, so the plugin has something to play on the next boot.
 *
 *   node tools/seed-demo.mjs            # write into ~/.dsh/startup-intro
 *   DSH_HOME=/custom/.dsh node tools/seed-demo.mjs
 *
 * It is safe to run more than once: the demo entry is replaced in place and any
 * other clips in the library are kept.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEMO_DIR = join(ROOT, 'demo')
const DARK = join(DEMO_DIR, 'startup-intro-dark.mp4')
const LIGHT = join(DEMO_DIR, 'startup-intro-light.mp4')

const ID = 'vdemo0001'
const NAME = 'DEEPSEEK HARNESS 开场.mp4'
const PARAMS = Object.freeze({
  start: 0,
  duration: 8.8,
  speed: 1,
  brightness: 1,
  fit: 'cover',
  cinema: true,
  holdRatio: 0.83,
  fadeMs: 1200,
  muted: true,
})

const dshHome = process.env.DSH_HOME ? process.env.DSH_HOME : join(homedir(), '.dsh')
const libraryDir = join(dshHome, 'startup-intro')
const mediaDir = join(libraryDir, 'media')
const stateFile = join(libraryDir, 'state.json')

for (const file of [DARK, LIGHT]) {
  if (!existsSync(file)) {
    console.error(`missing demo clip: ${file}`)
    process.exit(1)
  }
}

mkdirSync(mediaDir, { recursive: true })
const darkName = `${ID}.mp4`
const lightName = `${ID}-light.mp4`
copyFileSync(DARK, join(mediaDir, darkName))
copyFileSync(LIGHT, join(mediaDir, lightName))

const entry = {
  id: ID,
  name: NAME,
  file: darkName,
  lightFile: lightName,
  ext: '.mp4',
  bytes: statSync(DARK).size,
  addedAt: Date.now(),
  meta: { duration: 8.8, width: 1920, height: 1080 },
  params: { ...PARAMS },
}

let state = { version: 1, enabled: true, selectedId: ID, videos: [] }
if (existsSync(stateFile)) {
  try {
    const current = JSON.parse(readFileSync(stateFile, 'utf8'))
    const videos = Array.isArray(current.videos)
      ? current.videos.filter((video) => video && video.id !== ID)
      : []
    state = {
      version: 1,
      enabled: current.enabled !== false,
      selectedId: ID,
      videos: [...videos, entry],
    }
  } catch {
    /* unreadable state: fall through with a fresh one */
  }
} else {
  state.videos = [entry]
}

const temp = `${stateFile}.${process.pid}.tmp`
mkdirSync(dirname(temp), { recursive: true })
writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`)
renameSync(temp, stateFile)

console.log('seeded demo intro into', libraryDir)
console.log('  selected:', NAME)
console.log('  dark   :', join(mediaDir, darkName))
console.log('  light  :', join(mediaDir, lightName))
console.log('\nNext: restart DeepSeek Harness and check Settings -> 启动开场.')
