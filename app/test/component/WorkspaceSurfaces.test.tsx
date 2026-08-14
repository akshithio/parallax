import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import InputBar from '../../components/InputBar'
import RightPanel from '../../components/RightPanel'
import SettingsModal from '../../components/SettingsModal'
import Sidebar from '../../components/Sidebar'
import TerminalDrawer from '../../components/TerminalDrawer'

describe('workspace surfaces', () => {
  test('keeps the brand next to the native window controls', () => {
    render(
      <Sidebar
        open
        conversations={{}}
        convOrder={[]}
        projects={[]}
        currentConvId={null}
        workingConversationIds={new Set()}
        onOpenSearch={() => {}}
        onAddProject={() => {}}
        onRemoveProject={() => {}}
        onNewThread={() => {}}
        onSwitch={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onArchive={() => {}}
        onOpenSettings={() => {}}
      />,
    )

    const brand = screen.getByText('Parallax')
    const alpha = screen.getByText('Alpha')
    expect(brand.parentElement?.previousElementSibling).toHaveStyle({
      width: 'var(--workspace-controls-left)',
    })
    expect(brand.parentElement).toBe(alpha.parentElement)
  })

  test('shows per-thread working and unread indicators in one status slot', () => {
    render(
      <Sidebar
        open
        conversations={{
          'thread-a': {
            id: 'thread-a',
            title: 'Working thread',
            messages: [{ role: 'user', text: 'Inspect this repository.' }],
            chatgptUrl: null,
            folderPath: '/tmp/project',
            updatedAt: 2,
          },
          'thread-b': {
            id: 'thread-b',
            title: 'Finished thread',
            messages: [
              { role: 'user', text: 'Explain this repository.' },
              { role: 'assistant', text: 'Finished.' },
            ],
            chatgptUrl: null,
            folderPath: '/tmp/project',
            updatedAt: 1,
            unread: true,
          },
        }}
        convOrder={['thread-a', 'thread-b']}
        projects={['/tmp/project']}
        currentConvId="thread-a"
        workingConversationIds={new Set(['thread-a'])}
        onOpenSearch={() => {}}
        onAddProject={() => {}}
        onRemoveProject={() => {}}
        onNewThread={() => {}}
        onSwitch={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onArchive={() => {}}
        onOpenSettings={() => {}}
      />,
    )

    expect(screen.getByLabelText('Working thread is working')).toBeInTheDocument()
    expect(screen.getByLabelText('Finished thread has an unread response')).toBeInTheDocument()
  })

  test('uses an in-app project dialog that explains its chats will be archived', async () => {
    const user = userEvent.setup()
    const onRemoveProject = vi.fn()
    render(
      <Sidebar
        open
        conversations={{
          'thread-a': {
            id: 'thread-a',
            title: 'First chat',
            messages: [{ role: 'user', text: 'First' }],
            chatgptUrl: null,
            folderPath: '/tmp/test-folder',
          },
          'thread-b': {
            id: 'thread-b',
            title: 'Second chat',
            messages: [{ role: 'user', text: 'Second' }],
            chatgptUrl: null,
            folderPath: '/tmp/test-folder',
          },
          'thread-archived': {
            id: 'thread-archived',
            title: 'Archived chat',
            messages: [{ role: 'user', text: 'Archived' }],
            chatgptUrl: null,
            folderPath: '/tmp/test-folder',
            archived: true,
          },
          'empty-draft': {
            id: 'empty-draft',
            title: 'New chat',
            messages: [],
            chatgptUrl: null,
            folderPath: '/tmp/test-folder',
          },
        }}
        convOrder={['thread-a', 'thread-b', 'thread-archived', 'empty-draft']}
        projects={['/tmp/test-folder']}
        currentConvId="thread-a"
        workingConversationIds={new Set()}
        onOpenSearch={() => {}}
        onAddProject={() => {}}
        onRemoveProject={onRemoveProject}
        onNewThread={() => {}}
        onSwitch={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onArchive={() => {}}
        onOpenSettings={() => {}}
      />,
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: /test-folder/i }))
    await user.click(screen.getByRole('button', { name: 'Remove project' }))

    expect(
      screen.getByRole('alertdialog', { name: 'Remove project "test-folder"?' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'This removes the project from the sidebar and archives all 2 chats inside it.',
      ),
    ).toBeInTheDocument()
    expect(onRemoveProject).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Remove project' }))
    expect(onRemoveProject).toHaveBeenCalledWith('/tmp/test-folder')
  })

  test('keeps archived chats out of the sidebar', () => {
    render(
      <Sidebar
        open
        conversations={{
          'thread-a': {
            id: 'thread-a',
            title: 'Archived chat',
            messages: [{ role: 'user', text: 'Stored history' }],
            chatgptUrl: null,
            folderPath: '/tmp/removed-project',
            archived: true,
          },
        }}
        convOrder={['thread-a']}
        projects={[]}
        currentConvId={null}
        workingConversationIds={new Set()}
        onOpenSearch={() => {}}
        onAddProject={() => {}}
        onRemoveProject={() => {}}
        onNewThread={() => {}}
        onSwitch={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onArchive={() => {}}
        onOpenSettings={() => {}}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Archived' })).not.toBeInTheDocument()
    expect(screen.queryByTitle('Archived chat')).not.toBeInTheDocument()
  })

  test('draws a visible blue outline around every multi-selected chat', () => {
    render(
      <Sidebar
        open
        conversations={{
          'thread-a': {
            id: 'thread-a',
            title: 'First chat',
            messages: [{ role: 'user', text: 'First' }],
            chatgptUrl: null,
            folderPath: '/tmp/project',
          },
          'thread-b': {
            id: 'thread-b',
            title: 'Second chat',
            messages: [{ role: 'user', text: 'Second' }],
            chatgptUrl: null,
            folderPath: '/tmp/project',
          },
        }}
        convOrder={['thread-a', 'thread-b']}
        projects={['/tmp/project']}
        currentConvId="thread-a"
        workingConversationIds={new Set()}
        onOpenSearch={() => {}}
        onAddProject={() => {}}
        onRemoveProject={() => {}}
        onNewThread={() => {}}
        onSwitch={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onArchive={() => {}}
        onOpenSettings={() => {}}
      />,
    )

    const first = screen.getByTitle('First chat').closest('button') as HTMLButtonElement
    const second = screen.getByTitle('Second chat').closest('button') as HTMLButtonElement
    fireEvent.click(first, { metaKey: true })
    fireEvent.click(second, { metaKey: true })

    expect(first).toHaveClass('ring-1', 'ring-inset', 'ring-primary/65')
    expect(second).toHaveClass('ring-1', 'ring-inset', 'ring-primary/65')
    expect(screen.getByText('2 selected')).toBeInTheDocument()
  })

  test('confirms destructive settings actions inside the app', async () => {
    const user = userEvent.setup()
    const onDeleteAll = vi.fn()
    const onClose = vi.fn()
    render(
      <SettingsModal
        open
        onClose={onClose}
        permission="full-access"
        onSetPermission={() => {}}
        serverStatus={{ status: 'listening', detail: '' }}
        wsStatus={{ status: 'connected', detail: '' }}
        chatgptStatus={{ status: 'ready', detail: '' }}
        conversations={{}}
        convOrder={[]}
        onUnarchive={() => {}}
        onDeleteAll={onDeleteAll}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Delete all conversations' }))
    expect(
      screen.getByRole('alertdialog', { name: 'Delete all conversations?' }),
    ).toBeInTheDocument()
    expect(onDeleteAll).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete all' }))
    expect(onDeleteAll).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  test('restores archived chats from Settings', async () => {
    const user = userEvent.setup()
    const onUnarchive = vi.fn()
    render(
      <SettingsModal
        open
        onClose={() => {}}
        permission="full-access"
        onSetPermission={() => {}}
        serverStatus={{ status: 'listening', detail: '' }}
        wsStatus={{ status: 'connected', detail: '' }}
        chatgptStatus={{ status: 'ready', detail: '' }}
        conversations={{
          archived: {
            id: 'archived',
            title: 'Archived chat',
            messages: [{ role: 'user', text: 'Stored history' }],
            chatgptUrl: null,
            folderPath: '/tmp/removed-project',
            archived: true,
          },
        }}
        convOrder={['archived']}
        onUnarchive={onUnarchive}
        onDeleteAll={() => {}}
      />,
    )

    expect(screen.getByText('Archived chat')).toBeInTheDocument()
    expect(screen.getByText('removed-project')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Restore Archived chat' }))
    expect(onUnarchive).toHaveBeenCalledWith(['archived'])
  })

  test('shows update progress and restarts into a downloaded release', async () => {
    const user = userEvent.setup()
    const onInstallUpdate = vi.fn()
    const { rerender } = render(
      <SettingsModal
        open
        onClose={() => {}}
        permission="full-access"
        onSetPermission={() => {}}
        serverStatus={{ status: 'listening', detail: '' }}
        wsStatus={{ status: 'connected', detail: '' }}
        chatgptStatus={{ status: 'ready', detail: '' }}
        conversations={{}}
        convOrder={[]}
        onUnarchive={() => {}}
        onDeleteAll={() => {}}
        updateStatus={{
          status: 'downloading',
          currentVersion: '1.2.3',
          availableVersion: '1.3.0',
          progress: 48,
          message: 'Downloading update… 48%',
        }}
        onInstallUpdate={onInstallUpdate}
      />,
    )

    expect(screen.getByText('Parallax 1.2.3')).toBeInTheDocument()
    expect(screen.getByText('Downloading update… 48%')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Downloading…' })).toBeDisabled()

    rerender(
      <SettingsModal
        open
        onClose={() => {}}
        permission="full-access"
        onSetPermission={() => {}}
        serverStatus={{ status: 'listening', detail: '' }}
        wsStatus={{ status: 'connected', detail: '' }}
        chatgptStatus={{ status: 'ready', detail: '' }}
        conversations={{}}
        convOrder={[]}
        onUnarchive={() => {}}
        onDeleteAll={() => {}}
        updateStatus={{
          status: 'downloaded',
          currentVersion: '1.2.3',
          availableVersion: '1.3.0',
          progress: 100,
          message: 'Parallax 1.3.0 is ready to install.',
        }}
        onInstallUpdate={onInstallUpdate}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Restart to update' }))
    expect(onInstallUpdate).toHaveBeenCalledOnce()
  })

  test('restores composer focus even while the document is hidden', () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    try {
      render(
        <InputBar
          sending={false}
          currentConvId={null}
          onSend={() => {}}
          gptModel="GPT"
          onSetGptModel={() => {}}
          availableModels={[]}
          intelligence="High"
          selectionStatus="confirmed"
          onSetIntelligence={() => {}}
          permission="full-access"
          onSetPermission={() => {}}
        />,
      )

      const composer = screen.getByPlaceholderText('Ask for follow-up changes or attach files')
      expect(composer).not.toHaveFocus()
      act(() => vi.runOnlyPendingTimers())
      expect(composer).toHaveFocus()
    } finally {
      vi.useRealTimers()
      Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    }
  })

  test('replaces the composer with the exact pending command', async () => {
    const user = userEvent.setup()
    const onApprove = vi.fn()
    const onDeny = vi.fn()
    render(
      <InputBar
        sending
        currentConvId="thread-a"
        onSend={() => {}}
        gptModel="GPT"
        onSetGptModel={() => {}}
        availableModels={[]}
        intelligence="High"
        selectionStatus="confirmed"
        onSetIntelligence={() => {}}
        permission="approve"
        onSetPermission={() => {}}
        pendingApproval={{
          convId: 'thread-a',
          actions: [{ type: 'run', command: 'ls -la' }],
        }}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    )

    expect(document.querySelector('[data-approval-composer]')).toBeInTheDocument()
    expect(document.querySelector('[data-approval-state="entering"]')).toHaveClass(
      'parallax-approval-frame',
    )
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText('ls -la')).toBeInTheDocument()
    expect(screen.queryByText('run ls -la')).not.toBeInTheDocument()
    expect(screen.queryByText(/review the command above/i)).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('alertdialog', { name: 'Approval required: ls -la' })).toHaveFocus(),
    )

    await user.click(screen.getByRole('button', { name: 'Run' }))
    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onDeny).toHaveBeenCalledTimes(1)
  })

  test('contracts the approval surface before restoring the composer', () => {
    vi.useFakeTimers()
    try {
      const baseProps = {
        sending: true,
        currentConvId: 'thread-a',
        onSend: vi.fn(),
        gptModel: 'GPT',
        onSetGptModel: vi.fn(),
        availableModels: [],
        intelligence: 'High',
        selectionStatus: 'confirmed' as const,
        onSetIntelligence: vi.fn(),
        permission: 'approve' as const,
        onSetPermission: vi.fn(),
      }
      const { rerender } = render(
        <InputBar
          {...baseProps}
          pendingApproval={{
            convId: 'thread-a',
            actions: [{ type: 'run', command: 'ls -la' }],
          }}
        />,
      )

      expect(document.querySelector('[data-approval-state="entering"]')).toBeInTheDocument()
      rerender(<InputBar {...baseProps} pendingApproval={null} />)
      expect(document.querySelector('[data-approval-state="leaving"]')).toBeInTheDocument()
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

      act(() => vi.advanceTimersByTime(220))
      expect(document.querySelector('[data-approval-composer]')).not.toBeInTheDocument()
      expect(screen.getByRole('textbox')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  test('queues a drafted message while the current task is working', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const onEditQueuedMessage = vi.fn(() => true)
    const onDeleteQueuedMessage = vi.fn()
    render(
      <InputBar
        sending
        queuedMessages={[
          { id: 'queued-1', text: 'Queued draft' },
          { id: 'queued-2', text: 'Another queued draft' },
        ]}
        currentConvId="thread-b"
        onSend={onSend}
        onEditQueuedMessage={onEditQueuedMessage}
        onDeleteQueuedMessage={onDeleteQueuedMessage}
        gptModel="GPT"
        onSetGptModel={() => {}}
        availableModels={[]}
        intelligence="High"
        selectionStatus="confirmed"
        onSetIntelligence={() => {}}
        permission="approve"
        onSetPermission={() => {}}
      />,
    )

    const composer = screen.getByPlaceholderText(
      'Ask for follow-up changes or attach files',
    )
    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Queue message' })).not.toBeInTheDocument()
    expect(document.querySelectorAll('[data-queued-message-row]')).toHaveLength(2)
    expect(screen.getByText('Queued draft')).toBeInTheDocument()
    expect(screen.getByText('Another queued draft')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Edit queued message 1' }))
    const queuedEditor = screen.getByRole('textbox', { name: 'Queued message 1' })
    await user.clear(queuedEditor)
    await user.type(queuedEditor, 'Revised queued draft')
    await user.click(screen.getByRole('button', { name: 'Save queued message 1' }))
    expect(onEditQueuedMessage).toHaveBeenCalledWith('queued-1', 'Revised queued draft')
    expect(composer).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete queued message 2' }))
    expect(onDeleteQueuedMessage).toHaveBeenCalledWith('queued-2')

    await user.type(
      composer,
      'Draft for this task',
    )
    await user.click(screen.getByRole('button', { name: 'Queue message' }))
    expect(onSend).toHaveBeenCalledWith(
      'Draft for this task',
      'GPT',
      'High',
      undefined,
      undefined,
    )
  })

  test('renders an opened source file with language-aware highlighting', async () => {
    const user = userEvent.setup()
    const source = [
      'def train():',
      '    """Trains and',
      '    evaluates a model."""',
      '    return 42',
    ].join('\n')
    window.parallax = {
      agentExec: vi.fn(async ({ actions }: { actions: Array<{ type: string }> }) => ({
        results: actions.map((action) => (
          action.type === 'list'
            ? { status: 'ok', content: 'example.py' }
            : { status: 'ok', content: source }
        )),
      })),
    } as any

    render(
      <RightPanel
        open
        cwd="/workspace/repository"
        conversationId="thread-a"
        surface="files"
        onSurface={() => {}}
        onClose={() => {}}
      />,
    )

    await user.click(await screen.findByRole('button', { name: 'example.py' }))
    await screen.findByText('4 lines')

    const viewer = document.querySelector('.hljs')
    expect(viewer).not.toBeNull()
    expect(viewer?.querySelector('.hljs-keyword')).toHaveTextContent('def')
    expect(viewer?.querySelectorAll('.hljs-string')).toHaveLength(2)
    expect(viewer).toHaveTextContent('Trains and')
    expect(viewer).toHaveTextContent('evaluates a model.')
  })

  test('starts in the thread folder and persists cd for the next command', async () => {
    const user = userEvent.setup()
    const agentExec = vi.fn(async ({ cwd, actions }: any) => {
      const command = actions[0].command
      if (command === 'cd src && pwd') {
        return {
          results: [{
            status: 'ok',
            content: '$ cd src && pwd\n/workspace/repository/src\n[exit 0]',
          }],
        }
      }
      return {
        results: [{
          status: 'ok',
          content: `$ ${command}\n${cwd}\n[exit 0]`,
        }],
      }
    })
    window.parallax = { agentExec } as any

    render(
      <TerminalDrawer
        open
        cwd="/workspace/repository"
        onClose={() => {}}
      />,
    )

    const input = screen.getByRole('textbox')
    expect(screen.getByTitle('/workspace/repository')).toHaveTextContent('repository')

    await user.type(input, 'pwd{enter}')
    await waitFor(() => expect(agentExec).toHaveBeenCalledTimes(1))
    expect(agentExec.mock.calls[0][0].cwd).toBe('/workspace/repository')

    await user.type(input, 'cd src{enter}')
    await waitFor(() => expect(agentExec).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByTitle('/workspace/repository/src')).toHaveTextContent('repository/src'),
    )

    await user.type(input, 'ls{enter}')
    await waitFor(() => expect(agentExec).toHaveBeenCalledTimes(3))
    expect(agentExec.mock.calls[2][0].cwd).toBe('/workspace/repository/src')
  })
})
