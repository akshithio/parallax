import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import useNix, { type Conversation } from '../../hooks/useNix'
import { HARNESS_PROTOCOL_VERSION } from '../../lib/systemPrompt'
import { createNixBridge } from '../helpers/nixBridge'

const URL_A = 'https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const URL_B = 'https://chatgpt.com/c/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

function thread(id: string, chatgptUrl: string | null = null): Conversation {
  return {
    id,
    title: id,
    messages: [],
    chatgptUrl,
    folderPath: `/tmp/${id}`,
    updatedAt: id === 'thread-b' ? 2 : 1,
  }
}

function data(conversations: Record<string, Conversation>, convOrder = Object.keys(conversations)) {
  return { conversations, convOrder, projects: ['/tmp/thread-a', '/tmp/thread-b'] }
}

describe('useNix transport integration', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('shows a message immediately and reconciles acknowledgement without duplication', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a') }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => result.current.send('Inspect this repository.'))

    expect(bridge.api.send).toHaveBeenCalledTimes(1)
    expect(result.current.conversations['thread-a'].messages).toHaveLength(1)
    const call = bridge.api.send.mock.calls[0]
    const msgId = call[7]
    expect(result.current.conversations['thread-a'].messages[0]).toMatchObject({
      role: 'user',
      text: 'Inspect this repository.',
      msgId,
      delivery: 'pending',
    })

    act(() => {
      bridge.emit('sent', {
        text: 'Inspect this repository.',
        msgId,
        convId: 'thread-a',
      })
    })
    await waitFor(() =>
      expect(result.current.conversations['thread-a'].messages[0].delivery).toBe('sent'),
    )

    act(() => {
      bridge.emit('sent', {
        text: 'Inspect this repository.',
        msgId,
        convId: 'thread-a',
      })
    })
    expect(result.current.conversations['thread-a'].messages).toHaveLength(1)
  })

  test('queues user messages during an active turn and drains them in order', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => result.current.send('First request'))
    const first = bridge.api.send.mock.calls[0]
    act(() => result.current.send('Second request'))
    act(() => result.current.send('Third request'))

    expect(bridge.api.send).toHaveBeenCalledTimes(1)
    expect(result.current.currentQueuedMessageCount).toBe(2)
    expect(result.current.currentQueuedMessages.map((message) => message.text)).toEqual([
      'Second request',
      'Third request',
    ])
    const queuedIds = result.current.currentQueuedMessages.map((message) => message.id)
    expect(queuedIds.every(Boolean)).toBe(true)
    expect(new Set(queuedIds).size).toBe(2)
    expect(result.current.conversations['thread-a'].messages).toHaveLength(1)

    act(() => {
      bridge.emit('sent', {
        text: 'First request',
        msgId: first[7],
        convId: 'thread-a',
      })
      bridge.emit('response', {
        text: 'First response',
        convId: 'thread-a',
        url: URL_A,
      })
    })

    await waitFor(() => expect(bridge.api.send).toHaveBeenCalledTimes(2))
    expect(bridge.api.send.mock.calls[1][0]).toBe('Second request')
    expect(result.current.currentQueuedMessageCount).toBe(1)
    expect(
      result.current.conversations['thread-a'].messages.find(
        (message) => message.text === 'Second request',
      )?.delivery,
    ).toBe('pending')
    expect(result.current.conversations['thread-a'].messages.map((message) => message.text)).toEqual([
      'First request',
      'First response',
      'Second request',
    ])

    const second = bridge.api.send.mock.calls[1]
    act(() => {
      bridge.emit('sent', {
        text: 'Second request',
        msgId: second[7],
        convId: 'thread-a',
      })
      bridge.emit('response', {
        text: 'Second response',
        convId: 'thread-a',
        url: URL_A,
      })
    })

    await waitFor(() => expect(bridge.api.send).toHaveBeenCalledTimes(3))
    expect(bridge.api.send.mock.calls[2][0]).toBe('Third request')
    expect(result.current.currentQueuedMessageCount).toBe(0)
  })

  test('edits a user message by replacing its branch in the owned browser conversation', async () => {
    const existing = {
      ...thread('thread-a', URL_A),
      messages: [
        {
          role: 'user' as const,
          text: 'Explain the repository.',
          msgId: 'original-message',
          delivery: 'sent' as const,
        },
        { role: 'assistant' as const, text: 'Old response.' },
        { role: 'user' as const, text: 'Old follow-up.', msgId: 'old-follow-up' },
        { role: 'assistant' as const, text: 'Old follow-up response.' },
      ],
    }
    const bridge = createNixBridge(data({ 'thread-a': existing }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() =>
      result.current.editMessage(
        'original-message',
        'Explain the current repository structure.',
      ),
    )

    expect(result.current.currentConversationSending).toBe(true)
    expect(result.current.conversations['thread-a'].messages).toHaveLength(1)
    expect(result.current.conversations['thread-a'].messages[0]).toMatchObject({
      role: 'user',
      text: 'Explain the current repository structure.',
      delivery: 'pending',
    })
    expect(bridge.api.editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        convId: 'thread-a',
        originalText: 'Explain the repository.',
        text: 'Explain the current repository structure.',
        userIndex: 0,
        expectUrl: URL_A,
      }),
    )

    const edited = bridge.api.editMessage.mock.calls[0][0]
    act(() => {
      bridge.emit('sent', {
        text: edited.text,
        msgId: edited.msgId,
        convId: 'thread-a',
      })
      bridge.emit('response', {
        text: 'New response.',
        convId: 'thread-a',
        url: URL_A,
      })
    })

    await waitFor(() => expect(result.current.currentConversationSending).toBe(false))
    expect(result.current.conversations['thread-a'].messages).toMatchObject([
      {
        role: 'user',
        text: 'Explain the current repository structure.',
        delivery: 'sent',
      },
      { role: 'assistant', text: 'New response.' },
    ])
  })

  test('removing a project archives every chat inside it in the same saved update', async () => {
    const projectPath = '/tmp/test-folder'
    const projectA = {
      ...thread('thread-a'),
      folderPath: projectPath,
      messages: [{ role: 'user' as const, text: 'First chat' }],
    }
    const projectB = {
      ...thread('thread-b'),
      folderPath: projectPath,
      messages: [{ role: 'user' as const, text: 'Second chat' }],
    }
    const other = {
      ...thread('thread-c'),
      folderPath: '/tmp/other',
      messages: [{ role: 'user' as const, text: 'Other chat' }],
    }
    const bridge = createNixBridge({
      conversations: {
        'thread-a': projectA,
        'thread-b': projectB,
        'thread-c': other,
      },
      convOrder: ['thread-a', 'thread-b', 'thread-c'],
      projects: [projectPath, '/tmp/other'],
    })
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => result.current.removeProject(projectPath))

    expect(result.current.projects).toEqual(['/tmp/other'])
    expect(result.current.conversations['thread-a'].archived).toBe(true)
    expect(result.current.conversations['thread-b'].archived).toBe(true)
    expect(result.current.conversations['thread-c'].archived).not.toBe(true)
    expect(result.current.currentConvId).toBe('thread-c')
    await waitFor(() =>
      expect(bridge.api.saveData).toHaveBeenLastCalledWith({
        conversations: {
          'thread-a': expect.objectContaining({ archived: true }),
          'thread-b': expect.objectContaining({ archived: true }),
          'thread-c': expect.not.objectContaining({ archived: true }),
        },
        convOrder: ['thread-a', 'thread-b', 'thread-c'],
        projects: ['/tmp/other'],
      }),
    )
  })

  test('sends a greeting normally and delays the workspace protocol until it is needed', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a') }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => result.current.send('hi'))
    const greeting = bridge.api.send.mock.calls[0]
    expect(greeting[0]).toBe('hi')
    expect(greeting[3]).toBeUndefined()

    act(() => {
      bridge.emit('sent', {
        text: 'hi',
        msgId: greeting[7],
        convId: 'thread-a',
      })
      bridge.emit('response', {
        text: 'Hi.',
        convId: 'thread-a',
        url: URL_A,
      })
    })
    await waitFor(() => expect(result.current.sending).toBe(false))

    act(() => result.current.send('Inspect this repository.'))
    const workspaceRequest = bridge.api.send.mock.calls[1]
    expect(workspaceRequest[0]).toBe('Inspect this repository.')
    expect(workspaceRequest[3]).toContain('{nix:task}\nInspect this repository.\n{/nix:task}')
    expect(String(workspaceRequest[3]).length).toBeLessThan(3500)
  })

  test('refreshes an older browser conversation with the current workspace contract', async () => {
    const existing = {
      ...thread('thread-a', URL_A),
      protocolReady: true,
    }
    const bridge = createNixBridge(data({ 'thread-a': existing }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => result.current.send('Inspect ../akshith.io for its frontend style.'))

    const request = bridge.api.send.mock.calls[0]
    expect(request[3]).toContain('not a read boundary')
    expect(request[3]).toContain('ls ../repo')

    act(() => {
      bridge.emit('sent', {
        text: 'Inspect ../akshith.io for its frontend style.',
        msgId: request[7],
        convId: 'thread-a',
      })
    })
    await waitFor(() =>
      expect(result.current.conversations['thread-a'].protocolVersion).toBe(
        HARNESS_PROTOCOL_VERSION,
      ),
    )
  })

  test('Manual synchronously presents and denies one shell command at a time', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => {
      result.current.setPermissionLevel('approve')
      bridge.emit('response', {
        convId: 'thread-a',
        url: URL_A,
        text:
          '{nix:note}Reading the repository structure{/nix:note}\n' +
          '{nix:run}ls -la{/nix:run}\n' +
          '{nix:run}pwd{/nix:run}',
      })
    })

    await waitFor(() => expect(result.current.pendingApproval).not.toBeNull())
    expect(result.current.pendingApproval?.actions).toEqual([
      { type: 'run', command: 'ls -la' },
    ])
    expect(result.current.conversations['thread-a'].messages[0].calls?.[0]?.status).toBe(
      'awaiting',
    )
    expect(result.current.conversations['thread-a'].messages[0].calls).toHaveLength(1)
    expect(bridge.api.agentExec).not.toHaveBeenCalled()

    act(() => result.current.denyPending())
    await waitFor(() =>
      expect(result.current.conversations['thread-a'].messages[0].calls?.[0]?.status).toBe(
        'denied',
      ),
    )
    expect(bridge.api.agentExec).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(bridge.api.send.mock.calls.some((call) =>
        call[4] === true && String(call[3]).includes('Denied by the user.'),
      )).toBe(true),
    )
  })

  test('Auto-review raises explicitly flagged actions for human approval', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => {
      bridge.emit('response', {
        convId: 'thread-a',
        url: URL_A,
        text:
          '{nix:note}Updating the project{/nix:note}\n' +
          '{nix:write path="README.md" approval="required"}Viewer documentation{/nix:write}',
      })
    })

    await waitFor(() => expect(result.current.pendingApproval).not.toBeNull())
    expect(result.current.pendingApproval?.actions).toEqual([
      {
        type: 'write',
        path: 'README.md',
        content: 'Viewer documentation',
        approval: 'required',
      },
    ])
    expect(result.current.conversations['thread-a'].messages[0].calls?.[0]?.status).toBe(
      'awaiting',
    )
    expect(bridge.api.agentExec).not.toHaveBeenCalled()

    act(() => result.current.approvePending())
    await waitFor(() => expect(bridge.api.agentExec).toHaveBeenCalledTimes(1))
    expect(bridge.api.agentExec.mock.calls[0][0].actions).toEqual([
      {
        type: 'write',
        path: 'README.md',
        content: 'Viewer documentation',
        approval: 'required',
      },
    ])
  })

  test('Auto-review executes an unflagged routine change without pausing', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => {
      bridge.emit('response', {
        convId: 'thread-a',
        url: URL_A,
        text:
          '{nix:note}Updating the project{/nix:note}\n' +
          '{nix:write path="README.md"}Viewer documentation{/nix:write}',
      })
    })

    await waitFor(() => expect(bridge.api.agentExec).toHaveBeenCalledTimes(1))
    expect(result.current.pendingApproval).toBeNull()
    expect(bridge.api.agentExec.mock.calls[0][0].actions).toEqual([
      { type: 'write', path: 'README.md', content: 'Viewer documentation' },
    ])
  })

  test('publishes a running command body before the process returns', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    let finishExecution: ((value: {
      results: Array<{ status: 'ok'; content: string }>
    }) => void) | undefined
    bridge.api.agentExec.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishExecution = resolve
        }),
    )
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => {
      result.current.setPermissionLevel('full-access')
      bridge.emit('response', {
        convId: 'thread-a',
        url: URL_A,
        text:
          '{nix:note}Checking the workspace{/nix:note}\n' +
          '{nix:run}printf ready{/nix:run}',
      })
    })

    await waitFor(() =>
      expect(result.current.conversations['thread-a'].messages[0].calls?.[0]).toMatchObject({
        status: 'running',
        result: '$ printf ready\n',
      }),
    )

    act(() => {
      finishExecution?.({
        results: [{ status: 'ok', content: '$ printf ready\nready\n[exit 0]' }],
      })
    })
    await waitFor(() =>
      expect(result.current.conversations['thread-a'].messages[0].calls?.[0]).toMatchObject({
        status: 'ok',
        result: '$ printf ready\nready\n[exit 0]',
      }),
    )
  })

  test('shows a streamed write batch before execution and always returns its results', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())
    const actionTurn =
      '{nix:note}Creating the application foundation{/nix:note}\n' +
      '{nix:write path="package.json"}{"name":"viewer"}{/nix:write}\n' +
      '{nix:write path="tsconfig.json"}{"compilerOptions":{}}{/nix:write}\n' +
      '{nix:write path="next-env.d.ts"}/// reference types="next"{/nix:write}\n' +
      '{nix:write path="next.config.mjs"}export default {}{/nix:write}'

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => {
      result.current.setPermissionLevel('full-access')
      bridge.emit('stream_update', {
        convId: 'thread-a',
        url: URL_A,
        text: actionTurn,
      })
    })

    await waitFor(() =>
      expect(result.current.conversations['thread-a'].messages[0]).toMatchObject({
        streaming: true,
        notes: ['Creating the application foundation'],
      }),
    )
    expect(result.current.conversations['thread-a'].messages[0].calls).toEqual([
      expect.objectContaining({ label: 'package.json', status: 'running' }),
      expect.objectContaining({ label: 'tsconfig.json', status: 'running' }),
      expect.objectContaining({ label: 'next-env.d.ts', status: 'running' }),
      expect.objectContaining({ label: 'next.config.mjs', status: 'running' }),
    ])
    expect(bridge.api.agentExec).not.toHaveBeenCalled()
    expect(bridge.api.send).not.toHaveBeenCalled()

    act(() => {
      bridge.emit('response', {
        convId: 'thread-a',
        url: URL_A,
        text: actionTurn,
      })
    })

    await waitFor(() => expect(bridge.api.agentExec).toHaveBeenCalledTimes(4))
    await waitFor(() =>
      expect(
        bridge.api.send.mock.calls.some(
          (call) =>
            call[4] === true &&
            String(call[3]).includes('path="package.json"') &&
            String(call[3]).includes('path="next.config.mjs"'),
        ),
      ).toBe(true),
    )
  })

  test('returns an executor failure to the browser instead of abandoning the turn', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    bridge.api.agentExec.mockRejectedValueOnce(new Error('executor unavailable'))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => {
      bridge.emit('response', {
        convId: 'thread-a',
        url: URL_A,
        text:
          '{nix:note}Reading project metadata{/nix:note}\n' +
          '{nix:read path="package.json" /}',
      })
    })

    await waitFor(() =>
      expect(
        bridge.api.send.mock.calls.some(
          (call) =>
            call[4] === true &&
            String(call[3]).includes('Executor failed: executor unavailable'),
        ),
      ).toBe(true),
    )
  })

  test('retries a failed result continuation with the same message identity', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => {
      bridge.emit('response', {
        convId: 'thread-a',
        url: URL_A,
        text:
          '{nix:note}Reading project metadata{/nix:note}\n' +
          '{nix:read path="package.json" /}',
      })
    })

    await waitFor(() =>
      expect(bridge.api.send.mock.calls.filter((call) => call[4] === true)).toHaveLength(1),
    )
    const original = bridge.api.send.mock.calls.find((call) => call[4] === true)
    act(() => {
      bridge.emit('error', {
        convId: 'thread-a',
        msgId: original?.[7],
        message: 'transport unavailable',
      })
    })

    await waitFor(
      () =>
        expect(bridge.api.send.mock.calls.filter((call) => call[4] === true)).toHaveLength(2),
      { timeout: 1500 },
    )
    const retry = bridge.api.send.mock.calls.filter((call) => call[4] === true)[1]
    expect(retry[7]).toBe(original?.[7])
    expect(retry[3]).toBe(original?.[3])
    expect(result.current.sending).toBe(true)
  })

  test('holds a completed action result while offline and sends it on reconnect', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => {
      bridge.emit('status', { type: 'ws', status: 'disconnected' })
    })
    await waitFor(() => expect(result.current.wsStatus.status).toBe('disconnected'))

    act(() => {
      bridge.emit('response', {
        convId: 'thread-a',
        url: URL_A,
        text:
          '{nix:note}Reading project metadata{/nix:note}\n' +
          '{nix:read path="package.json" /}',
      })
    })
    await waitFor(() => expect(bridge.api.agentExec).toHaveBeenCalledTimes(1))
    expect(bridge.api.send).not.toHaveBeenCalled()
    expect(result.current.sending).toBe(true)

    act(() => {
      bridge.emit('status', { type: 'ws', status: 'connected' })
    })
    await waitFor(() =>
      expect(bridge.api.send.mock.calls.filter((call) => call[4] === true)).toHaveLength(1),
    )
  })

  test('turns the action-round cap into a forced final-answer continuation', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => result.current.setPermissionLevel('full-access'))

    for (let index = 0; index < 31; index += 1) {
      act(() => {
        bridge.emit('response', {
          convId: 'thread-a',
          url: URL_A,
          text:
            `{nix:note}Reading action round ${index + 1}{/nix:note}\n` +
            `{nix:read path="file-${index + 1}.txt" /}`,
        })
      })
      await waitFor(() =>
        expect(bridge.api.send.mock.calls.filter((call) => call[4] === true)).toHaveLength(
          index + 1,
        ),
      )
    }

    expect(bridge.api.agentExec).toHaveBeenCalledTimes(30)
    const finalContinuation = bridge.api.send.mock.calls.filter((call) => call[4] === true).at(-1)
    expect(finalContinuation?.[3]).toContain('The action-round limit was reached.')
    expect(finalContinuation?.[3]).toContain('Reply with one complete {nix:done} block')
    expect(
      result.current.conversations['thread-a'].messages.at(-1)?.calls?.[0],
    ).toMatchObject({
      status: 'blocked',
      result: expect.stringContaining('The action-round limit was reached.'),
    })
    expect(result.current.sending).toBe(true)
  }, 10000)

  test('drops response events that have no task identity', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => {
      bridge.emit('response', {
        url: URL_A,
        text: 'This response has no owner.',
      })
    })

    expect(result.current.conversations['thread-a'].messages).toHaveLength(0)
  })

  test('removes transport listeners on unmount before a replacement hook subscribes', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    window.nix = bridge.api

    const first = renderHook(() => useNix())
    await waitFor(() => expect(first.result.current.dataLoaded).toBe(true))
    expect(bridge.listenerCount('response')).toBe(1)

    first.unmount()
    expect(bridge.listenerCount('response')).toBe(0)

    const replacement = renderHook(() => useNix())
    await waitFor(() => expect(replacement.result.current.dataLoaded).toBe(true))
    expect(bridge.listenerCount('response')).toBe(1)

    act(() => {
      bridge.emit('response', {
        convId: 'thread-a',
        url: URL_A,
        text: '{nix:done}Finished once.{/nix:done}',
      })
    })

    await waitFor(() =>
      expect(replacement.result.current.conversations['thread-a'].messages).toHaveLength(1),
    )
    expect(replacement.result.current.conversations['thread-a'].messages[0].text).toBe(
      '{nix:done}Finished once.{/nix:done}',
    )
  })

  test('keeps a rejected optimistic message visible and marks it failed', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a') }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => result.current.send('Inspect this repository.'))
    const msgId = bridge.api.send.mock.calls[0][7]

    act(() => {
      bridge.emit('error', {
        convId: 'thread-a',
        msgId,
        message: 'The page did not accept the message.',
      })
    })

    await waitFor(() =>
      expect(result.current.conversations['thread-a'].messages[0].delivery).toBe('failed'),
    )
    expect(result.current.conversations['thread-a'].messages[0].text).toBe(
      'Inspect this repository.',
    )
    expect(result.current.errorMessage).toBe('The page did not accept the message.')
  })

  test('skips model-menu verification when the selected state is already confirmed', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => {
      bridge.emit('models', {
        convId: 'thread-a',
        currentModel: 'GPT-5.6 Sol',
        currentIntelligence: 'High',
        models: [{ title: 'GPT-5.6 Sol' }],
        intelligences: [{ label: 'High' }],
      })
    })
    await waitFor(() => expect(result.current.selectionStatus).toBe('confirmed'))

    act(() => result.current.send('Inspect this repository.', 'GPT-5.6 Sol', 'High'))
    const call = bridge.api.send.mock.calls[0]
    expect(call[1]).toBeUndefined()
    expect(call[2]).toBeUndefined()
  })

  test('routes out-of-order events by task and rejects temporary conversation URLs', async () => {
    const bridge = createNixBridge(
      data({
        'thread-a': thread('thread-a', URL_A),
        'thread-b': thread('thread-b'),
      }),
    )
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.currentConvId).toBe('thread-a'))

    act(() => {
      bridge.emit('status', {
        type: 'chatgpt',
        status: 'ready',
        convId: 'thread-b',
        url: 'https://chatgpt.com/c/WEB:temporary-route',
      })
      bridge.emit('response', {
        convId: 'thread-b',
        url: URL_B,
        text: 'Response for the background task.',
      })
    })

    await waitFor(() =>
      expect(result.current.conversations['thread-b'].messages[0]?.text).toBe(
        'Response for the background task.',
      ),
    )
    expect(result.current.conversations['thread-a'].messages).toHaveLength(0)
    expect(result.current.currentConvId).toBe('thread-a')
    expect(result.current.conversations['thread-b'].chatgptUrl).toBe(URL_B)
  })

  test('keeps working and unread state attached to the task that owns the response', async () => {
    const bridge = createNixBridge(
      data({
        'thread-a': thread('thread-a', URL_A),
        'thread-b': thread('thread-b', URL_B),
      }),
    )
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.currentConvId).toBe('thread-a'))
    act(() => result.current.send('Inspect this repository.'))

    expect(result.current.sending).toBe(true)
    expect(result.current.currentConversationSending).toBe(true)
    expect(result.current.workingConversationIds.has('thread-a')).toBe(true)

    act(() => result.current.switchConversation('thread-b'))
    await waitFor(() => expect(result.current.currentConvId).toBe('thread-b'))
    expect(result.current.sending).toBe(true)
    expect(result.current.currentConversationSending).toBe(false)
    expect(result.current.workingConversationIds.has('thread-a')).toBe(true)

    act(() => {
      bridge.emit('response', {
        convId: 'thread-a',
        url: URL_A,
        text: 'The background task is complete.',
      })
    })

    await waitFor(() => expect(result.current.sending).toBe(false))
    expect(result.current.workingConversationIds.has('thread-a')).toBe(false)
    expect(result.current.conversations['thread-a'].unread).toBe(true)

    act(() => result.current.switchConversation('thread-a'))
    await waitFor(() => expect(result.current.currentConvId).toBe('thread-a'))
    expect(result.current.conversations['thread-a'].unread).toBe(false)
  })

  test('reconciles an early streamed prefix with the complete turn response', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())
    const prefix = 'Yes. We discussed it around July 18–'
    const complete =
      'Yes. We discussed it around July 18–21, 2026. The remainder of the turn is preserved.'

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => {
      bridge.emit('stream_update', {
        convId: 'thread-a',
        url: URL_A,
        text: prefix,
      })
    })
    await waitFor(() =>
      expect(result.current.conversations['thread-a'].messages[0]).toMatchObject({
        text: prefix,
        streaming: true,
      }),
    )

    act(() => {
      bridge.emit('response', {
        convId: 'thread-a',
        url: URL_A,
        text: complete,
      })
    })
    await waitFor(() =>
      expect(result.current.conversations['thread-a'].messages[0]).toMatchObject({
        text: complete,
        streaming: false,
      }),
    )
  })

  test('navigates a drifted task back and retries with the same message identity', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => result.current.send('Trace the runtime.'))
    const originalCall = bridge.api.send.mock.calls[0]
    const originalMsgId = originalCall[7]

    act(() => {
      bridge.emit('wrong_conversation', {
        convId: 'thread-a',
        msgId: originalMsgId,
        expected: URL_A,
        actual: URL_B,
      })
    })
    expect(bridge.api.navigate).toHaveBeenCalledWith(URL_A, 'thread-a')

    act(() => {
      bridge.emit('status', {
        type: 'chatgpt',
        status: 'ready',
        convId: 'thread-a',
        url: URL_A,
      })
    })

    await waitFor(() => expect(bridge.api.send).toHaveBeenCalledTimes(2))
    const retryCall = bridge.api.send.mock.calls[1]
    expect(retryCall[0]).toBe('Trace the runtime.')
    expect(retryCall[6]).toBe('thread-a')
    expect(retryCall[7]).toBe(originalMsgId)
  })

  test('preserves each action round when executor results arrive immediately', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => {
      bridge.emit('response', {
        convId: 'thread-a',
        url: URL_A,
        text:
          "{nix:note}I'll inspect the metadata first.{/nix:note}\n" +
          '{nix:read path="package.json" /}',
      })
    })
    await waitFor(() =>
      expect(bridge.api.send.mock.calls.filter((call) => call[4] === true)).toHaveLength(1),
    )

    act(() => {
      bridge.emit('response', {
        convId: 'thread-a',
        url: URL_A,
        text:
          "{nix:note}I'll inspect the components next.{/nix:note}\n" +
          '{nix:list path="components" /}',
      })
    })

    await waitFor(() =>
      expect(result.current.conversations['thread-a'].messages).toHaveLength(2),
    )
    expect(result.current.conversations['thread-a'].messages[0].notes).toEqual([
      "I'll inspect the metadata first.",
    ])
    expect(result.current.conversations['thread-a'].messages[1].notes).toEqual([
      "I'll inspect the components next.",
    ])
  })

  test('runs independent reads together and publishes each result as it finishes', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    let finishFirst!: (value: { results: Array<{ status: 'ok'; content: string }> }) => void
    let finishSecond!: (value: { results: Array<{ status: 'ok'; content: string }> }) => void
    bridge.api.agentExec
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          finishFirst = resolve
        }),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          finishSecond = resolve
        }),
      )
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => {
      bridge.emit('response', {
        convId: 'thread-a',
        url: URL_A,
        text:
          '{nix:note}Reading both files{/nix:note}\n' +
          '{nix:read path="first.txt" /}\n' +
          '{nix:read path="second.txt" /}',
      })
    })

    await waitFor(() => expect(bridge.api.agentExec).toHaveBeenCalledTimes(2))
    expect(result.current.conversations['thread-a'].messages[0].calls?.[0]?.status).toBe('running')
    expect(result.current.conversations['thread-a'].messages[0].calls?.[1]?.status).toBe('running')

    await act(async () => {
      finishFirst({
        results: [{ status: 'ok', content: 'first result' }],
      })
    })
    await waitFor(() =>
      expect(result.current.conversations['thread-a'].messages[0].calls?.[0]).toMatchObject({
        status: 'ok',
        result: 'first result',
      }),
    )
    expect(result.current.conversations['thread-a'].messages[0].calls?.[1]?.status).toBe('running')
    expect(result.current.conversations['thread-a'].messages[0].calls?.[1]?.result).toBeUndefined()
    expect(bridge.api.agentExec.mock.calls[0][0].actions).toHaveLength(1)
    expect(bridge.api.agentExec.mock.calls[1][0].actions).toHaveLength(1)

    await act(async () => {
      finishSecond({
        results: [{ status: 'ok', content: 'second result' }],
      })
    })
    await waitFor(() =>
      expect(result.current.conversations['thread-a'].messages[0].calls?.[1]).toMatchObject({
        status: 'ok',
        result: 'second result',
      }),
    )
    await waitFor(() =>
      expect(bridge.api.send.mock.calls.some((call) =>
        call[4] === true &&
        String(call[3]).includes('Answer now if these results are sufficient.'),
      )).toBe(true),
    )
  })

  test('publishes running command output before the final result', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    const frameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 1)
    let finish!: (value: { results: Array<{ status: 'ok'; content: string }> }) => void
    bridge.api.agentExec.mockImplementationOnce(
      ({ executionId }: { actions: unknown[]; executionId?: string }) => new Promise((resolve) => {
        finish = resolve
        queueMicrotask(() => {
          bridge.emit('agent_exec_progress', {
            executionId,
            actionIndex: 0,
            status: 'running',
            content: '$ find . -maxdepth 1 -type f\n./package.json',
          })
        })
      }),
    )
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => {
      bridge.emit('response', {
        convId: 'thread-a',
        url: URL_A,
        text:
          '{nix:note}Reading top-level files{/nix:note}\n' +
          '{nix:run}find . -maxdepth 1 -type f{/nix:run}',
      })
    })

    await waitFor(() =>
      expect(result.current.conversations['thread-a'].messages[0].calls?.[0]).toMatchObject({
        status: 'running',
        result: '$ find . -maxdepth 1 -type f\n./package.json',
      }),
    )

    await act(async () => {
      finish({
        results: [{
          status: 'ok',
          content: '$ find . -maxdepth 1 -type f\n./package.json\n[exit 0]',
        }],
      })
    })
    await waitFor(() =>
      expect(result.current.conversations['thread-a'].messages[0].calls?.[0]).toMatchObject({
        status: 'ok',
        result: '$ find . -maxdepth 1 -type f\n./package.json\n[exit 0]',
      }),
    )
    expect(frameSpy).not.toHaveBeenCalled()
  })

  test('recovers a truncated final answer without running more tools', async () => {
    const bridge = createNixBridge(data({ 'thread-a': thread('thread-a', URL_A) }))
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => {
      bridge.emit('response', {
        convId: 'thread-a',
        url: URL_A,
        text: '{nix:done}This answer was cut off',
      })
    })

    await waitFor(() =>
      expect(bridge.api.send.mock.calls.some((call) =>
        call[4] === true &&
        String(call[3]).includes('Your final answer was truncated.'),
      )).toBe(true),
    )
    const repair = bridge.api.send.mock.calls.find((call) =>
      String(call[3]).includes('Your final answer was truncated.'),
    )
    expect(repair?.[3]).toContain('Do not run tools or add action tags.')
    expect(bridge.api.agentExec).not.toHaveBeenCalled()
    expect(result.current.conversations['thread-a'].messages[0].notes).toEqual([
      'The final answer was interrupted, so I’m recovering it.',
    ])
  })

  test('keeps follow-up turn boundaries isolated between background tasks', async () => {
    const bridge = createNixBridge(
      data({
        'thread-a': thread('thread-a', URL_A),
        'thread-b': thread('thread-b', URL_B),
      }),
    )
    window.nix = bridge.api
    const { result } = renderHook(() => useNix())

    await waitFor(() => expect(result.current.dataLoaded).toBe(true))
    act(() => {
      bridge.emit('response', {
        convId: 'thread-a',
        url: URL_A,
        text:
          '{nix:note}Reading first task{/nix:note}\n' +
          '{nix:read path="first.txt" /}',
      })
      bridge.emit('response', {
        convId: 'thread-b',
        url: URL_B,
        text:
          '{nix:note}Reading second task{/nix:note}\n' +
          '{nix:read path="second.txt" /}',
      })
    })
    await waitFor(() =>
      expect(bridge.api.send.mock.calls.filter((call) => call[4] === true)).toHaveLength(2),
    )

    act(() => {
      bridge.emit('stream_update', {
        convId: 'thread-a',
        text: '{nix:done}First task finished.',
      })
      bridge.emit('stream_update', {
        convId: 'thread-b',
        text: '{nix:done}Second task finished.',
      })
    })

    await waitFor(() => {
      expect(result.current.conversations['thread-a'].messages).toHaveLength(2)
      expect(result.current.conversations['thread-b'].messages).toHaveLength(2)
    })
    expect(result.current.conversations['thread-a'].messages[1].text).toContain(
      'First task finished.',
    )
    expect(result.current.conversations['thread-b'].messages[1].text).toContain(
      'Second task finished.',
    )
  })
})
