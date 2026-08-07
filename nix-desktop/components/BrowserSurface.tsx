import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PREVIEW_ANNOTATION_EVENT,
  PREVIEW_CAPTURE_EVENT,
  type PreviewAnnotation,
  type PreviewCapture,
  type PreviewRect,
} from '../lib/previewAnnotations'
import { cn } from '../lib/utils'

interface PreviewImage {
  toDataURL: () => string
}

interface ElectronWebview extends HTMLElement {
  src: string
  canGoBack: () => boolean
  canGoForward: () => boolean
  goBack: () => void
  goForward: () => void
  reload: () => void
  reloadIgnoringCache: () => void
  stop: () => void
  loadURL: (url: string) => Promise<void>
  getURL: () => string
  openDevTools: () => void
  setZoomFactor: (factor: number) => void
  getZoomFactor: () => number
  getWebContentsId: () => number
  capturePage: (rect?: PreviewRect) => Promise<PreviewImage>
  send: (channel: string, ...args: unknown[]) => void
}

interface LocalServer {
  port: number
  command: string
  pid: number | null
  url: string
}

interface Viewport {
  label: string
  width: number
  height: number
}

interface Props {
  cwd: string | null
  scopeKey: string | null
}

const VIEWPORTS: Viewport[] = [
  { label: 'iPhone 14', width: 390, height: 844 },
  { label: 'Pixel 7', width: 412, height: 915 },
  { label: 'iPad Mini', width: 768, height: 1024 },
  { label: 'Laptop', width: 1280, height: 800 },
  { label: 'Desktop', width: 1440, height: 900 },
]

const RECORDING_MIME_TYPES = ['video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp9', 'video/webm']

function normalizeUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw
  if (/^localhost(:\d+)?(\/|$)/i.test(raw) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(raw)) {
    return `http://${raw}`
  }
  if (/^:?\d{2,5}(\/|$)/.test(raw)) return `http://localhost${raw.startsWith(':') ? '' : ':'}${raw}`
  return `https://${raw}`
}

