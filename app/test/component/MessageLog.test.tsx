import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import MessageLog from '../../components/MessageLog'
import type { AgentCall, Conversation, Message } from '../../hooks/useParallax'

function conversation(messages: Message[]): Conversation {
  return {
    id: 'conv-component',
    title: 'Component test',
    messages,
    chatgptUrl: null,
    folderPath: '/tmp/project',
  }
}

describe('MessageLog work transcript', () => {
  test('groups commands beneath compact phase disclosures', async () => {
    const user = userEvent.setup()
    render(
      <MessageLog
        conversation={conversation([
          { role: 'user', text: 'Explain this project.' },
          {
            role: 'assistant',
            text: '',
            notes: [
              'I’m going to inspect the project metadata so I can identify the main entry points.',
              'I found the entry points. Next I’m tracing how messages move through the app.',
            ],
            calls: [
              { kind: 'read', label: 'read package.json', status: 'ok', result: '{}' },
              { kind: 'list', label: 'list src', status: 'ok', result: 'index.ts' },
              { kind: 'run', label: 'run pwd', status: 'ok', result: '/tmp/project' },
              { kind: 'run', label: 'run ls -la', status: 'ok', result: 'package.json' },
            ],
            steps: [
              {
                kind: 'note',
                text: 'I’m going to inspect the project metadata so I can identify the main entry points.',
              },
              { kind: 'call', index: 0 },
              { kind: 'call', index: 1 },
              {
                kind: 'note',
                text: 'I found the entry points. Next I’m tracing how messages move through the app.',
              },
              { kind: 'call', index: 2 },
              { kind: 'call', index: 3 },
            ],
          },
        ])}
      />,
    )

    const firstNote = screen.getByText(
      'I’m going to inspect the project metadata so I can identify the main entry points.',
    )
    expect(firstNote.closest('[data-agent-note]')).toBeInTheDocument()
    expect(firstNote.closest('[data-agent-note]')?.querySelector('.parallax-transcript-copy')).toBeInTheDocument()
    expect(
      screen.getByText('I found the entry points. Next I’m tracing how messages move through the app.'),
    ).toBeInTheDocument()

    const inspection = screen.getByRole('button', { name: 'Reading project files' })
    const commands = screen.getByRole('button', { name: 'Reading the repository structure' })
    expect(inspection).toHaveAttribute('aria-expanded', 'false')
    expect(commands).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('package.json', { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByText(/Ran \d+ tools/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Command details/i)).not.toBeInTheDocument()

    await user.click(inspection)
    expect(inspection).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('package.json', { exact: true })).toBeInTheDocument()
    expect(screen.getByText('src', { exact: true })).toBeInTheDocument()
    expect(screen.queryByText('pwd', { exact: true })).not.toBeInTheDocument()
    expect(document.querySelector('[data-tool-kind="read"] [data-activity-icon]')).toHaveAttribute(
      'title',
      'File read',
    )

    const packageRead = screen.getByRole('button', { name: 'File read: package.json' })
    expect(packageRead).toHaveAttribute('aria-expanded', 'false')
    await user.click(packageRead)
    await waitFor(() => expect(packageRead).toHaveAttribute('aria-expanded', 'true'))
    expect(document.querySelector('.parallax-code')).toHaveTextContent('{}')
  })

  test('represents every tool category with an icon instead of a text prefix', async () => {
    const user = userEvent.setup()
    render(
      <MessageLog
        conversation={conversation([
          {
            role: 'assistant',
            text: '',
            notes: ['Using the workspace tools'],
            calls: [
              { kind: 'read', label: 'src/app.ts', status: 'ok', result: 'export {}' },
              { kind: 'list', label: 'src', status: 'ok', result: 'app.ts' },
              { kind: 'search', label: '"needle" in src', status: 'ok', result: 'src/app.ts:1' },
              { kind: 'run', label: 'pnpm test', status: 'ok', result: 'passed' },
              { kind: 'write', label: 'src/app.ts', status: 'ok', result: 'Wrote src/app.ts.' },
            ],
          },
        ])}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Updating project files' }))

    const expectedTitles = {
      read: 'File read',
      list: 'Directory listing',
      search: 'Search',
      run: 'Shell command',
      write: 'File write',
    }
    for (const [kind, title] of Object.entries(expectedTitles)) {
      expect(
        document.querySelector(`[data-tool-kind="${kind}"] [data-activity-icon]`),
      ).toHaveAttribute('title', title)
    }
    expect(screen.getByText('pnpm test', { exact: true })).toBeInTheDocument()
    expect(screen.queryByText('run pnpm test', { exact: true })).not.toBeInTheDocument()
  })

  test('keeps each progress update attached to the action batch it introduces', () => {
    render(
      <MessageLog
        conversation={conversation([
          { role: 'user', text: 'Inspect the implementation.' },
          {
            role: 'assistant',
            text: '',
            notes: ['I’m going to read the entry point first so I can map the runtime flow.'],
            calls: [{ kind: 'read', label: 'read src/index.ts', status: 'ok', result: 'export {}' }],
          },
          {
            role: 'assistant',
            text: '',
            notes: ['I found the entry point. Next I’m reading the transport implementation.'],
            calls: [{ kind: 'read', label: 'read src/transport.ts', status: 'ok', result: 'export {}' }],
          },
        ])}
      />,
    )

    const phases = document.querySelectorAll('[data-activity-phase]')
    expect(phases).toHaveLength(2)
    expect(phases[0]).toHaveTextContent(
      'I’m going to read the entry point first so I can map the runtime flow.',
    )
    expect(phases[0]).not.toHaveTextContent(
      'I found the entry point. Next I’m reading the transport implementation.',
    )
    expect(phases[1]).toHaveTextContent(
      'I found the entry point. Next I’m reading the transport implementation.',
    )
  })

  test('keeps an individual command result collapsed when its diff arrives', async () => {
    const user = userEvent.setup()
    const initial: Message = {
      role: 'assistant',
      text: '',
      calls: [{ kind: 'write', label: 'write src/config.ts', status: 'running' }],
    }
    const { rerender } = render(<MessageLog conversation={conversation([initial])} />)

    const phase = screen.getByRole('button', { name: 'Updating project files' })
    await user.click(phase)
    expect(screen.getByText('src/config.ts')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'File write: src/config.ts' })).not.toBeInTheDocument()

    rerender(
      <MessageLog
        conversation={conversation([
          {
            ...initial,
            calls: [
              {
                kind: 'write',
                label: 'write src/config.ts',
                status: 'ok',
                result: 'Wrote src/config.ts.',
                diff: '--- /dev/null\n+++ b/src/config.ts\n+new',
              },
            ],
          },
        ])}
      />,
    )

    expect(screen.getByRole('button', { name: 'File write: src/config.ts' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    // The body is pre-mounted behind the collapsed grid so opening it never waits
    // for a large result or syntax-highlighted diff to render.
    expect(screen.getByText('+new')).toBeInTheDocument()
    expect(screen.queryByText('--- /dev/null')).not.toBeInTheDocument()
    expect(screen.queryByText('+++ b/src/config.ts')).not.toBeInTheDocument()
  })

  test('hides historical retry duplicates and never exposes partial protocol text', () => {
    render(
      <MessageLog
        conversation={conversation([
          {
            role: 'user',
            text: 'inspect repository',
            msgId: '1784845644410-one',
          },
          {
            role: 'user',
            text: 'inspect repository',
            msgId: '1784845664746-two',
          },
          {
            role: 'assistant',
            text: '{plx:run}cat package.json',
            streaming: false,
          },
        ])}
      />,
    )

    expect(screen.getAllByText('inspect repository')).toHaveLength(1)
    expect(
      screen.getByText(
        'The response ended before its next action was complete. Send the request again to continue.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('{plx:run}cat package.json')).not.toBeInTheDocument()
    expect(screen.queryByText(/can't parse/i)).not.toBeInTheDocument()
  })

  test('folds completed activity beneath its duration while keeping the final answer visible', async () => {
    const user = userEvent.setup()
    const startedAt = 1784845644410
    const calls = (label: string): AgentCall[] => [
      { kind: 'run', label: `run ${label}`, status: 'ok', result: 'done' },
    ]
    render(
      <MessageLog
        conversation={conversation([
          {
            role: 'user',
            text: 'Inspect the repository.',
            msgId: `${startedAt}-turn`,
          },
          {
            role: 'assistant',
            text: '',
            notes: ['I’m going to inspect the repository structure before reading its implementation.'],
            calls: calls('ls -la'),
          },
          { role: 'assistant', text: '', calls: calls('cat package.json') },
          { role: 'assistant', text: '', calls: calls('pnpm test') },
          {
            role: 'assistant',
            text: 'The repository is healthy.',
            completedAt: startedAt + 18_000,
          },
        ])}
      />,
    )

    const fold = screen.getByRole('button', { name: 'Worked for 18s' })
    expect(fold).toHaveAttribute('aria-expanded', 'false')
    expect(fold).toHaveClass('parallax-turn-fold-label')
    expect(fold).not.toHaveClass('text-xs')
    expect(document.querySelectorAll('[data-activity-stream]')).toHaveLength(0)
    expect(
      screen.queryByText('I’m going to inspect the repository structure before reading its implementation.'),
    ).not.toBeInTheDocument()
    expect(screen.getByText('The repository is healthy.')).toBeInTheDocument()

    await user.click(fold)
    expect(fold).toHaveAttribute('aria-expanded', 'true')
    expect(document.querySelectorAll('[data-activity-phase]')).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Reading the repository structure' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Working through the task' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Running verification' })).toBeInTheDocument()
    expect(
      screen.getByText('I’m going to inspect the repository structure before reading its implementation.'),
    ).toBeInTheDocument()
  })

  test('merges repeated legacy phases, drops recovered debris, and deduplicates commands', async () => {
    const user = userEvent.setup()
    const repeated: Message = {
      role: 'assistant',
      text: '',
      notes: ["I'll map the project structure first, then trace the main execution path."],
      calls: [{ kind: 'run', label: 'run ls -la', status: 'ok', result: 'package.json' }],
    }
    render(
      <MessageLog
        conversation={conversation([
          { role: 'user', text: 'Explain this repository.' },
          repeated,
          repeated,
          { role: 'assistant', text: "{plx:note}I'll map the project structure first{/parallax" },
          repeated,
          { role: 'assistant', text: 'The project is a desktop application.' },
        ])}
      />,
    )

    const fold = screen.getByRole('button', { name: 'Worked' })
    expect(fold).toHaveAttribute('aria-expanded', 'false')
    await user.click(fold)
    const phase = screen.getByRole('button', { name: 'Reading the repository structure' })
    expect(screen.getAllByText('Reading the repository structure')).toHaveLength(1)
    expect(document.querySelectorAll('[data-turn-fold]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-activity-phase]')).toHaveLength(1)
    expect(
      screen.queryByText(
        'The response ended before its next action was complete. Send the request again to continue.',
      ),
    ).not.toBeInTheDocument()
    expect(screen.getAllByText(/I'll map the project structure/i)).toHaveLength(1)
    expect(screen.queryByText('ls -la', { exact: true })).not.toBeInTheDocument()

    await user.click(phase)
    expect(screen.getAllByText('ls -la', { exact: true })).toHaveLength(1)
  })

  test('shimmers only the latest activity phase while work is in progress', () => {
    render(
      <MessageLog
        sending
        conversation={conversation([
          {
            role: 'assistant',
            text: '',
            notes: [
              'I’m going to inspect the repository structure so I can locate the relevant files.',
              'I found the top-level layout. Next I’m searching for the message flow.',
            ],
            calls: [
              { kind: 'run', label: 'run ls -la', status: 'ok', result: 'package.json' },
              { kind: 'search', label: 'search message flow', status: 'running' },
            ],
            steps: [
              {
                kind: 'note',
                text: 'I’m going to inspect the repository structure so I can locate the relevant files.',
              },
              { kind: 'call', index: 0 },
              {
                kind: 'note',
                text: 'I found the top-level layout. Next I’m searching for the message flow.',
              },
              { kind: 'call', index: 1 },
            ],
          },
        ])}
      />,
    )

    const phases = document.querySelectorAll('[data-activity-phase]')
    expect(phases).toHaveLength(2)
    expect(phases[0]).toHaveAttribute('data-active', 'false')
    expect(phases[1]).toHaveAttribute('data-active', 'true')
    expect(
      screen.getByRole('button', { name: 'Reading the repository structure' })
        .querySelector('.parallax-phase-title'),
    ).not.toHaveClass('parallax-shimmer')
    expect(
      screen.getByRole('button', { name: 'Searching the codebase' })
        .querySelector('.parallax-phase-title'),
    ).toHaveClass('parallax-shimmer')
  })

  test('shows Thinking once before initial progress and never brings it back mid-turn', () => {
    const userMessage: Message = {
      role: 'user',
      text: 'Inspect this repository.',
      msgId: 'user-pending',
      delivery: 'pending',
    }
    const { rerender } = render(
      <MessageLog sending conversation={conversation([userMessage])} />,
    )

    expect(screen.getByLabelText('Thinking')).toBeInTheDocument()
    expect(document.querySelector('[data-delivery="pending"]')).toBeInTheDocument()

    rerender(
      <MessageLog
        sending
        conversation={conversation([
          userMessage,
          {
            role: 'assistant',
            text: '{plx:no',
            streaming: true,
          },
        ])}
      />,
    )
    expect(screen.getByLabelText('Thinking')).toBeInTheDocument()

    const activity: Message = {
      role: 'assistant',
      text: '',
      notes: ['Reading the repository structure'],
      calls: [{ kind: 'run', label: 'run ls -la', status: 'running' }],
    }
    rerender(
      <MessageLog
        sending
        conversation={conversation([userMessage, activity])}
      />,
    )
    expect(screen.queryByLabelText('Thinking')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reading the repository structure' })).toBeInTheDocument()

    rerender(
      <MessageLog
        sending
        conversation={conversation([
          userMessage,
          activity,
          {
            role: 'assistant',
            text: '{plx:note}Understanding potential',
            streaming: true,
          },
        ])}
      />,
    )
    expect(screen.queryByLabelText('Thinking')).not.toBeInTheDocument()
  })

  test('uses one visual row contract for thinking, phases, and commands', async () => {
    const user = userEvent.setup()
    const userMessage: Message = {
      role: 'user',
      text: 'Inspect this repository.',
      msgId: 'user-row-contract',
      delivery: 'pending',
    }
    const { rerender } = render(
      <MessageLog sending conversation={conversation([userMessage])} />,
    )

    const thinking = document.querySelector('[data-activity-row="thinking"]')
    expect(thinking).toHaveClass('parallax-activity-row', 'parallax-thinking-row')
    expect(thinking?.querySelector('.parallax-thinking-label')).toHaveClass('parallax-thinking-pulse')
    expect(thinking?.querySelector('.parallax-activity-tertiary')).toHaveClass('h-6', 'w-[4.25rem]')
    expect(thinking?.querySelector('.parallax-shimmer')).toHaveTextContent('Thinking')

    rerender(
      <MessageLog
        sending
        conversation={conversation([
          userMessage,
          {
            role: 'assistant',
            text: '',
            notes: ['Reading the repository structure'],
            calls: [
              {
                kind: 'run',
                label: 'run ls -la',
                status: 'running',
                result: 'package.json',
              },
            ],
          },
        ])}
      />,
    )

    const phase = document.querySelector('[data-activity-row="phase"]')
    expect(phase).toHaveClass('parallax-activity-row')
    expect(phase).toHaveClass('parallax-phase-trigger', 'gap-1')
    expect(phase).not.toHaveClass('parallax-activity-interactive')
    const phaseTitle = phase?.querySelector('.parallax-phase-title')
    const phaseChevron = phase?.querySelector('[data-activity-icon]')
    expect(phaseTitle?.nextElementSibling).toBe(phaseChevron)
    expect(phaseChevron).toHaveClass('opacity-0', 'group-hover/phase:opacity-100')

    await user.click(screen.getByRole('button', { name: 'Reading the repository structure' }))
    const tool = document.querySelector('[data-activity-row="tool"]')
    expect(tool).toHaveClass('parallax-activity-row')
  })

  test('renders denied command status with the destructive color', async () => {
    const user = userEvent.setup()
    render(
      <MessageLog
        conversation={conversation([
          {
            role: 'assistant',
            text: '',
            notes: ['Running a requested command'],
            calls: [{
              kind: 'run',
              label: 'run touch README.md',
              status: 'denied',
              result: 'Denied by the user.',
            }],
          },
        ])}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Working through the task' }))
    const deniedMarks = document.querySelectorAll('[data-tool-status="denied"]')
    expect(deniedMarks.length).toBeGreaterThan(0)
    deniedMarks.forEach(mark => {
      expect(mark).toHaveClass('parallax-tool-status-error')
      expect(mark).not.toHaveClass('parallax-activity-tertiary')
    })
  })

  test('copies a terminal command together with its output from the expanded result', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <MessageLog
        conversation={conversation([
          {
            role: 'assistant',
            text: '',
            notes: ['Reading the repository structure'],
            calls: [{
              kind: 'run',
              label: 'run ls -la',
              status: 'ok',
              result: '$ ls -la\nREADME.md\n[exit 0]',
            }],
          },
        ])}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Reading the repository structure' }))
    const command = screen.getByRole('button', { name: 'Shell command: ls -la' })
    await user.click(command)
    const copy = screen.getByRole('button', { name: 'Copy command and output' })
    expect(copy).toHaveClass(
      'opacity-0',
      'group-hover/tool:opacity-100',
      'group-focus-within/tool:opacity-100',
    )

    await user.click(copy)
    expect(writeText).toHaveBeenCalledWith('$ ls -la\nREADME.md\n[exit 0]')
    expect(command).toHaveAttribute('aria-expanded', 'true')
  })

  test('syntax highlights source printed by a shell file-read command', async () => {
    const user = userEvent.setup()
    const command = "sed -n '1,40p' src/example.js"
    render(
      <MessageLog
        conversation={conversation([
          {
            role: 'assistant',
            text: '',
            notes: ['Inspecting the source file'],
            calls: [{
              kind: 'run',
              label: command,
              status: 'ok',
              result: `$ ${command}\nconst answer = 42\nfunction readAnswer() { return answer }\n[exit 0]`,
            }],
          },
        ])}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Working through the task' }))
    await user.click(screen.getByRole('button', { name: `Shell command: ${command}` }))

    const output = document.querySelector('[data-tool-language="javascript"]')
    expect(output).toHaveClass('parallax-code')
    expect(output).toHaveTextContent('const answer = 42')
    expect(output).not.toHaveTextContent(`$ ${command}`)
    expect(output).not.toHaveTextContent('[exit 0]')
    expect(output?.querySelector('.hljs-keyword')).toHaveTextContent('const')
    expect(output?.closest('[data-activity-rule]')).toHaveClass('parallax-tool-result-surface')
  })

  test('mounts a completed command output in the same disclosure update', async () => {
    const user = userEvent.setup()
    render(
      <MessageLog
        conversation={conversation([
          {
            role: 'assistant',
            text: '',
            notes: ['Reading the repository structure'],
            calls: [
              {
                kind: 'run',
                label: 'run ls -la',
                status: 'ok',
                result: 'completed immediately',
              },
            ],
          },
        ])}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Reading the repository structure' }))
    const command = screen.getByRole('button', { name: 'Shell command: ls -la' })
    await user.click(command)
    expect(screen.getByText('completed immediately')).toBeInTheDocument()
    expect(document.querySelector('[data-tool-disclosure]')).toHaveClass('block')
  })

  test('keeps an open command mounted while its streamed result becomes final', async () => {
    const user = userEvent.setup()
    const running: Message = {
      role: 'assistant',
      text: '',
      notes: ['Reading the repository structure'],
      calls: [{
        kind: 'run',
        label: 'run ls -la',
        status: 'running',
        result: '$ ls -la\n',
      }],
    }
    const { rerender } = render(
      <MessageLog sending conversation={conversation([running])} />,
    )

    await user.click(screen.getByRole('button', { name: 'Reading the repository structure' }))
    await user.click(screen.getByRole('button', { name: 'Shell command: ls -la' }))
    expect(screen.getByRole('button', { name: 'Shell command: ls -la' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )

    rerender(
      <MessageLog
        conversation={conversation([{
          ...running,
          calls: [{
            kind: 'run',
            label: 'run ls -la',
            status: 'ok',
            result: '$ ls -la\nREADME.md\n[exit 0]',
          }],
        }])}
      />,
    )

    expect(screen.getByRole('button', { name: 'Shell command: ls -la' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByText(/README\.md/)).toBeInTheDocument()
  })

  test('smooths every network snapshot with bounded timers rather than animation frames', () => {
    vi.useFakeTimers()
    const frameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 1)
    try {
      const first = 'A streamed answer'
      const complete = 'A streamed answer should advance with each network snapshot.'
      const { rerender } = render(
        <MessageLog
          sending
          conversation={conversation([
            { role: 'user', text: 'Explain this.' },
            { role: 'assistant', text: first, streaming: true },
          ])}
        />,
      )

      const copy = document.querySelector('[data-streaming-copy]') as HTMLElement
      expect(copy).toHaveTextContent('A')
      act(() => vi.advanceTimersByTime(120))
      expect(copy).toHaveTextContent(first)

      rerender(
        <MessageLog
          sending
          conversation={conversation([
            { role: 'user', text: 'Explain this.' },
            { role: 'assistant', text: complete, streaming: true },
          ])}
        />,
      )
      expect(copy).not.toHaveTextContent(complete)
      act(() => vi.advanceTimersByTime(120))
      expect(copy).toHaveTextContent(complete)
      expect(frameSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  test('renders Markdown before a streamed response is complete', () => {
    vi.useFakeTimers()
    try {
      render(
        <MessageLog
          sending
          conversation={conversation([
            { role: 'user', text: 'Explain this.' },
            {
              role: 'assistant',
              text: 'This is **important** while the answer is still streaming.',
              streaming: true,
            },
          ])}
        />,
      )

      act(() => vi.advanceTimersByTime(120))
      const copy = document.querySelector('[data-streaming-copy]') as HTMLElement
      expect(copy.querySelector('strong')).toHaveTextContent('important')
    } finally {
      vi.useRealTimers()
    }
  })

  test('opens an inline editor for a user message and cancels without changing it', async () => {
    const user = userEvent.setup()
    render(
      <MessageLog
        conversation={conversation([
          {
            role: 'user',
            text: 'Explain this repository.',
            msgId: 'message-to-edit',
          },
        ])}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Edit message' }))

    const editor = screen.getByRole('textbox', { name: 'Edit message text' })
    expect(editor).toHaveFocus()
    expect(editor).toHaveValue('Explain this repository.')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

    await user.clear(editor)
    await user.type(editor, 'Explain the current implementation.')
    expect(editor).toHaveValue('Explain the current implementation.')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('textbox', { name: 'Edit message text' })).not.toBeInTheDocument()
    expect(screen.getByText('Explain this repository.')).toBeInTheDocument()
  })

  test('exposes the update interaction when message editing is connected', async () => {
    const user = userEvent.setup()
    const onEditMessage = vi.fn()
    render(
      <MessageLog
        onEditMessage={onEditMessage}
        conversation={conversation([
          {
            role: 'user',
            text: 'Inspect the repository.',
            msgId: 'connected-message',
          },
        ])}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Edit message' }))
    const editor = screen.getByRole('textbox', { name: 'Edit message text' })
    const update = screen.getByRole('button', { name: 'Send' })
    expect(update).toBeDisabled()

    await user.clear(editor)
    await user.type(editor, 'Inspect the repository structure.')
    expect(update).toBeEnabled()
    await user.click(update)

    expect(onEditMessage).toHaveBeenCalledOnce()
    expect(onEditMessage).toHaveBeenCalledWith(
      'connected-message',
      'Inspect the repository structure.',
      'Inspect the repository.',
    )
    expect(screen.queryByRole('textbox', { name: 'Edit message text' })).not.toBeInTheDocument()
  })
})
