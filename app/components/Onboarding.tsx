import { useEffect, useRef, useState } from 'react'
import { cn } from '../lib/utils'

export const CHROME_WEB_STORE_URL =
  'https://chromewebstore.google.com/detail/parallax/bfnlhalnojbjoipblfnhhljffajanaei?authuser=0&hl=en-GB'
export const ONBOARDING_STORAGE_KEY = 'parallax:onboarding:v1'

export type OnboardingStep = 'welcome' | 'extension' | 'project' | 'message'

interface Props {
  initialStep: OnboardingStep
  connected: boolean
  serverReady: boolean
  currentFolder: string | null
  currentConvId: string | null
  onOpenStore: () => void | Promise<void>
  onCheckConnection: () => void
  onChooseProject: () => Promise<string | null>
  onSendFirstMessage: (message: string) => void
  onComplete: () => void
  onStepChange: (step: OnboardingStep) => void
}

const SETUP_STEPS: Array<{ id: Exclude<OnboardingStep, 'welcome'>; label: string }> = [
  { id: 'extension', label: 'Connect' },
  { id: 'project', label: 'Project' },
  { id: 'message', label: 'Message' },
]

const MESSAGE_EXAMPLES = [
  'Explain how this repository is structured.',
  'Find the main entry point and tell me how to run this project.',
]

export default function Onboarding({
  initialStep,
  connected,
  serverReady,
  currentFolder,
  currentConvId,
  onOpenStore,
  onCheckConnection,
  onChooseProject,
  onSendFirstMessage,
  onComplete,
  onStepChange,
}: Props) {
  const [step, setStep] = useState<OnboardingStep>(
    initialStep === 'message' && !currentFolder ? 'project' : initialStep,
  )
  const [choosingFolder, setChoosingFolder] = useState(false)
  const [folderError, setFolderError] = useState('')
  const [message, setMessage] = useState('')
  const messageRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (step !== 'message') return
    const timer = window.setTimeout(() => messageRef.current?.focus(), 260)
    return () => window.clearTimeout(timer)
  }, [step])

  function moveTo(next: OnboardingStep) {
    setStep(next)
    onStepChange(next)
  }

  async function chooseProject() {
    setChoosingFolder(true)
    setFolderError('')
    try {
      const path = await onChooseProject()
      if (!path) {
        setFolderError('No folder selected. Choose a repository when you are ready.')
        return
      }
      moveTo('message')
    } finally {
      setChoosingFolder(false)
    }
  }

  function sendFirstMessage() {
    const text = message.trim()
    if (!text || !connected || !currentConvId) return
    onSendFirstMessage(text)
    onComplete()
  }

  const setupIndex = SETUP_STEPS.findIndex((item) => item.id === step)
  const projectName = currentFolder?.split('/').filter(Boolean).pop() || 'your project'

  return (
    <main
      className="relative isolate flex h-screen min-h-[620px] flex-col overflow-hidden bg-background text-foreground"
      aria-label="Welcome to Parallax"
      data-onboarding-step={step}
    >
      <header
        className="drag-region flex h-[var(--workspace-topbar-height)] shrink-0 items-center border-b border-border/70 px-5"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2.5">
          <ParallaxMark className="size-5 text-foreground" />
          <span className="text-[13px] font-semibold tracking-[-0.01em]">Parallax</span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 py-8 sm:px-10">
        <section className="parallax-onboarding-shell w-full max-w-[820px] overflow-hidden rounded-[20px] border border-border/80 bg-card">
          {step !== 'welcome' && (
            <div className="flex h-12 items-center justify-between border-b border-border/70 px-7 sm:px-11">
              <ol className="flex items-center gap-2.5" aria-label="Onboarding progress">
                {SETUP_STEPS.map((item, index) => {
                  const current = item.id === step
                  const complete = index < setupIndex
                  return (
                    <li key={item.id} className="flex items-center gap-2.5">
                      <span
                        aria-current={current ? 'step' : undefined}
                        className={cn(
                          'text-[10.5px] font-medium transition-colors',
                          current ? 'text-foreground' : complete ? 'text-muted-foreground' : 'text-muted-foreground/40',
                        )}
                      >
                        {item.label}
                      </span>
                      {index < SETUP_STEPS.length - 1 && (
                        <span
                          className={cn(
                            'h-px w-4 transition-colors',
                            complete ? 'bg-primary/65' : 'bg-border',
                          )}
                          aria-hidden
                        />
                      )}
                    </li>
                  )
                })}
              </ol>
              <span className="text-[10px] font-medium tabular-nums text-muted-foreground/60">
                {setupIndex + 1} / {SETUP_STEPS.length}
              </span>
            </div>
          )}
          <div key={step} className="parallax-onboarding-step min-h-[470px]">
            {step === 'welcome' && (
              <WelcomeStep onContinue={() => moveTo('extension')} />
            )}

            {step === 'extension' && (
              <ExtensionStep
                connected={connected}
                serverReady={serverReady}
                onOpenStore={onOpenStore}
                onCheckConnection={onCheckConnection}
                onBack={() => moveTo('welcome')}
                onContinue={() => moveTo('project')}
              />
            )}

            {step === 'project' && (
              <ProjectStep
                choosing={choosingFolder}
                error={folderError}
                onChoose={() => void chooseProject()}
                onBack={() => moveTo('extension')}
              />
            )}

            {step === 'message' && (
              <MessageStep
                connected={connected}
                projectName={projectName}
                ready={Boolean(currentConvId && currentFolder)}
                message={message}
                messageRef={messageRef}
                onMessage={setMessage}
                onExample={setMessage}
                onBack={() => moveTo('project')}
                onReconnect={() => moveTo('extension')}
                onSend={sendFirstMessage}
              />
            )}
          </div>
        </section>
      </div>
    </main>
  )
}

