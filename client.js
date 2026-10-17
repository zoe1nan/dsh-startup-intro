/**
 * dsh-startup-intro — Browser half.
 *
 * Two registrations:
 *  - `shell.overlay`   : the boot intro itself. Reads the cached plan first so
 *                        the first painted frame is already the video, then
 *                        refreshes the plan from the Host; fades out and
 *                        unmounts when the selected segment ends.
 *  - `settings.section`: the material library + live parameter editor. Every
 *                        control writes through to the Host (debounced) and to
 *                        the localStorage cache the overlay boots from.
 *
 * Playback happens on the original file served by the Host route, so the
 * preview and the boot intro are the same code path with the same parameters.
 */
window.__ModuleLoader__.load({
  id: 'dsh-startup-intro',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // ---------------------------------------------------------------------
    // Constants and small helpers
    // ---------------------------------------------------------------------

    const API = '/startup-intro'
    const CACHE_KEY = 'dsh.startup-intro.cache'
    const SLOT_OVERLAY = 'shell.overlay'
    const SLOT_SETTINGS = 'settings.section'

    const DEFAULT_PARAMS = {
      start: 0,
      duration: 6,
      speed: 1,
      brightness: 1,
      fit: 'cover',
      cinema: true,
      holdRatio: 0.83,
      fadeMs: 1200,
      muted: true,
    }

    const FIT_OPTIONS = [
      ['cover', '铺满（裁切）'],
      ['contain', '完整显示'],
      ['fill', '拉伸铺满'],
    ]

    function numberOr(value, fallback) {
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n) ? n : fallback
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    function clamp01(value) {
      return clamp(numberOr(value, 0), 0, 1)
    }

    function normalizeParams(raw, meta) {
      const source = raw && typeof raw === 'object' ? raw : {}
      const mediaDuration = numberOr(meta && meta.duration, 0)
      const maxSpan = mediaDuration > 0 ? mediaDuration : 600
      const start = clamp(numberOr(source.start, DEFAULT_PARAMS.start), 0, Math.max(0, maxSpan - 0.05))
      const duration = clamp(numberOr(source.duration, DEFAULT_PARAMS.duration), 0.3, Math.max(0.3, maxSpan - start))
      const fit = FIT_OPTIONS.some(([value]) => value === source.fit) ? source.fit : DEFAULT_PARAMS.fit
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

    function formatSeconds(value) {
      const n = Math.max(0, numberOr(value, 0))
      const whole = Math.floor(n)
      const tenths = Math.floor((n - whole) * 10)
      const minutes = Math.floor(whole / 60)
      const seconds = whole % 60
      return `${minutes > 0 ? `${minutes}:` : ''}${minutes > 0 ? String(seconds).padStart(2, '0') : String(seconds)}.${tenths}s`
    }

    function formatBytes(bytes) {
      const n = numberOr(bytes, 0)
      if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
      if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
      if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
      return `${n} B`
    }

    function mediaUrl(file) {
      return `${API}/media/${encodeURIComponent(file)}`
    }

    // DSH marks the dark appearance with a body attribute, so the intro can
    // pick a light or dark cut of the same clip without asking the Host.
    function currentDark() {
      return typeof document !== 'undefined' && !!document.body && document.body.hasAttribute('data-ds-dark-theme')
    }

    function themeFile(video, dark) {
      const isDark = dark === undefined ? currentDark() : dark
      if (!isDark && video && typeof video.lightFile === 'string' && video.lightFile !== '') return video.lightFile
      return video ? video.file : ''
    }

    function useDarkTheme() {
      const [dark, setDark] = useState(currentDark)
      useEffect(() => {
        const body = document.body
        if (!body) return undefined
        const sync = () => setDark(currentDark())
        sync()
        const observer = new MutationObserver(sync)
        observer.observe(body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        return () => observer.disconnect()
      }, [])
      return dark
    }

    function mediaRef(video, dark) {
      const file = themeFile(video, dark)
      return {
        id: video.id,
        name: video.name,
        file,
        lightFile: typeof video.lightFile === 'string' ? video.lightFile : '',
        src: mediaUrl(file),
        meta: {
          duration: numberOr(video.meta && video.meta.duration, 0),
          width: numberOr(video.meta && video.meta.width, 0),
          height: numberOr(video.meta && video.meta.height, 0),
        },
      }
    }

    function pickVideo(state) {
      if (!state || !Array.isArray(state.videos) || state.videos.length === 0) return null
      return state.videos.find((video) => video.id === state.selectedId) || state.videos[0]
    }

    function planFromState(state, dark) {
      if (!state || state.enabled === false) return null
      const video = pickVideo(state)
      if (!video) return null
      return { video: mediaRef(video, dark), params: normalizeParams(video.params, video.meta) }
    }

    // ---------------------------------------------------------------------
    // Host transport
    // ---------------------------------------------------------------------

    async function request(path, init) {
      const response = await fetch(`${API}${path}`, { credentials: 'same-origin', ...init })
      const text = await response.text()
      let payload = null
      if (text !== '') {
        try {
          payload = JSON.parse(text)
        } catch {
          payload = null
        }
      }
      if (!response.ok) {
        throw new Error(payload && payload.error ? String(payload.error) : `HTTP ${response.status}`)
      }
      if (!payload || payload.ok !== true) throw new Error('startup-intro: invalid response')
      return payload
    }

    const fetchState = () => request('/api/state', { method: 'GET' }).then((payload) => payload.state)

    const saveState = (patch) =>
      request('/api/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }).then((payload) => payload.state)

    const uploadVideo = (file) =>
      request(`/api/upload?name=${encodeURIComponent(file.name || 'intro.mp4')}`, {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      })

    const deleteVideo = (id) =>
      request('/api/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then((payload) => payload.state)

    // ---------------------------------------------------------------------
    // Boot cache — the overlay's first frame must not wait for a round trip.
    // ---------------------------------------------------------------------

    function readCache() {
      try {
        const raw = window.localStorage.getItem(CACHE_KEY)
        if (!raw) return null
        const value = JSON.parse(raw)
        return value && typeof value === 'object' ? value : null
      } catch {
        return null
      }
    }

    function writeCache(plan) {
      try {
        if (plan === null || plan === undefined) window.localStorage.removeItem(CACHE_KEY)
        else window.localStorage.setItem(CACHE_KEY, JSON.stringify(plan))
      } catch {
        // localStorage may be unavailable in a hardened page; the overlay
        // then simply waits for the first Host fetch.
      }
    }

    function cacheFromState(state, dark) {
      const plan = planFromState(state, dark)
      if (plan === null) return null
      const video = plan.video
      // Keep the media choices (not the resolved URL) so a cached plan can be
      // re-resolved against the appearance the page actually starts in.
      return {
        enabled: true,
        video: { id: video.id, name: video.name, file: video.file, lightFile: video.lightFile, meta: video.meta },
        params: plan.params,
      }
    }

    function probeVideo(objectUrl) {
      return new Promise((resolve) => {
        const probe = document.createElement('video')
        probe.preload = 'metadata'
        probe.muted = true
        let settled = false
        const done = (value) => {
          if (settled) return
          settled = true
          window.clearTimeout(timer)
          probe.removeAttribute('src')
          probe.load()
          resolve(value)
        }
        const timer = window.setTimeout(() => done({ duration: 0, width: 0, height: 0 }), 20000)
        probe.addEventListener('loadedmetadata', () => {
          done({
            duration: Number.isFinite(probe.duration) ? probe.duration : 0,
            width: probe.videoWidth || 0,
            height: probe.videoHeight || 0,
          })
        })
        probe.addEventListener('error', () => done({ duration: 0, width: 0, height: 0 }))
        probe.src = objectUrl
      })
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    const SHARED_CSS = `
.dshsi-root{box-sizing:border-box;color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:1.5}
.dshsi-root *{box-sizing:border-box}
.dshsi-card{background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,rgba(255,255,255,.04)));border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l1,rgba(255,255,255,.10)));border-radius:12px}
.dshsi-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));background:var(--dsw-alias-button-elevated-fill,rgba(255,255,255,.06));color:inherit;border-radius:8px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer;transition:background .15s ease,border-color .15s ease}
.dshsi-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-button-floating-hover,rgba(255,255,255,.12)))}
.dshsi-btn[data-kind="primary"]{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#3b6cf6));border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff);font-weight:500}
.dshsi-btn[data-kind="danger"]:hover{background:rgba(255,90,90,.18);border-color:rgba(255,90,90,.5)}
.dshsi-btn[disabled]{opacity:.45;cursor:default}
.dshsi-range{appearance:none;-webkit-appearance:none;width:100%;height:20px;margin:0;background:transparent;cursor:pointer;--dshsi-fill:0%}
.dshsi-range::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:linear-gradient(to right,var(--dsw-alias-brand-primary,#5c8dff) 0,var(--dsw-alias-brand-primary,#5c8dff) var(--dshsi-fill),var(--dsw-alias-bg-mask-3,rgba(255,255,255,.16)) var(--dshsi-fill),var(--dsw-alias-bg-mask-3,rgba(255,255,255,.16)) 100%)}
.dshsi-range::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:var(--dsw-alias-label-primary,#fff);border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.25));box-shadow:0 1px 3px rgba(0,0,0,.35)}
.dshsi-range::-moz-range-track{height:4px;border-radius:999px;background:var(--dsw-alias-bg-mask-3,rgba(255,255,255,.16))}
.dshsi-range::-moz-range-progress{height:4px;border-radius:999px;background:var(--dsw-alias-brand-primary,#5c8dff)}
.dshsi-range::-moz-range-thumb{width:14px;height:14px;border-radius:50%;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.25));background:var(--dsw-alias-label-primary,#fff)}
.dshsi-num{width:74px;background:var(--dsw-alias-bg-base,rgba(0,0,0,.25));border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:6px;color:inherit;font:inherit;font-size:12px;padding:3px 6px}
.dshsi-select{background:var(--dsw-alias-bg-base,rgba(0,0,0,.25));border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:6px;color:inherit;font:inherit;font-size:12px;padding:4px 8px;min-width:130px}
.dshsi-muted{opacity:.62}
`

    const OVERLAY_CSS = `
.dshsi-stage{position:fixed;inset:0;z-index:2147483000;background:#000;overflow:hidden;display:flex;align-items:center;justify-content:center;opacity:1;pointer-events:auto;cursor:pointer;transition:opacity 400ms linear;will-change:opacity}
.dshsi-stage{transition:opacity 900ms ease, transform 1200ms cubic-bezier(0.22,0.61,0.36,1)}
.dshsi-stage[data-fading="true"]{opacity:0;transform:scale(1.045)}
.dshsi-stage-bg{position:absolute;inset:-6%;width:112%;height:112%;object-fit:cover;filter:blur(44px) brightness(.42) saturate(1.15);transform:scale(1.04);opacity:.95;pointer-events:none}
.dshsi-stage-video{position:relative;z-index:1;width:100%;height:100%;display:block;object-fit:cover}
.dshsi-stage-vignette{position:absolute;inset:0;z-index:2;pointer-events:none;background:radial-gradient(ellipse at center,rgba(0,0,0,0) 52%,rgba(0,0,0,.58) 100%)}
.dshsi-stage-hint{position:absolute;right:24px;bottom:20px;z-index:3;color:rgba(255,255,255,.66);font:12px/1.4 ui-monospace,Consolas,'Courier New',monospace;letter-spacing:.09em;pointer-events:none;text-shadow:0 1px 8px rgba(0,0,0,.85)}
.dshsi-stage-progress{position:absolute;left:0;bottom:0;height:2px;z-index:3;background:#5FE1FF;box-shadow:0 0 10px rgba(95,225,255,.9);transition:width 130ms linear;pointer-events:none}
.dshsi-stage.dshsi-embed{position:absolute;inset:0;z-index:auto;cursor:default}
.dshsi-stage.dshsi-embed .dshsi-stage-hint{right:10px;bottom:8px;font-size:11px}
`

    // ---------------------------------------------------------------------
    // BodyLayer — the boot intro must outrank Harness dialogs. Slot entries
    // live inside the app frame's own stacking context (the overlay layer sits
    // at z-index 20), while Harness portals its dialogs to a body-level root at
    // z-index 1000 — so a fixed child of the slot can never paint above them.
    // Portalling one layer to the end of <body> restores last-in-DOM order.
    // ---------------------------------------------------------------------

    function BodyLayer(props) {
      const [host] = useState(() => {
        const element = document.createElement('div')
        element.className = 'dshsi-body-layer'
        element.setAttribute('data-dsh-startup-intro', '')
        return element
      })
      useEffect(() => {
        document.body.appendChild(host)
        return () => host.remove()
      }, [host])
      return ReactDOM.createPortal(props.children, host)
    }

    // ---------------------------------------------------------------------
    // VideoStage — one playback surface shared by boot overlay and previews.
    // ---------------------------------------------------------------------

    function VideoStage(props) {
      const { video, params, mode, embedded } = props
      const p = normalizeParams(params, video && video.meta)
      const videoRef = useRef(null)
      const bgRef = useRef(null)
      const phaseRef = useRef({ finished: false, engaged: false })
      const onFinishRef = useRef(props.onFinish)
      onFinishRef.current = props.onFinish
      const [fading, setFading] = useState(false)
      const [progress, setProgress] = useState(0)
      const [paused, setPaused] = useState(false)

      const finish = useCallback(
        (immediate) => {
          const phase = phaseRef.current
          if (phase.finished) return
          phase.finished = true
          const fadeMs = immediate ? 180 : p.fadeMs
          if (mode === 'preview') {
            if (onFinishRef.current) onFinishRef.current()
            return
          }
          setFading(true)
          window.setTimeout(() => {
            if (onFinishRef.current) onFinishRef.current()
          }, fadeMs + 80)
        },
        [mode, p.fadeMs],
      )

      // Start playback once the media element exists.
      useEffect(() => {
        const element = videoRef.current
        if (!element) return undefined
        let cancelled = false
        const begin = () => {
          if (cancelled) return
          element.muted = p.muted
          element.playbackRate = p.speed
          if (Number.isFinite(p.start) && p.start > 0) {
            try {
              element.currentTime = p.start
            } catch {
              // seeking before metadata is a no-op; the metadata handler retries
            }
          }
          const background = bgRef.current
          if (background) {
            background.muted = true
            background.playbackRate = p.speed
            background.play().catch(() => {})
          }
          element.play().catch(() => {
            if (!element.muted) {
              element.muted = true
              element.play().catch(() => {})
            }
          })
        }
        if (element.readyState >= 1) begin()
        element.addEventListener('loadedmetadata', begin)
        const safety = window.setTimeout(() => {
          // Never hold the app hostage: a broken or very long file still fades.
          const cap = Math.min(90000, (p.duration / Math.max(0.25, p.speed)) * 1000 + p.fadeMs + 6000)
          window.setTimeout(() => finish(true), cap)
        }, 0)
        return () => {
          cancelled = true
          window.clearTimeout(safety)
          element.removeEventListener('loadedmetadata', begin)
        }
        // Intentionally tied to the media source only: parameter edits are
        // applied by the effects below without restarting the clock.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [video && video.src])

      useEffect(() => {
        const element = videoRef.current
        if (!element) return
        element.playbackRate = p.speed
        element.muted = p.muted
        const background = bgRef.current
        if (background) {
          background.playbackRate = p.speed
          background.muted = true
          background.play().catch(() => {})
        }
      }, [p.speed, p.muted, p.cinema])

      useEffect(() => {
        if (mode !== 'preview') return
        const element = videoRef.current
        if (!element) return
        try {
          element.currentTime = p.start
          element.play().catch(() => {})
        } catch {
          // ignore
        }
      }, [mode, p.start])

      useEffect(() => {
        if (mode !== 'startup') return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') finish(true)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [mode, finish])

      const handleTime = () => {
        const element = videoRef.current
        if (!element) return
        const t = element.currentTime
        setProgress(clamp01((t - p.start) / Math.max(0.001, p.duration)))
        const segmentEnd = p.start + p.duration
        if (mode === 'preview') {
          if (t >= segmentEnd - 0.04) {
            try {
              element.currentTime = p.start
            } catch {
              // ignore
            }
            element.play().catch(() => {})
          }
          return
        }
        const phase = phaseRef.current
        if (phase.finished) return
        const fadeMedia = Math.min((p.fadeMs / 1000) * p.speed, p.duration * 0.9)
        const fadeStart = Math.max(
          p.start,
          Math.min(p.start + p.duration * p.holdRatio, segmentEnd - fadeMedia),
        )
        if (!phase.engaged && fadeMedia > 0 && t >= fadeStart) {
          phase.engaged = true
          finish(false)
        } else if (t >= segmentEnd) {
          finish(true)
        }
      }

      const handleEnded = () => {
        if (mode === 'preview') {
          const element = videoRef.current
          if (!element) return
          try {
            element.currentTime = p.start
          } catch {
            // ignore
          }
          element.play().catch(() => {})
          return
        }
        finish(true)
      }

      const handleClick = () => {
        if (mode === 'preview') {
          const element = videoRef.current
          if (!element) return
          if (element.paused) {
            element.play().catch(() => {})
            setPaused(false)
          } else {
            element.pause()
            setPaused(true)
          }
          return
        }
        finish(true)
      }

      const objectFit = p.fit === 'contain' ? 'contain' : p.fit === 'fill' ? 'fill' : 'cover'
      const videoStyle = { objectFit, filter: `brightness(${p.brightness})` }
      const hint =
        mode === 'preview'
          ? paused
            ? '已暂停 · 点击继续'
            : '实时预览 · 点击暂停'
          : `${p.muted ? '静音' : '有声'} · 点击跳过开场`

      return h(
        'div',
        {
          className: embedded ? 'dshsi-stage dshsi-embed' : 'dshsi-stage',
          'data-fading': fading ? 'true' : 'false',
          style: embedded ? undefined : { transitionDuration: `${Math.max(60, p.fadeMs)}ms` },
          onClick: handleClick,
          role: mode === 'preview' ? 'presentation' : 'presentation',
        },
        h('style', { dangerouslySetInnerHTML: { __html: OVERLAY_CSS } }),
        p.cinema && video && video.src
          ? h('video', {
              key: `bg-${video.src}`,
              className: 'dshsi-stage-bg',
              src: video.src,
              muted: true,
              playsInline: true,
              autoPlay: true,
              loop: true,
              preload: 'auto',
              ref: bgRef,
              'aria-hidden': 'true',
            })
          : null,
        video && video.src
          ? h('video', {
              key: `main-${video.src}`,
              className: 'dshsi-stage-video',
              src: video.src,
              playsInline: true,
              preload: 'auto',
              ref: videoRef,
              style: videoStyle,
              onTimeUpdate: handleTime,
              onEnded: handleEnded,
            })
          : null,
        h('div', { className: 'dshsi-stage-vignette' }),
        h('div', { className: 'dshsi-stage-hint' }, hint),
        mode === 'startup'
          ? h('div', { className: 'dshsi-stage-progress', style: { width: `${progress * 100}%` } })
          : null,
      )
    }

    // ---------------------------------------------------------------------
    // StartupOverlay — one boot intro per page load.
    // ---------------------------------------------------------------------

    function StartupOverlay() {
      const [plan, setPlan] = useState(() => {
        const cached = readCache()
        if (cached && cached.enabled !== false && cached.video && (cached.video.src || cached.video.file)) {
          const video = cached.video.src ? cached.video : mediaRef(cached.video, currentDark())
          return { video, params: normalizeParams(cached.params, video.meta) }
        }
        return 'pending'
      })
      const [finished, setFinished] = useState(false)
      const done = useCallback(() => setFinished(true), [])

      useEffect(() => {
        let cancelled = false
        fetchState()
          .then((state) => {
            if (cancelled) return
            const next = cacheFromState(state, currentDark())
            writeCache(next)
            setPlan((current) =>
              current === 'pending'
                ? next === null
                  ? null
                  : { video: mediaRef(next.video, currentDark()), params: next.params }
                : current,
            )
          })
          .catch(() => {
            if (!cancelled) setPlan((current) => (current === 'pending' ? null : current))
          })
        return () => {
          cancelled = true
        }
      }, [])

      if (finished || plan === null) return null
      if (plan === 'pending') {
        return h(
          BodyLayer,
          null,
          h(
            'div',
            {
              className: 'dshsi-stage',
              'data-fading': 'false',
              style: { transitionDuration: '200ms' },
            },
            h('style', { dangerouslySetInnerHTML: { __html: OVERLAY_CSS } }),
          ),
        )
      }
      return h(
        BodyLayer,
        null,
        h(VideoStage, { video: plan.video, params: plan.params, mode: 'startup', onFinish: done }),
      )
    }

    // ---------------------------------------------------------------------
    // Settings widgets
    // ---------------------------------------------------------------------

    function SwitchField(props) {
      const { label, hint, checked, onChange } = props
      return h(
        'div',
        { className: 'dshsi-switch-row' },
        h(
          'div',
          { className: 'dshsi-switch-text' },
          h('div', { className: 'dshsi-switch-label' }, label),
          hint ? h('div', { className: 'dshsi-muted dshsi-switch-hint' }, hint) : null,
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': checked ? 'true' : 'false',
            className: 'dshsi-switch',
            'data-on': checked ? 'true' : 'false',
            onClick: () => onChange(!checked),
          },
          h('span', { className: 'dshsi-switch-knob' }),
        ),
      )
    }

    function SliderField(props) {
      const { label, value, min, max, step, onChange, format } = props
      const display = format ? format(value) : String(value)
      return h(
        'label',
        { className: 'dshsi-field' },
        h('span', { className: 'dshsi-field-head' }, h('span', null, label), h('span', { className: 'dshsi-field-value' }, display)),
        h('input', {
          className: 'dshsi-range',
          type: 'range',
          min,
          max,
          step,
          value,
          style: { '--dshsi-fill': (max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0) + '%' },
          onChange: (event) => onChange(Number(event.target.value)),
        }),
      )
    }

    function SettingsSection() {
      const dark = useDarkTheme()
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(null)
      const [saveStateLabel, setSaveStateLabel] = useState('')
      const [confirmDeleteId, setConfirmDeleteId] = useState(null)
      const [previewOpen, setPreviewOpen] = useState(false)
      const fileInputRef = useRef(null)
      const saveTimerRef = useRef(null)
      const dataRef = useRef(null)
      dataRef.current = data

      useEffect(() => {
        let cancelled = false
        fetchState()
          .then((state) => {
            if (!cancelled) setData(state)
          })
          .catch((cause) => {
            if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
          })
        return () => {
          cancelled = true
          window.clearTimeout(saveTimerRef.current)
        }
      }, [])

      const syncCache = useCallback(
        (state) => {
          writeCache(cacheFromState(state, dark))
        },
        [dark],
      )

      const applyState = useCallback(
        (state) => {
          setData(state)
          syncCache(state)
          setSaveStateLabel('已保存')
        },
        [syncCache],
      )

      const persist = useCallback(
        (patch, options) => {
          setSaveStateLabel('保存中…')
          saveState(patch)
            .then((state) => applyState(state))
            .catch((cause) => {
              setSaveStateLabel('保存失败')
              setError(cause instanceof Error ? cause.message : String(cause))
            })
          if (options && options.immediate === true) return
        },
        [applyState],
      )

      const scheduleSave = useCallback(
        (patch) => {
          window.clearTimeout(saveTimerRef.current)
          setSaveStateLabel('保存中…')
          saveTimerRef.current = window.setTimeout(() => persist(patch, { immediate: true }), 320)
        },
        [persist],
      )

      const selected = useMemo(() => {
        if (!data || !Array.isArray(data.videos) || data.videos.length === 0) return null
        return data.videos.find((video) => video.id === data.selectedId) || data.videos[0]
      }, [data])

      const params = selected ? normalizeParams(selected.params, selected.meta) : normalizeParams(DEFAULT_PARAMS, null)
      const maxDuration = selected && numberOr(selected.meta && selected.meta.duration, 0) > 0 ? selected.meta.duration : 600

      const patchSelectedParams = useCallback(
        (patch) => {
          const current = dataRef.current
          if (!current || !selected) return
          const nextParams = normalizeParams({ ...selected.params, ...patch }, selected.meta)
          const next = {
            ...current,
            videos: current.videos.map((video) =>
              video.id === selected.id ? { ...video, params: nextParams } : video,
            ),
          }
          setData(next)
          writeCache({
            enabled: next.enabled,
            video: {
              id: selected.id,
              name: selected.name,
              file: selected.file,
              lightFile: typeof selected.lightFile === 'string' ? selected.lightFile : '',
              meta: selected.meta,
            },
            params: nextParams,
          })
          scheduleSave({ videos: [{ id: selected.id, params: nextParams }] })
        },
        [selected, scheduleSave],
      )

      const toggleEnabled = useCallback(
        (enabled) => {
          const current = dataRef.current
          if (!current) return
          setData({ ...current, enabled })
          writeCache(enabled ? cacheFromState({ ...current, enabled }, dark) : null)
          persist({ enabled }, { immediate: true })
        },
        [persist],
      )

      const selectVideo = useCallback(
        (id) => {
          const current = dataRef.current
          if (!current) return
          setData({ ...current, selectedId: id })
          writeCache(cacheFromState({ ...current, selectedId: id }))
          persist({ selectedId: id }, { immediate: true })
        },
        [persist],
      )

      const importFiles = useCallback(
        async (fileList) => {
          const files = Array.from(fileList || []).filter((file) => file && file.size > 0)
          if (files.length === 0) return
          setError(null)
          for (const file of files) {
            setBusy(`正在导入 ${file.name}…`)
            try {
              const payload = await uploadVideo(file)
              const entry = payload.video
              const objectUrl = URL.createObjectURL(file)
              setBusy(`正在解析 ${file.name}…`)
              const meta = await probeVideo(objectUrl)
              URL.revokeObjectURL(objectUrl)
              const state = await saveState({ videos: [{ id: entry.id, meta }] })
              applyState(state)
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause))
            }
          }
          setBusy(null)
          if (fileInputRef.current) fileInputRef.current.value = ''
        },
        [applyState],
      )

      const removeVideo = useCallback(
        async (id) => {
          setBusy('正在删除…')
          try {
            const state = await deleteVideo(id)
            applyState(state)
            setConfirmDeleteId(null)
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          }
          setBusy(null)
        },
        [applyState],
      )

      const resetParams = useCallback(() => {
        if (!selected) return
        patchSelectedParams({ ...DEFAULT_PARAMS })
      }, [selected, patchSelectedParams])

      const openPreview = useCallback(() => setPreviewOpen(true), [])
      const closePreview = useCallback(() => setPreviewOpen(false), [])

      const header = h(
        'div',
        { className: 'dshsi-head' },
        h(
          'div',
          null,
          h('h2', { className: 'dshsi-title' }, '启动开场动画'),
          h(
            'p',
            { className: 'dshsi-subtitle' },
            '进入工作界面前播放一段自定义视频。视频与参数都保存在本机，启动时直接播放原始文件，结束后淡出露出工作界面。',
          ),
        ),
        data
          ? h(SwitchField, {
              label: '每次启动播放',
              checked: data.enabled !== false,
              onChange: toggleEnabled,
            })
          : null,
      )

      const library = h(
        'div',
        { className: 'dshsi-library' },
        h(
          'div',
          { className: 'dshsi-row-between' },
          h('div', { className: 'dshsi-section-title' }, '视频素材库'),
          h(
            'div',
            { className: 'dshsi-row' },
            busy ? h('span', { className: 'dshsi-muted dshsi-busy' }, busy) : null,
            h(
              'button',
              { type: 'button', className: 'dshsi-btn', 'data-kind': 'primary', onClick: () => fileInputRef.current && fileInputRef.current.click() },
              '导入视频',
            ),
          ),
        ),
        data && data.videos.length > 0
          ? h(
              'div',
              { className: 'dshsi-cards' },
              data.videos.map((video) =>
                h(
                  'div',
                  {
                    key: video.id,
                    className: 'dshsi-card dshsi-video-card',
                    'data-selected': video.id === data.selectedId ? 'true' : 'false',
                    onClick: () => selectVideo(video.id),
                    role: 'button',
                    tabIndex: 0,
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' || event.key === ' ') selectVideo(video.id)
                    },
                  },
                  h('div', { className: 'dshsi-video-name', title: video.name }, video.name),
                  h(
                    'div',
                    { className: 'dshsi-video-meta dshsi-muted' },
                    `${formatSeconds(video.meta && video.meta.duration)} · ${formatBytes(video.bytes)}`,
                  ),
                  h(
                    'div',
                    { className: 'dshsi-video-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dshsi-btn dshsi-mini',
                        onClick: (event) => {
                          event.stopPropagation()
                          if (confirmDeleteId === video.id) removeVideo(video.id)
                          else {
                            setConfirmDeleteId(video.id)
                            window.setTimeout(() => setConfirmDeleteId((current) => (current === video.id ? null : current)), 4000)
                          }
                        },
                      },
                      confirmDeleteId === video.id ? '确认删除' : '删除',
                    ),
                  ),
                ),
              ),
            )
          : h(
              'div',
              {
                className: 'dshsi-card dshsi-empty',
                onDragOver: (event) => event.preventDefault(),
                onDrop: (event) => {
                  event.preventDefault()
                  importFiles(event.dataTransfer.files)
                },
              },
              h('div', { className: 'dshsi-empty-title' }, '还没有导入视频'),
              h('div', { className: 'dshsi-muted' }, '导入一段 MP4 / WebM / MOV，选中后每次启动都会播放它。也可以把文件拖到这里。'),
            ),
        h('input', {
          id: 'dshsi-file-input',
          ref: fileInputRef,
          type: 'file',
          accept: 'video/*',
          multiple: true,
          style: { display: 'none' },
          onChange: (event) => importFiles(event.target.files),
        }),
      )

      const preview = selected
        ? h(
            'div',
            { className: 'dshsi-preview-wrap' },
            h(
              'div',
              { className: 'dshsi-preview' },
              h(VideoStage, {
                video: mediaRef(selected, dark),
                params,
                mode: 'preview',
                embedded: true,
              }),
            ),
            h(
              'div',
              { className: 'dshsi-preview-actions' },
              h('button', { type: 'button', className: 'dshsi-btn', 'data-kind': 'primary', onClick: openPreview }, '播放完整开场效果'),
              h('button', { type: 'button', className: 'dshsi-btn', onClick: resetParams }, '恢复默认参数'),
              h('span', { className: 'dshsi-muted' }, saveStateLabel),
            ),
          )
        : null

      const editor = selected
        ? h(
            'div',
            { className: 'dshsi-editor' },
            h('div', { className: 'dshsi-section-title' }, `参数 · ${selected.name}`),
            h(
              'div',
              { className: 'dshsi-grid2' },
              h(SliderField, {
                label: '起始位置',
                value: params.start,
                min: 0,
                max: Math.max(0.1, maxDuration - 0.3),
                step: 0.1,
                onChange: (value) => patchSelectedParams({ start: value }),
                format: formatSeconds,
              }),
              h(SliderField, {
                label: '播放时长',
                value: params.duration,
                min: 0.3,
                max: Math.max(0.4, maxDuration - params.start),
                step: 0.1,
                onChange: (value) => patchSelectedParams({ duration: value }),
                format: formatSeconds,
              }),
              h(SliderField, {
                label: '播放速度',
                value: params.speed,
                min: 0.25,
                max: 2,
                step: 0.05,
                onChange: (value) => patchSelectedParams({ speed: value }),
                format: (value) => `${value.toFixed(2)}×`,
              }),
              h(SliderField, {
                label: '亮度',
                value: params.brightness,
                min: 0.2,
                max: 1.8,
                step: 0.05,
                onChange: (value) => patchSelectedParams({ brightness: value }),
                format: (value) => value.toFixed(2),
              }),
              h(SliderField, {
                label: '展示比例',
                value: Math.round(params.holdRatio * 100),
                min: 10,
                max: 97,
                step: 1,
                onChange: (value) => patchSelectedParams({ holdRatio: value / 100 }),
                format: (value) => `${value}% 处开始淡出`,
              }),
              h(SliderField, {
                label: '淡出时长',
                value: params.fadeMs,
                min: 0,
                max: 4000,
                step: 50,
                onChange: (value) => patchSelectedParams({ fadeMs: value }),
                format: (value) => `${value} ms`,
              }),
            ),
            h(
              'div',
              { className: 'dshsi-grid2 dshsi-inline' },
              h(
                'label',
                { className: 'dshsi-field' },
                h('span', { className: 'dshsi-field-head' }, h('span', null, '画面适配')),
                h(
                  'select',
                  {
                    className: 'dshsi-select',
                    value: params.fit,
                    onChange: (event) => patchSelectedParams({ fit: event.target.value }),
                  },
                  FIT_OPTIONS.map(([value, label]) => h('option', { key: value, value }, label)),
                ),
              ),
              h(SwitchField, {
                label: '影院填充',
                hint: '用同一视频的模糊背景补满画面',
                checked: params.cinema,
                onChange: (value) => patchSelectedParams({ cinema: value }),
              }),
              h(SwitchField, {
                label: '静音播放',
                hint: '关闭后尝试带声音播放（浏览器可能拦截自动播放）',
                checked: params.muted,
                onChange: (value) => patchSelectedParams({ muted: value }),
              }),
            ),
          )
        : null

      const body = h(
        'div',
        { className: 'dshsi-root' },
        h('style', { dangerouslySetInnerHTML: { __html: SHARED_CSS + SETTINGS_CSS } }),
        data === null
          ? h('div', { className: 'dshsi-loading' }, error ? `加载失败：${error}` : '正在读取启动开场配置…')
          : h(React.Fragment, null, header, error ? h('div', { className: 'dshsi-error' }, error) : null, library, preview, editor, h('div', { className: 'dshsi-foot dshsi-muted' }, '视频与参数仅保存在本机 ~/.dsh/startup-intro。切换插件或删除插件不会删除素材。')),
      )

      const overlay = previewOpen && selected
        ? h(VideoStage, {
            video: mediaRef(selected, dark),
            params,
            mode: 'startup',
            onFinish: closePreview,
          })
        : null

      return h(React.Fragment, null, body, overlay)
    }

    const SETTINGS_CSS = `
.dshsi-root{display:flex;flex-direction:column;gap:18px;padding:4px 2px 28px;max-width:880px}
.dshsi-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}
.dshsi-title{margin:0 0 6px;font-size:17px;font-weight:600;letter-spacing:.01em}
.dshsi-subtitle{margin:0;max-width:560px;font-size:12.5px;line-height:1.65;opacity:.66}
.dshsi-section-title{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;opacity:.72}
.dshsi-row{display:flex;align-items:center;gap:10px}
.dshsi-row-between{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dshsi-library{display:flex;flex-direction:column;gap:12px}
.dshsi-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}
.dshsi-video-card{padding:10px 12px;cursor:pointer;display:flex;flex-direction:column;gap:2px;transition:border-color .15s ease,background .15s ease;outline:none}
.dshsi-video-card:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,rgba(255,255,255,.07)))}
.dshsi-video-card[data-selected="true"]{border-color:var(--dsw-alias-brand-primary,#5c8dff);background:var(--dsw-alias-bg-layer-2,rgba(92,141,255,.10))}
.dshsi-video-name{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshsi-video-meta{font-size:11px}
.dshsi-video-actions{display:flex;justify-content:flex-end;margin-top:4px}
.dshsi-mini{padding:2px 8px;font-size:11px;border-radius:6px}
.dshsi-empty{padding:26px 18px;text-align:center;display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.dshsi-empty-title{font-weight:600;font-size:13px}
.dshsi-preview-wrap{display:flex;flex-direction:column;gap:10px}
.dshsi-preview{position:relative;height:260px;border-radius:12px;overflow:hidden;background:#000;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.10))}
.dshsi-preview-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshsi-editor{display:flex;flex-direction:column;gap:14px}
.dshsi-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 20px}
.dshsi-grid2.dshsi-inline{grid-template-columns:repeat(2,minmax(0,1fr));align-items:end}
.dshsi-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.dshsi-field-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:12px}
.dshsi-field-value{font-size:11.5px;opacity:.72;font-variant-numeric:tabular-nums}
.dshsi-switch-row{display:flex;align-items:center;justify-content:space-between;gap:14px}
.dshsi-switch-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshsi-switch-label{font-size:12.5px}
.dshsi-switch-hint{font-size:11px}
.dshsi-switch{position:relative;flex:none;width:38px;height:21px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.18));background:var(--dsw-alias-bg-mask-2,rgba(255,255,255,.08));padding:0;cursor:pointer;transition:background .18s ease,border-color .18s ease}
.dshsi-switch[data-on="true"]{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#3b6cf6));border-color:transparent}
.dshsi-switch-knob{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);box-shadow:0 1px 2px rgba(0,0,0,.35);transition:transform .18s ease}
.dshsi-switch[data-on="true"] .dshsi-switch-knob{transform:translateX(17px)}
.dshsi-loading{padding:20px 0;font-size:12.5px;opacity:.7}
.dshsi-error{padding:8px 12px;border-radius:8px;border:1px solid rgba(255,90,90,.45);background:rgba(255,90,90,.12);font-size:12px}
.dshsi-foot{font-size:11px;line-height:1.6}
@media (max-width:680px){.dshsi-grid2,.dshsi-grid2.dshsi-inline{grid-template-columns:minmax(0,1fr)}}
`

    // ---------------------------------------------------------------------
    // Cordis wiring
    // ---------------------------------------------------------------------

    const inject = ['slots']

    function apply(ctx) {
      // Warm the boot cache so the next launch paints the intro immediately.
      fetchState()
        .then((state) => writeCache(cacheFromState(state)))
        .catch(() => {})

      ctx.slots.inject(SLOT_OVERLAY, () =>
        ctx.slots.register(
          {
            name: SLOT_OVERLAY,
            id: 'dsh-startup-intro',
            order: 1000,
            label: () => '启动开场',
          },
          StartupOverlay,
        ),
      )

      ctx.slots.inject(SLOT_SETTINGS, () =>
        ctx.slots.register(
          {
            name: SLOT_SETTINGS,
            id: 'dsh-startup-intro',
            order: 42,
            label: () => '启动开场',
          },
          SettingsSection,
        ),
      )
    }

    return { inject, apply }
  },
})