function eventDetail<T>(name: string, detail: T) {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

function readTheme() {
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback
  return {
    primary: read('--primary', '#2563eb'),
    foreground: read('--foreground', '#18181b'),
    background: read('--background', '#ffffff'),
    border: read('--border', 'rgba(24,24,27,.14)'),
    mutedForeground: read('--muted-foreground', '#71717a'),
    radius: read('--radius', '10px'),
    fontSans: styles.fontFamily || 'system-ui, sans-serif',
    fontMono: read('--font-mono', 'ui-monospace, monospace'),
  }
}

function buttonClass(active = false) {
  return cn(
    'grid size-7 shrink-0 place-items-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-30',
    active
      ? 'bg-primary/12 text-primary'
      : 'text-muted-foreground/70 hover:bg-accent hover:text-foreground',
  )
}

export default function BrowserSurface({ cwd, scopeKey }: Props) {
  const viewRef = useRef<ElectronWebview | null>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordingWebContentsId = useRef<number | null>(null)
  const recordingChunks = useRef<Blob[]>([])
  const recordingCanvas = useRef<HTMLCanvasElement | null>(null)
  const recordingContext = useRef<CanvasRenderingContext2D | null>(null)
  const [input, setInput] = useState('')
  const [current, setCurrent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [nav, setNav] = useState({ back: false, forward: false })
  const [webviewReady, setWebviewReady] = useState<boolean | null>(null)
  const [annotationActive, setAnnotationActive] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [recording, setRecording] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [viewport, setViewport] = useState<Viewport | null>(null)
  const [aspectLocked, setAspectLocked] = useState(false)
  const [servers, setServers] = useState<LocalServer[]>([])

  const persistKey = `nix:preview:${scopeKey || 'default'}`

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(persistKey) || 'null')
      const url = typeof saved?.url === 'string' ? saved.url : null
      setCurrent(url)
      setInput(url || '')
      setViewport(
        saved?.viewport &&
          Number.isFinite(saved.viewport.width) &&
          Number.isFinite(saved.viewport.height)
          ? saved.viewport
          : null,
      )
      setZoom(Number.isFinite(saved?.zoom) ? saved.zoom : 1)
    } catch {
      setCurrent(null)
      setInput('')
      setViewport(null)
      setZoom(1)
    }
  }, [persistKey])

  useEffect(() => {
    try {
      localStorage.setItem(persistKey, JSON.stringify({ url: current, viewport, zoom }))
    } catch {}
  }, [current, persistKey, viewport, zoom])

  const refreshServers = useCallback(async () => {
    try {
      const result = await window.nix?.previewListServers?.()
      setServers(Array.isArray(result) ? result : [])
    } catch {
      setServers([])
    }
  }, [])

  useEffect(() => {
    if (current) return
    void refreshServers()
    const timer = setInterval(refreshServers, 4000)
    return () => clearInterval(timer)
  }, [current, refreshServers])

  useEffect(() => {
    if (!moreOpen) return
    const close = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [moreOpen])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 3500)
    return () => clearTimeout(timer)
  }, [notice])

  const go = useCallback((value: string) => {
    const url = normalizeUrl(value)
    if (!url) return
    setError(null)
    setCurrent(url)
    setInput(url)
  }, [])

  useEffect(() => {
    if (!current) return
    const timer = setTimeout(() => {
      const view = viewRef.current as any
      setWebviewReady(Boolean(view && typeof view.loadURL === 'function'))
    }, 400)
    return () => clearTimeout(timer)
  }, [current])

  const completeAnnotation = useCallback(async (payload: any) => {
    const view = viewRef.current
    if (!view || payload?.type !== 'captured' || !payload.annotation) return
    try {
      const rect = payload.screenshotRect
        ? {
            x: Math.max(0, Math.floor(payload.screenshotRect.x)),
            y: Math.max(0, Math.floor(payload.screenshotRect.y)),
            width: Math.max(1, Math.ceil(payload.screenshotRect.width)),
            height: Math.max(1, Math.ceil(payload.screenshotRect.height)),
          }
        : undefined
      const image = await view.capturePage(rect)
      const dataUrl = image.toDataURL()
      const annotation: PreviewAnnotation = {
        ...payload.annotation,
        screenshot: {
          dataUrl,
          width: rect?.width || view.clientWidth,
          height: rect?.height || view.clientHeight,
        },
      }
      eventDetail(PREVIEW_ANNOTATION_EVENT, annotation)
      setNotice('Annotation attached to the composer.')
    } catch (captureError: any) {
      setError(captureError?.message || 'Could not capture the annotation.')
    } finally {
      view.send('nix-preview-annotation-captured')
      setAnnotationActive(false)
    }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !current) return
    const syncNav = () => {
      try {
        setNav({ back: view.canGoBack(), forward: view.canGoForward() })
        setZoom(view.getZoomFactor())
      } catch {}
    }
    const onStart = () => {
      setLoading(true)
      setError(null)
    }
    const onStop = () => {
      setLoading(false)
      syncNav()
    }
    const onNavigate = (event: any) => {
      if (event?.url) {
        setInput(event.url)
        setCurrent(event.url)
      }
      syncNav()
    }
    const onFail = (event: any) => {
      setLoading(false)
      if (event?.errorCode === -3) return
      setError(event?.errorDescription || 'Failed to load')
    }
    const onNewWindow = (event: any) => {
      event.preventDefault?.()
      if (event?.url) go(event.url)
    }
    const onIpc = (event: any) => {
      if (event?.channel !== 'nix-preview-annotation') return
      const payload = event.args?.[0]
      if (payload?.type === 'cancelled') {
        setAnnotationActive(false)
        return
      }
      void completeAnnotation(payload)
    }
    view.addEventListener('did-start-loading', onStart)
    view.addEventListener('did-stop-loading', onStop)
    view.addEventListener('did-navigate', onNavigate as EventListener)
    view.addEventListener('did-navigate-in-page', onNavigate as EventListener)
    view.addEventListener('did-fail-load', onFail as EventListener)
    view.addEventListener('new-window', onNewWindow as EventListener)
    view.addEventListener('ipc-message', onIpc as EventListener)
    try {
      view.setZoomFactor(zoom)
    } catch {}
    return () => {
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
      view.removeEventListener('did-navigate', onNavigate as EventListener)
      view.removeEventListener('did-navigate-in-page', onNavigate as EventListener)
      view.removeEventListener('did-fail-load', onFail as EventListener)
      view.removeEventListener('new-window', onNewWindow as EventListener)
      view.removeEventListener('ipc-message', onIpc as EventListener)
    }
  }, [completeAnnotation, current, go, zoom])

  useEffect(() => {
    const unsubscribe = window.nix?.onPreviewRecordingFrame?.((frame: any) => {
      const view = viewRef.current
      if (!recording || !view || frame?.webContentsId !== view.getWebContentsId()) return
      const context = recordingContext.current
      const canvas = recordingCanvas.current
      if (!context || !canvas || typeof frame.data !== 'string') return
      const image = new Image()
      image.onload = () => context.drawImage(image, 0, 0, canvas.width, canvas.height)
      image.src = `data:image/jpeg;base64,${frame.data}`
    })
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [recording])

  const changeZoom = useCallback((next: number) => {
    const factor = Math.max(0.25, Math.min(3, Math.round(next * 10) / 10))
    try {
      viewRef.current?.setZoomFactor(factor)
      setZoom(factor)
    } catch {}
  }, [])

  const toggleAnnotation = useCallback(() => {
    const view = viewRef.current
    if (!view || !current) return
    if (annotationActive) {
      view.send('nix-preview-annotation-cancel')
      setAnnotationActive(false)
    } else {
      view.send('nix-preview-annotation-start', readTheme())
      setAnnotationActive(true)
    }
  }, [annotationActive, current])

  const captureScreenshot = useCallback(async () => {
    const view = viewRef.current
    if (!view || !current || capturing) return
    setCapturing(true)
    try {
      const image = await view.capturePage()
      const capture: PreviewCapture = {
        id: `capture-${Date.now().toString(36)}`,
        name: `preview-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
        dataUrl: image.toDataURL(),
        mime: 'image/png',
      }
      eventDetail(PREVIEW_CAPTURE_EVENT, capture)
      setNotice('Screenshot attached to the composer.')
    } catch (captureError: any) {
      setError(captureError?.message || 'Could not capture the preview.')
    } finally {
      setCapturing(false)
    }
  }, [capturing, current])

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current
    if (!recorder) return
    try {
      if (recordingWebContentsId.current != null) {
        await window.nix?.previewStopRecording?.(recordingWebContentsId.current)
      }
    } catch {}
    const stopped = new Promise<void>((resolve) => {
      if (recorder.state === 'inactive') resolve()
      else recorder.addEventListener('stop', () => resolve(), { once: true })
    })
    if (recorder.state !== 'inactive') recorder.stop()
    await stopped
    const blob = new Blob(recordingChunks.current, { type: recorder.mimeType || 'video/webm' })
    if (blob.size > 0) {
      const data = await blob.arrayBuffer()
      const result = await window.nix?.previewSaveRecording?.(data, blob.type)
      if (result?.ok) setNotice(`Recording saved to ${result.path}`)
    }
    recorderRef.current = null
    recordingChunks.current = []
    recordingCanvas.current = null
    recordingContext.current = null
    recordingWebContentsId.current = null
    setRecording(false)
  }, [])

  const toggleRecording = useCallback(async () => {
    if (recording) {
      await stopRecording()
      return
    }
    const view = viewRef.current
    if (!view || !current) return
    try {
      const rect = view.getBoundingClientRect()
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(rect.width))
      canvas.height = Math.max(1, Math.round(rect.height))
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('Recording canvas is unavailable.')
      const mime = RECORDING_MIME_TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || 'video/webm'
      const recorder = new MediaRecorder(canvas.captureStream(12), {
        mimeType: mime,
        videoBitsPerSecond: 4_000_000,
      })
      recordingChunks.current = []
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size) recordingChunks.current.push(event.data)
      })
      recordingCanvas.current = canvas
      recordingContext.current = context
      recorderRef.current = recorder
      recorder.start(1000)
      const webContentsId = view.getWebContentsId()
      await window.nix?.previewStartRecording?.(webContentsId)
      recordingWebContentsId.current = webContentsId
      setRecording(true)
      setNotice('Browser recording started.')
    } catch (recordingError: any) {
      if (recorderRef.current?.state !== 'inactive') recorderRef.current?.stop()
      recorderRef.current = null
      setRecording(false)
      setError(recordingError?.message || 'Could not start browser recording.')
    }
  }, [current, recording, stopRecording])

  useEffect(
    () => () => {
      const recorder = recorderRef.current
      if (recorder && recorder.state !== 'inactive') recorder.stop()
      if (recordingWebContentsId.current != null) {
        void window.nix?.previewStopRecording?.(recordingWebContentsId.current)
      }
      recordingWebContentsId.current = null
    },
    [scopeKey],
  )

  const resizeFromPointer = useCallback(
    (event: React.PointerEvent, axis: 'width' | 'height' | 'both') => {
      if (!viewport) return
      event.preventDefault()
      const startX = event.clientX
      const startY = event.clientY
      const start = viewport
      const ratio = start.width / start.height
      const move = (moveEvent: PointerEvent) => {
        let width = axis === 'height' ? start.width : Math.round(start.width + moveEvent.clientX - startX)
        let height = axis === 'width' ? start.height : Math.round(start.height + moveEvent.clientY - startY)
        width = Math.max(240, Math.min(1920, width))
        height = Math.max(240, Math.min(1600, height))
        if (aspectLocked) {
          if (axis === 'height') width = Math.round(height * ratio)
          else height = Math.round(width / ratio)
        }
        setViewport({ label: 'Responsive', width, height })
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [aspectLocked, viewport],
  )

  const currentViewportStyle = useMemo(
    () =>
      viewport
        ? { width: `${viewport.width}px`, height: `${viewport.height}px` }
        : { width: '100%', height: '100%' },
    [viewport],
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex items-center gap-1 border-b border-border/60 px-1.5 py-1.5">
        <button type="button" disabled={!nav.back} onClick={() => viewRef.current?.goBack()} className={buttonClass()} title="Back">
          <BackIcon />
        </button>
        <button type="button" disabled={!nav.forward} onClick={() => viewRef.current?.goForward()} className={buttonClass()} title="Forward">
          <ForwardIcon />
        </button>
        <button
          type="button"
          disabled={!current}
          onClick={() => (loading ? viewRef.current?.stop() : viewRef.current?.reload())}
          className={buttonClass()}
          title={loading ? 'Stop' : 'Reload'}
        >
          {loading ? <StopIcon /> : <ReloadIcon />}
        </button>
        <form className="flex min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); go(input) }}>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setInput(current || '')
                event.currentTarget.blur()
              }
            }}
            placeholder="Search or enter URL"
            spellCheck={false}
            className="h-7 min-w-0 flex-1 rounded-md border border-border/60 bg-secondary/40 px-2.5 text-[12px] text-foreground placeholder:text-muted-foreground/40 outline-none focus:border-ring/50"
          />
        </form>
        <button type="button" disabled={!current} onClick={() => window.nix?.previewOpenExternal?.(current)} className={buttonClass()} title="Open in browser">
          <ExternalIcon />
        </button>
        <button type="button" disabled={!current || recording} onClick={toggleAnnotation} className={buttonClass(annotationActive)} title={annotationActive ? 'Cancel annotation' : 'Annotate preview'}>
          <AnnotateIcon />
        </button>
        <button type="button" disabled={!current || capturing || recording} onClick={captureScreenshot} className={buttonClass()} title="Attach screenshot">
          <CameraIcon />
        </button>
        <button type="button" disabled={!current || annotationActive} onClick={toggleRecording} className={buttonClass(recording)} title={recording ? 'Stop recording' : 'Record browser'}>
          <RecordIcon active={recording} />
        </button>
        <div ref={moreRef} className="relative">
          <button type="button" onClick={() => setMoreOpen((open) => !open)} className={buttonClass(moreOpen)} title="More browser controls">
            <MoreIcon />
          </button>
          {moreOpen && (
            <div className="absolute right-0 top-full z-50 mt-1.5 w-56 rounded-xl border border-border bg-popover p-1.5 text-[12px] shadow-xl">
              <MenuButton disabled={!current} onClick={() => { setMoreOpen(false); viewRef.current?.reloadIgnoringCache() }}>Hard reload</MenuButton>
              <MenuButton disabled={!current} onClick={() => { setMoreOpen(false); viewRef.current?.openDevTools() }}>Open DevTools</MenuButton>
              <MenuButton
                disabled={!current}
                onClick={() => {
                  setMoreOpen(false)
                  setViewport((value) => value ? null : { label: 'Responsive', width: 390, height: 844 })
                }}
              >
                {viewport ? 'Hide device toolbar' : 'Show device toolbar'}
              </MenuButton>
              <div className="my-1 h-px bg-border" />
              <div className="flex items-center justify-between rounded-md px-2 py-1">
                <span>Zoom</span>
                <div className="flex items-center gap-1">
                  <SmallButton label="Zoom out" onClick={() => changeZoom(zoom - 0.1)}>−</SmallButton>
                  <button type="button" onClick={() => changeZoom(1)} className="min-w-11 text-center tabular-nums text-muted-foreground hover:text-foreground">
                    {Math.round(zoom * 100)}%
                  </button>
                  <SmallButton label="Zoom in" onClick={() => changeZoom(zoom + 0.1)}>+</SmallButton>
                </div>
              </div>
              <div className="my-1 h-px bg-border" />
              <MenuButton onClick={async () => { setMoreOpen(false); await window.nix?.previewClearCookies?.(); viewRef.current?.reload() }}>Clear cookies</MenuButton>
              <MenuButton onClick={async () => { setMoreOpen(false); await window.nix?.previewClearCache?.(); viewRef.current?.reloadIgnoringCache() }}>Clear cache</MenuButton>
            </div>
          )}
        </div>
      </div>

      {loading && <div className="nix-progress h-0.5 w-full" />}

      {viewport && current && (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 bg-background/95 px-1.5 text-[11px]">
          <select
            value={VIEWPORTS.some((candidate) => candidate.label === viewport.label) ? viewport.label : 'Responsive'}
            onChange={(event) => {
              const selected = VIEWPORTS.find((candidate) => candidate.label === event.target.value)
              setViewport(selected || { ...viewport, label: 'Responsive' })
            }}
            className="h-7 min-w-0 max-w-28 rounded-md border border-border bg-background px-1.5 outline-none"
            aria-label="Device preset"
          >
            <option>Responsive</option>
            {VIEWPORTS.map((candidate) => <option key={candidate.label}>{candidate.label}</option>)}
          </select>
          <DimensionInput
            label="Width"
            value={viewport.width}
            onChange={(width) =>
              setViewport({
                ...viewport,
                label: 'Responsive',
                width,
                height: aspectLocked ? Math.round(width / (viewport.width / viewport.height)) : viewport.height,
              })
            }
          />
          <span className="text-muted-foreground">×</span>
          <DimensionInput
            label="Height"
            value={viewport.height}
            onChange={(height) =>
              setViewport({
                ...viewport,
                label: 'Responsive',
                width: aspectLocked ? Math.round(height * (viewport.width / viewport.height)) : viewport.width,
                height,
              })
            }
          />
          <button type="button" onClick={() => setAspectLocked((locked) => !locked)} className={buttonClass(aspectLocked)} title={aspectLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio'}>
            <LinkIcon />
          </button>
          <button type="button" onClick={() => setViewport({ ...viewport, label: 'Responsive', width: viewport.height, height: viewport.width })} className={buttonClass()} title="Rotate viewport">
            <RotateIcon />
          </button>
          <button type="button" onClick={() => setViewport(null)} className={cn(buttonClass(), 'ml-auto')} title="Close device toolbar">
            <CloseIcon />
          </button>
        </div>
      )}

      {!current ? (
        <div className="flex h-full min-h-0 flex-col overflow-y-auto px-5 py-8">
          <div className="m-auto flex w-full max-w-sm flex-col gap-3">
            <div>
              <div className="text-[13px] font-medium text-foreground">Local servers</div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground/70">
                Enter a URL above or choose a listening localhost port{cwd ? ` for ${cwd.split('/').pop()}` : ''}.
              </p>
            </div>
            {servers.length ? (
              <div className="overflow-hidden rounded-xl border border-border/70">
                {servers.map((server) => (
                  <button
                    key={server.port}
                    type="button"
                    onClick={() => go(server.url)}
                    className="flex w-full items-center justify-between border-b border-border/60 px-3 py-2.5 text-left last:border-b-0 hover:bg-accent"
                  >
                    <span>
                      <span className="block text-[12px] font-medium text-foreground">localhost:{server.port}</span>
                      <span className="block text-[10.5px] text-muted-foreground">{server.command}</span>
                    </span>
                    <ForwardIcon />
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-[11.5px] text-muted-foreground">
                No listening development servers found.
              </div>
            )}
            <button type="button" onClick={refreshServers} className="self-start rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">
              Refresh ports
            </button>
          </div>
        </div>
      ) : (
        <div ref={viewportRef} className={cn('relative min-h-0 flex-1 overflow-auto', viewport && 'bg-secondary/45 p-5')}>
          <div className={cn('relative mx-auto bg-white shadow-sm', !viewport && 'h-full')} style={currentViewportStyle}>
            <webview
              key={scopeKey || 'default'}
              ref={viewRef as any}
              src={current}
              partition="persist:nix-preview"
              allowpopups
              className="absolute inset-0 h-full w-full bg-white"
            />
            {viewport && (
              <>
                <div onPointerDown={(event) => resizeFromPointer(event, 'width')} className="absolute -right-1 top-0 z-20 h-full w-2 cursor-ew-resize" />
                <div onPointerDown={(event) => resizeFromPointer(event, 'height')} className="absolute bottom-[-4px] left-0 z-20 h-2 w-full cursor-ns-resize" />
                <div onPointerDown={(event) => resizeFromPointer(event, 'both')} className="absolute bottom-[-5px] right-[-5px] z-30 size-3 cursor-nwse-resize rounded-full border border-border bg-background shadow" />
              </>
            )}
          </div>
          {webviewReady === false && (
            <div className="absolute inset-0 grid place-items-center bg-background p-6 text-center">
              <div className="max-w-[250px]">
                <div className="text-[13px] font-medium text-foreground">Preview needs a restart</div>
                <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground/80">
                  Quit and reopen Nix so the embedded browser preload can initialize.
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {(error || notice) && (
        <div className={cn('flex shrink-0 items-center gap-2 border-t px-3 py-2 text-[11.5px]', error ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-primary/20 bg-primary/5 text-foreground')}>
          <span className="min-w-0 flex-1 truncate">{error || notice}</span>
          {error && current && <button type="button" onClick={() => viewRef.current?.reload()} className="font-medium">Retry</button>}
          <button type="button" onClick={() => { setError(null); setNotice(null) }} className="text-current/70">×</button>
        </div>
      )}
    </div>
  )
}

function MenuButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (!disabled) onClick()
      }}
      className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function SmallButton({ children, label, onClick }: { children: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className="grid size-6 place-items-center rounded border border-border hover:bg-accent">
      {children}
    </button>
  )
}

function DimensionInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <input
      type="number"
      min={240}
      max={1920}
      value={value}
      aria-label={label}
      onChange={(event) => {
        const next = Number(event.target.value)
        if (Number.isFinite(next)) onChange(Math.max(240, Math.min(1920, Math.round(next))))
      }}
      className="h-7 w-14 rounded-md border border-border bg-background px-1 text-center tabular-nums outline-none"
    />
  )
}

function BackIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>
}
function ForwardIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>
}
function ReloadIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 12a8 8 0 1 1-2.34-5.66L20 8.68M20 4v4.68h-4.68" /></svg>
}
function StopIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="1" /></svg>
}
function ExternalIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
}
function AnnotateIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m4 4 7.5 16 2.1-6.4L20 11.5 4 4Z" /><path d="m13.6 13.6 4.4 4.4" /></svg>
}
function CameraIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.5 4 16 7h4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h4l1.5-3h5Z" /><circle cx="12" cy="13" r="3" /></svg>
}
function RecordIcon({ active }: { active: boolean }) {
  return <span className={cn('block size-3 rounded-full border-2', active ? 'animate-pulse border-destructive bg-destructive' : 'border-current')} />
}
function MoreIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
}
function LinkIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></svg>
}
function RotateIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="7" y="7" width="10" height="10" rx="1" transform="rotate(-45 12 12)" /><path d="M12 2a10 10 0 0 1 8 4M20 2v4h-4M12 22a10 10 0 0 1-8-4M4 22v-4h4" /></svg>
}
function CloseIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m18 6-12 12M6 6l12 12" /></svg>
}