function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="grid min-h-[470px] gap-10 p-7 sm:grid-cols-[1.08fr_0.92fr] sm:p-12">
      <div className="flex flex-col justify-center">
        <h1 className="max-w-md text-[34px] font-semibold leading-[1.06] tracking-[-0.04em] text-foreground sm:text-[42px]">
          Your repository, one conversation away.
        </h1>
        <p className="mt-5 max-w-[430px] text-[14px] leading-6 text-muted-foreground">
          Choose a repository. Parallax keeps its conversations with the code and sends work through the ChatGPT account already open in Chrome.
        </p>
        <button
          type="button"
          onClick={onContinue}
          className="mt-7 flex h-10 w-fit items-center gap-2 rounded-xl bg-primary px-4 text-[13px] font-semibold text-primary-foreground shadow-xs transition-transform hover:-translate-y-px"
        >
          Get started
          <ArrowRightIcon />
        </button>
      </div>
      <div className="flex items-center justify-center">
        <div className="parallax-onboarding-route relative w-full max-w-[310px] border-y border-border/80 py-2">
          <RouteNode icon={<ChromeIcon />} title="ChatGPT in Chrome" detail="Your existing account" />
          <RouteNode icon={<FolderIcon />} title="A repository on your Mac" detail="The boundary for local work" />
          <RouteNode icon={<MessageIcon />} title="One useful first task" detail="The conversation starts here" />
        </div>
      </div>
    </div>
  )
}

