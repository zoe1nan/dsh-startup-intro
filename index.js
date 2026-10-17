/**
 * dsh-startup-intro — Host half.
 *
 * Owns the video media store and the HTTP surface the Browser half uses:
 *
 *   GET  /startup-intro/api/state      current library + selection + params
 *   POST /startup-intro/api/state      patch { enabled, selectedId, videos[] }
 *   POST /startup-intro/api/upload     raw request body -> media/<id>.<ext>
 *   POST /startup-intro/api/delete     { id }
 *   GET  /startup-intro/media/<file>   byte stream with Range support
 *
 * State lives in $HOME/.dsh/startup-intro/state.json, media in
 * $HOME/.dsh/startup-intro/media/. Nothing is served before the first upload,
 * so a fresh install costs nothing at boot.
 */
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'

export const name = 'dsh-startup-intro'
export const inject = ['webServer']

const ROUTE = '/startup-intro'
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
const MAX_JSON_BYTES = 1024 * 1024

const DATA_DIR = join(homedir(), '.dsh', 'startup-intro')
const MEDIA_DIR = join(DATA_DIR, 'media')
const STATE_FILE = join(DATA_DIR, 'state.json')

const VIDEO_MIME = Object.freeze({
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.avi': 'video/x-msvideo',
})
const ALLOWED_EXT = new Set(Object.keys(VIDEO_MIME))
const MIME_EXT = Object.freeze({
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'video/ogg': '.ogv',
  'video/x-msvideo': '.avi',
})

export const DEFAULT_PARAMS = Object.freeze({
  start: 0,
  duration: 6,
  speed: 1,
  brightness: 1,
  fit: 'cover',
  cinema: true,
  holdRatio: 0.83,
  fadeMs: 1200,
  muted: true,
})

const FITS = new Set(['cover', 'contain', 'fill'])

function numberOr(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalizeParams(raw, video) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const mediaDuration = numberOr(video?.meta?.duration, 0)
  const maxSpan = mediaDuration > 0 ? mediaDuration : 600
  const start = clamp(numberOr(source.start, DEFAULT_PARAMS.start), 0, Math.max(0, maxSpan - 0.05))
  const duration = clamp(
    numberOr(source.duration, DEFAULT_PARAMS.duration),
    0.3,
    Math.max(0.3, maxSpan - start),
  )
  const fit = FITS.has(source.fit) ? source.fit : DEFAULT_PARAMS.fit
  return {
    start: Math.round(start * 100) / 100,
    duration: Math.round(duration * 100) / 100,
    speed: Math.round(clamp(numberOr(source.speed, DEFAULT_PARAMS.speed), 0.25, 2) * 100) / 100,
    brightness: Math.round(clamp(numberOr(source.brightness, DEFAULT_PARAMS.brightness), 0.2, 1.8) * 100) / 100,
    fit,
    cinema: source.cinema === undefined ? DEFAULT_PARAMS.cinema : source.cinema === true,
    holdRatio: Math.round(clamp(numberOr(source.holdRatio, DEFAULT_PARAMS.holdRatio), 0.1, 0.97) * 100) / 100,
    fadeMs: Math.round(clamp(numberOr(source.fadeMs, DEFAULT_PARAMS.fadeMs), 0, 4000)),
    muted: source.muted === undefined ? DEFAULT_PARAMS.muted : source.muted === true,
  }
}

function normalizeVideo(video) {
  const raw = video && typeof video === 'object' ? video : {}
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? '未命名视频'),
    file: String(raw.file ?? ''),
    // optional light-appearance cut of the same clip; when present the Client
    // plays it while the app is in light mode (see README).
    lightFile: String(raw.lightFile ?? ''),
    ext: String(raw.ext ?? ''),
    bytes: numberOr(raw.bytes, 0),
    addedAt: numberOr(raw.addedAt, 0),
    meta: {
      duration: numberOr(raw.meta?.duration, 0),
      width: numberOr(raw.meta?.width, 0),
      height: numberOr(raw.meta?.height, 0),
    },
    params: normalizeParams(raw.params, raw),
  }
}

function defaultState() {
  return { version: 1, enabled: true, selectedId: null, videos: [] }
}

