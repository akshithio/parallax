# Chrome Web Store listing

## Product details

- Name: Parallax
- Summary: Connect the Parallax desktop workspace to your signed-in ChatGPT tabs.
- Category: Developer Tools
- Language: English

### Detailed description

Parallax connects the Parallax desktop workspace to ChatGPT in Chrome.

The extension is the local bridge that lets Parallax send a prompt from a
repository workspace to a task tab in the Chrome profile where you are already
signed in, then return the response to the matching Parallax thread.

What it does:

- creates a separate inactive ChatGPT task tab for each Parallax thread
- sends only prompts and attachments you initiate in the desktop app
- returns streamed replies to the correct desktop thread
- keeps the desktop connection on a local WebSocket
- reconnects task tabs after an extension update without taking over your active tab

Parallax does not provide or request an API key. It does not send conversation
data to the developer, sell data, run advertisements, or include analytics. Your
prompts and replies go to ChatGPT through your existing signed-in session. The
local bridge handles only Parallax-owned task tabs and remains inert in your other
ChatGPT tabs.

Parallax for macOS is required. Learn more and download it at
https://parallax.akshith.io.

## URLs

- Homepage: https://parallax.akshith.io
- Support: https://github.com/akshithio/parallax/issues
- Privacy policy: https://parallax.akshith.io/privacy

## Single purpose

Connect the Parallax desktop workspace to Parallax-owned ChatGPT task tabs and
return their responses to the matching desktop threads.

## Permission justifications

- `storage`: Store the local WebSocket address and status plus the mapping between
  Parallax threads and their ChatGPT task tabs so the bridge can recover after a
  browser or service-worker restart.
- `alarms`: Wake the Manifest V3 service worker periodically so it can restore the
  local desktop connection after Chrome suspends it.
- `scripting`: Reinstall the isolated page bridge after an extension reload when
  an existing Parallax-owned task tab still has the invalidated previous context.
- Host access: Access is limited to `chatgpt.com` and `chat.openai.com` so Parallax
  can create and operate the task tabs used to send user-initiated prompts and
  return their replies.

The extension does not use remotely hosted code.

## Data disclosure

The extension handles website content and user activity only for the task the
user starts in Parallax. This includes the prompt, selected attachments, streamed
reply, task-tab URL and conversation identifier, and model choice. It does not
sell data or use data for advertising or credit decisions. See the public privacy
policy for storage, transfer, retention, and deletion details.

## Test instructions

1. Install and open Parallax for macOS from https://parallax.akshith.io.
2. Open ChatGPT in the same Chrome profile and sign in with a test account.
3. Open the Parallax extension popup and enable the local bridge.
4. In Parallax, open any local folder and create a thread.
5. Send a short prompt from that thread.
6. Confirm that Parallax opens an inactive ChatGPT task tab and returns the reply
   to the same desktop thread.

No developer-provided test credentials are required. The reviewer can use a
ChatGPT test account available to them.

## Distribution

- Pricing: Free
- Visibility: Public
- Regions: All regions
- Mature content: No