function ExtensionStep({
  connected,
  serverReady,
  onOpenStore,
  onCheckConnection,
  onBack,
  onContinue,
}: {
  connected: boolean
  serverReady: boolean
  onOpenStore: () => void | Promise<void>
  onCheckConnection: () => void
  onBack: () => void
  onContinue: () => void
}) {
  return (
    <div className="flex min-h-[470px] flex-col p-7 sm:p-11">
      <div className="mx-auto w-full max-w-[560px] flex-1">
        <div className="mb-6 text-muted-foreground">
          <ExtensionIcon />
        </div>
        <h1 className="text-[27px] font-semibold tracking-[-0.025em]">Connect Chrome</h1>
        <p className="mt-2 max-w-lg text-[14px] leading-6 text-muted-foreground">
          Install the extension in the Chrome profile where you are signed in to ChatGPT. Parallax will detect it automatically.
        </p>

        <button
          type="button"
          onClick={() => void onOpenStore()}
          className="mt-6 flex h-10 items-center gap-2 rounded-xl border border-border bg-background px-4 text-[13px] font-semibold text-foreground transition-colors hover:bg-accent"
        >
          <ChromeIcon />
          Open Chrome Web Store
          <ExternalIcon />
        </button>

        <div
          className={cn(
            'mt-7 flex items-start gap-3 rounded-2xl border px-4 py-3.5',
            connected
              ? 'border-success/25 bg-success/8'
              : 'border-border bg-muted/25',
          )}
          aria-live="polite"
          data-extension-status={connected ? 'connected' : 'waiting'}
        >
          <span className="relative mt-1 flex size-2.5 shrink-0">
            {!connected && <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/45" />}
            <span className={cn('relative inline-flex size-2.5 rounded-full', connected ? 'bg-success' : 'bg-primary')} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">
              {connected ? 'Extension connected' : serverReady ? 'Waiting for the extension' : 'Starting the local bridge'}
            </div>
            <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">
              {connected
                ? 'Chrome and Parallax can now exchange tasks on this Mac.'
                : 'After installing, click the Parallax extension, enable the local bridge, then open ChatGPT once.'}
            </p>
          </div>
          {!connected && (
            <button
              type="button"
              onClick={onCheckConnection}
              className="shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Check again
            </button>
          )}
        </div>
      </div>
      <StepFooter onBack={onBack}>
        <button
          type="button"
          onClick={onContinue}
          disabled={!connected}
          className="flex h-9 items-center gap-2 rounded-xl bg-primary px-4 text-[12.5px] font-semibold text-primary-foreground transition-[opacity,transform] hover:-translate-y-px disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-35"
        >
          Continue
          <ArrowRightIcon />
        </button>
      </StepFooter>
    </div>
  )
}

function ProjectStep({
  choosing,
  error,
  onChoose,
  onBack,
}: {
  choosing: boolean
  error: string
  onChoose: () => void
  onBack: () => void
}) {
  return (
    <div className="flex min-h-[470px] flex-col p-7 sm:p-11">
      <div className="mx-auto flex w-full max-w-[560px] flex-1 flex-col justify-center">
        <div className="mb-6 text-muted-foreground">
          <FolderIcon />
        </div>
        <h1 className="text-[27px] font-semibold tracking-[-0.025em]">Choose a repository</h1>
        <p className="mt-2 max-w-lg text-[14px] leading-6 text-muted-foreground">
          This folder becomes your first project. Parallax keeps its threads together and limits workspace actions to the selected folder.
        </p>
        <button
          type="button"
          onClick={onChoose}
          disabled={choosing}
          className="mt-7 flex h-11 w-fit items-center gap-2.5 rounded-xl bg-primary px-4 text-[13px] font-semibold text-primary-foreground transition-transform hover:-translate-y-px disabled:translate-y-0 disabled:opacity-60"
        >
          <FolderPlusIcon />
          {choosing ? 'Opening folder picker…' : 'Choose a project folder'}
        </button>
        {error && <p className="mt-3 text-[12px] text-muted-foreground" role="status">{error}</p>}
        <div className="mt-7 flex items-start gap-2.5 text-[11.5px] leading-5 text-muted-foreground/75">
          <LockIcon />
          <span>The full folder path stays on your Mac. ChatGPT receives only the folder name used for its matching project.</span>
        </div>
      </div>
      <StepFooter onBack={onBack} />
    </div>
  )
}

function MessageStep({
  connected,
  projectName,
  ready,
  message,
  messageRef,
  onMessage,
  onExample,
  onBack,
  onReconnect,
  onSend,
}: {
  connected: boolean
  projectName: string
  ready: boolean
  message: string
  messageRef: React.RefObject<HTMLTextAreaElement>
  onMessage: (message: string) => void
  onExample: (message: string) => void
  onBack: () => void
  onReconnect: () => void
  onSend: () => void
}) {
  return (
    <div className="flex min-h-[470px] flex-col p-7 sm:p-11">
      <div className="mx-auto w-full max-w-[600px] flex-1">
        <div className="flex items-center gap-3 border-b border-border/70 pb-4 text-[11px] font-medium text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5">
            <FolderIcon />
            <span className="truncate">{projectName}</span>
          </span>
          <span className="h-3 w-px bg-border" aria-hidden />
          <span className="flex items-center gap-1.5">
            <span className={cn('size-1.5 rounded-full', connected ? 'bg-success' : 'bg-destructive')} />
            {connected ? 'Chrome connected' : 'Chrome disconnected'}
          </span>
        </div>
        <h1 className="mt-5 text-[27px] font-semibold tracking-[-0.025em]">Send your first message</h1>
        <p className="mt-2 text-[14px] leading-6 text-muted-foreground">
          Start with something useful. Parallax will create the matching ChatGPT project and keep the work attached to this repository.
        </p>

        <div className="mt-6 rounded-[20px] border border-border bg-background p-1.5 shadow-xs focus-within:border-primary/45">
          <textarea
            ref={messageRef}
            value={message}
            onChange={(event) => onMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                onSend()
              }
            }}
            rows={3}
            placeholder="What would you like to do with this repository?"
            className="w-full resize-none bg-transparent px-3 py-2.5 text-[14px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/40"
            aria-label="First message"
          />
          <div className="flex items-center justify-between border-t border-border/70 px-2 py-1.5">
            <span className="text-[10.5px] text-muted-foreground/60">Enter to send · Shift Enter for a new line</span>
            <button
              type="button"
              onClick={onSend}
              disabled={!message.trim() || !connected || !ready}
              className="grid size-8 place-items-center rounded-full bg-primary text-primary-foreground transition-[opacity,transform] hover:-translate-y-px disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-30"
              aria-label="Send first message"
            >
              <ArrowUpIcon />
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {MESSAGE_EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => onExample(example)}
              className="rounded-md border border-border/70 bg-muted/25 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {example}
            </button>
          ))}
        </div>

        {!connected && (
          <button type="button" onClick={onReconnect} className="mt-4 text-[12px] font-semibold text-primary hover:underline">
            Reconnect Chrome before sending
          </button>
        )}
      </div>
      <StepFooter onBack={onBack} />
    </div>
  )
}