function normalizeState(raw) {
  const state = raw && typeof raw === 'object' ? raw : {}
  const videos = Array.isArray(state.videos) ? state.videos.map(normalizeVideo).filter((v) => v.id && v.file) : []
  const selectedId = videos.some((v) => v.id === state.selectedId) ? state.selectedId : videos[0]?.id ?? null
  return {
    version: 1,
    enabled: state.enabled !== false,
    selectedId,
    videos,
  }
}

let mediaDirReady = null
async function ensureMediaDir() {
  if (mediaDirReady === null) {
    mediaDirReady = mkdir(MEDIA_DIR, { recursive: true }).catch((error) => {
      mediaDirReady = null
      throw error
    })
  }
  return mediaDirReady
}

async function readState() {
  try {
    const text = await readFile(STATE_FILE, 'utf8')
    return normalizeState(JSON.parse(text))
  } catch {
    return defaultState()
  }
}

async function writeState(state) {
  await mkdir(DATA_DIR, { recursive: true })
  const temporary = `${STATE_FILE}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temporary, STATE_FILE)
}

let stateChain = Promise.resolve()
function withState(mutator) {
  const run = async () => {
    const state = await readState()
    const result = await mutator(state)
    await writeState(state)
    return result
  }
  const next = stateChain.then(run, run)
  stateChain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

function finish(res, status, headers = {}, body) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(body)
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  finish(res, status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(body)) }, body)
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_JSON_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function streamBodyToFile(req, target, limit) {
  await mkdir(MEDIA_DIR, { recursive: true })
  const handle = await (await import('node:fs/promises')).open(target, 'w')
  let total = 0
  try {
    for await (const chunk of req) {
      total += chunk.length
      if (total > limit) throw new Error('video file too large')
      await handle.write(chunk)
    }
  } catch (error) {
    await handle.close()
    await unlink(target).catch(() => undefined)
    throw error
  }
  await handle.close()
  return total
}

function pickExtension(name, contentType) {
  const fromName = extname(String(name ?? '')).toLowerCase()
  if (ALLOWED_EXT.has(fromName)) return fromName
  const mime = String(contentType ?? '').split(';')[0].trim().toLowerCase()
  if (MIME_EXT[mime]) return MIME_EXT[mime]
  return '.mp4'
}

function parseMediaFile(sub) {
  if (!sub.startsWith('/media/')) return undefined
  const name = sub.slice('/media/'.length)
  if (name === '' || name.includes('/') || name.includes('\\') || name.includes('\0')) return undefined
  if (!ALLOWED_EXT.has(extname(name).toLowerCase())) return undefined
  return name
}

async function serveMedia(req, res, sub) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    finish(res, 405, { allow: 'GET, HEAD' })
    return
  }
  const file = parseMediaFile(sub)
  if (file === undefined) return finish(res, 400)
  const state = await readState()
  // A video owns `file` plus an optional `lightFile` cut, so both are servable.
  const video = state.videos.find((item) => item.file === file || item.lightFile === file)
  if (!video) return finish(res, 404)
  const target = resolve(MEDIA_DIR, file)
  if (target !== resolve(MEDIA_DIR) && !target.startsWith(`${resolve(MEDIA_DIR)}${sep}`)) {
    return finish(res, 403)
  }
  let info
  try {
    info = await stat(target)
  } catch {
    return finish(res, 404)
  }
  if (!info.isFile()) return finish(res, 404)

  const contentType = VIDEO_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const size = info.size
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range.trim() : ''
  let start = 0
  let end = size - 1
  let status = 200
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
  if (match) {
    const first = match[1] === '' ? undefined : Number(match[1])
    const second = match[2] === '' ? undefined : Number(match[2])
    if (first === undefined && second === undefined) {
      start = 0
      end = size - 1
    } else if (first === undefined) {
      start = Math.max(0, size - second)
      end = size - 1
    } else {
      start = first
      end = second === undefined ? size - 1 : Math.min(second, size - 1)
    }
    if (start > end || start >= size) {
      finish(res, 416, { 'content-range': `bytes */${size}` })
      return
    }
    status = 206
  }

  const headers = {
    'content-type': contentType,
    'content-length': String(end - start + 1),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=0, must-revalidate',
  }
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`
  res.writeHead(status, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(target, { start, end })
  stream.on('error', () => {
    res.destroy()
  })
  stream.pipe(res)
}

async function handle(req, res) {
  const url = new URL(req.url ?? ROUTE, 'http://dsh.local')
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    finish(res, 400)
    return
  }
  if (pathname === ROUTE || pathname === `${ROUTE}/`) {
    json(res, 200, { ok: true, plugin: name, routes: ['api/state', 'api/upload', 'api/delete', 'media/<file>'] })
    return
  }
  const sub = pathname.slice(ROUTE.length)

  if (sub === '/api/state' && req.method === 'GET') {
    json(res, 200, { ok: true, state: await readState(), defaults: DEFAULT_PARAMS })
    return
  }

  if (sub === '/api/state' && req.method === 'POST') {
    const patch = await readJsonBody(req)
    const state = await withState((next) => {
      if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
      if (patch.selectedId === null) next.selectedId = null
      else if (typeof patch.selectedId === 'string' && next.videos.some((v) => v.id === patch.selectedId)) {
        next.selectedId = patch.selectedId
      }
      if (Array.isArray(patch.videos)) {
        for (const item of patch.videos) {
          const video = next.videos.find((v) => v.id === item?.id)
          if (!video) continue
          if (item.params !== undefined) video.params = normalizeParams({ ...video.params, ...item.params }, video)
          if (item.meta !== undefined) {
            video.meta = {
              duration: clamp(numberOr(item.meta.duration, video.meta.duration), 0, 86400),
              width: clamp(numberOr(item.meta.width, video.meta.width), 0, 20000),
              height: clamp(numberOr(item.meta.height, video.meta.height), 0, 20000),
            }
            video.params = normalizeParams(video.params, video)
          }
        }
      }
      next.selectedId = next.videos.some((v) => v.id === next.selectedId) ? next.selectedId : next.videos[0]?.id ?? null
      return next
    })
    json(res, 200, { ok: true, state })
    return
  }

  if (sub === '/api/upload' && req.method === 'POST') {
    const name = url.searchParams.get('name') ?? 'intro.mp4'
    const ext = pickExtension(name, req.headers['content-type'])
    await ensureMediaDir()
    const id = `v${randomUUID().replace(/-/g, '').slice(0, 20)}`
    const file = `${id}${ext}`
    const bytes = await streamBodyToFile(req, join(MEDIA_DIR, file), MAX_UPLOAD_BYTES)
    const createdAt = Date.now()
    const entry = {
      id,
      name,
      file,
      ext,
      bytes,
      addedAt: createdAt,
      meta: { duration: 0, width: 0, height: 0 },
      params: { ...DEFAULT_PARAMS },
    }
    const state = await withState((next) => {
      next.videos.push(entry)
      next.selectedId = entry.id
      return next
    })
    json(res, 200, { ok: true, video: entry, state })
    return
  }

  if (sub === '/api/delete' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const id = String(body.id ?? '')
    let removed
    const state = await withState((next) => {
      removed = next.videos.find((video) => video.id === id)
      next.videos = next.videos.filter((video) => video.id !== id)
      if (next.selectedId === id) next.selectedId = next.videos[0]?.id ?? null
      return next
    })
    if (removed) {
      await unlink(resolve(MEDIA_DIR, removed.file)).catch(() => undefined)
      if (typeof removed.lightFile === 'string' && removed.lightFile !== '') {
        await unlink(resolve(MEDIA_DIR, removed.lightFile)).catch(() => undefined)
      }
    }
    json(res, 200, { ok: true, removed: removed?.id ?? null, state })
    return
  }

  if (sub.startsWith('/media/')) {
    await serveMedia(req, res, sub)
    return
  }

  finish(res, 404)
}

export function apply(ctx) {
  // Carry the composition's connection fence (origin/host checks plus the
  // login-token cookie) on every route, so a loopback listener from another
  // process cannot read or replace the user's intro library, and so the
  // Browser half always runs as the authenticated GUI it was served to.
  ctx.inject(['webServer', 'connection'], (child) => {
    child.effect(
      () =>
        child.webServer.register({
          kind: 'prefix',
          path: ROUTE,
          handler: (req, res) => {
            const rejection = child.connection.requestRejection(req)
            if (rejection !== undefined) {
              res.statusCode = rejection
              res.end()
              return
            }
            handle(req, res).catch((error) => {
              if (!res.headersSent) {
                finish(res, 500, {}, `startup-intro: ${error instanceof Error ? error.message : String(error)}`)
              } else {
                res.destroy()
              }
            })
          },
        }),
      'startup-intro: media + settings routes',
    )
  })
}
