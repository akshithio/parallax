import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import Onboarding, { CHROME_WEB_STORE_URL } from '../../components/Onboarding'

function props() {
  return {
    initialStep: 'welcome' as const,
    connected: false,
    serverReady: true,
    currentFolder: null,
    currentConvId: null,
    onOpenStore: vi.fn(),
    onCheckConnection: vi.fn(),
    onChooseProject: vi.fn(async () => '/tmp/example-project'),
    onSendFirstMessage: vi.fn(),
    onComplete: vi.fn(),
    onStepChange: vi.fn(),
  }
}

describe('first-run onboarding', () => {
  test('walks through a live extension check, native folder selection, and the first message', async () => {
    const user = userEvent.setup()
    const setup = props()
    const { rerender } = render(<Onboarding {...setup} />)

    expect(screen.queryByText('Setup')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Your repository, one conversation away.' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Get started' }))

    expect(screen.getByRole('heading', { name: 'Connect Chrome' })).toBeInTheDocument()
    const continueButton = screen.getByRole('button', { name: 'Continue' })
    expect(continueButton).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Open Chrome Web Store' }))
    expect(setup.onOpenStore).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(setup.onCheckConnection).toHaveBeenCalledOnce()

    rerender(<Onboarding {...setup} connected />)
    expect(screen.getByText('Extension connected')).toBeInTheDocument()
    expect(continueButton).toBeEnabled()
    await user.click(continueButton)

    await user.click(screen.getByRole('button', { name: 'Choose a project folder' }))
    await waitFor(() => expect(setup.onChooseProject).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Send your first message' })).toBeInTheDocument())

    rerender(
      <Onboarding
        {...setup}
        connected
        currentFolder="/tmp/example-project"
        currentConvId="first-thread"
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Explain how this repository is structured.' }))
    expect(screen.getByRole('textbox', { name: 'First message' })).toHaveValue(
      'Explain how this repository is structured.',
    )
    await user.click(screen.getByRole('button', { name: 'Send first message' }))

    expect(setup.onSendFirstMessage).toHaveBeenCalledWith(
      'Explain how this repository is structured.',
    )
    expect(setup.onComplete).toHaveBeenCalledOnce()
    expect(setup.onStepChange).toHaveBeenCalledWith('extension')
    expect(setup.onStepChange).toHaveBeenCalledWith('project')
    expect(setup.onStepChange).toHaveBeenCalledWith('message')
  })

  test('resumes at folder selection if a saved message step has no project', () => {
    render(<Onboarding {...props()} initialStep="message" />)
    expect(screen.getByRole('heading', { name: 'Choose a repository' })).toBeInTheDocument()
  })

  test('uses the published Chrome Web Store listing', () => {
    expect(CHROME_WEB_STORE_URL).toBe(
      'https://chromewebstore.google.com/detail/parallax/bfnlhalnojbjoipblfnhhljffajanaei?authuser=0&hl=en-GB',
    )
  })
})