function StepFooter({ onBack, children }: { onBack: () => void; children?: React.ReactNode }) {
  return (
    <div className="mt-7 flex min-h-9 items-center justify-between border-t border-border/70 pt-5">
      <button
        type="button"
        onClick={onBack}
        className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <ArrowLeftIcon />
        Back
      </button>
      {children}
    </div>
  )
}

function RouteNode({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode
  title: string
  detail: string
}) {
  return (
    <div className="relative z-10 flex min-h-[84px] items-center gap-4 px-1">
      <span className="grid size-9 shrink-0 place-items-center rounded-full border border-border bg-card text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block text-[11px] text-muted-foreground">{detail}</span>
      </span>
    </div>
  )
}

function ParallaxMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden>
      <path d="M32 4v56" strokeWidth="7" opacity="0.34" />
      <path d="M10 10 32 32 54 32" strokeWidth="10" />
      <path d="M32 32 54 54" strokeWidth="10" opacity="0.3" />
    </svg>
  )
}

function ExtensionIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 2a3 3 0 0 0-3 3v2H6a3 3 0 0 0 0 6h3v3H6a3 3 0 0 0-3 3v2h18v-2a3 3 0 0 0-3-3h-3v-3h3a3 3 0 0 0 0-6h-3V5a3 3 0 0 0-3-3Z" /></svg>
}

function ChromeIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="3.5" /><path d="M20.5 7H12a5 5 0 0 0-4.4 2.6L4.3 4.8A10 10 0 0 1 20.5 7Z" /><path d="m7.6 9.6-4.2 7.2A10 10 0 0 0 12 22l4.3-7.4" /><path d="M16.3 14.6 20.5 7A10 10 0 0 1 12 22" /></svg>
}

function FolderIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
}

function FolderPlusIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /><path d="M12 10v6M9 13h6" /></svg>
}

function MessageIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /></svg>
}

function LockIcon() {
  return <svg className="mt-0.5 size-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="11" width="18" height="10" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
}

function CheckIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m5 12 4 4L19 6" /></svg>
}

function ExternalIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ml-1 text-muted-foreground" aria-hidden><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
}

function ArrowRightIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>
}

function ArrowLeftIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5M11 18l-6-6 6-6" /></svg>
}

function ArrowUpIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m5 12 7-7 7 7M12 19V5" /></svg>
}
