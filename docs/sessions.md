# Conversations beside an article

[中文](sessions.zh-CN.md)

In Settings, enable **Show terminal sessions** to read recent project conversations. Enable **Allow messages to connected agents** separately to send. Both settings are off by default on a new installation. Turning viewing on exposes original conversation text to browsers authorized to open this workbench, including approved LAN devices.

If viewing is off, the new-feature introduction appears once in this browser. **Go to session settings** opens the exact settings section; the viewing and sending switches remain your choice. **Learn about conversations** in Settings reopens the introduction. Reading Contents or closing the mobile conversation panel pauses its polling; opening it resumes updates.

Each article has one row of tabs: **Contents / Codex / Claude Code**. Articles with the same canonical project folder share the current Agent choice and manually selected conversation in this browser tab. Two unrelated folders with the same name do not share a conversation. Worktrees resolve to their main project folder. Republishing an article from its current folder updates that article's project association; missing or ambiguous folders are explained instead of guessed.

Resumed Codex rollout files may include a continuation ID suffix. mydash validates the original thread ID in the launch header and selects the newest valid transcript. Background App owners are located through read-only routing, then their exact ownership and input capability are verified. Saved Codex messages appear before App discovery finishes. With web messaging enabled on macOS, opening a visible Codex conversation panel automatically opens that existing thread on the hosting Mac in the background. This works from a trusted Tailnet phone too; the phone does not launch its own App. No placeholder message is sent. Contents, closed mobile panels, hidden pages and view-only access do not wake the App. Attempts are deduplicated and rate limited, and open only the selected thread. The hosting Mac needs a logged-in GUI session with Codex installed; sign-in and App permission prompts still require that user's interaction. Retry connection retains the draft. Other platforms retain their existing connection methods.

## Connection capabilities

| Connection | Read recent messages | Send text | Send images | Delivery behavior |
|---|---|---|---|---|
| Codex App, local IPC adapter | Yes | Yes, to the original thread; macOS can open it automatically | PNG, JPEG, WebP, GIF | Up to five unfinished messages per thread; queued while busy; durable recovery after service restart |
| Codex CLI in a verified tmux pane | Yes | Yes, when the terminal input is confirmed empty | No | Matches the transcript's user receipt and task completion; no automatic resend |
| Claude Code in a verified tmux pane | Yes | Yes, when the terminal input is confirmed empty | No | Matches the original receipt and reply boundary; no automatic resend |
| Claude App Code session with Remote Control | Yes, when linked | Yes, when idle, connected and permitted by the account | No in mydash 0.2.1 | Uses the same Remote Control thread; matches its client event to the subsequent worker response and result |

The workbench runs on macOS, Linux and Windows. The direct Codex App connector currently requires a private local Unix socket and is not implemented on Windows. Automatic CLI process-to-tmux matching requires macOS or Linux. Claude App Code discovery is implemented for its native per-account session directory, with remote/cloud, SSH and WSL sessions excluded. These connection adapters are opt-in preview features; their platform coverage is narrower than the workbench's.

The Codex adapter checks the App's local protocol versions (stream 11, start-turn 2), local ownership and canonical project folder. An incompatible App pauses sending. It does not start another CLI or change the original Agent's permissions, model or sandbox.

## Connect and send

1. Open the project in the original Agent and keep its conversation running. Older Codex sessions can be discovered without previously installed mydash hooks. Large histories are indexed incrementally; a known thread ID can be read directly.
2. For Codex App on macOS, enable web messaging and open its tab beside the article; mydash can wake the existing original thread without a preliminary message. On other supported IPC environments, open the original local thread. For Claude App Code, open the session details and enable **Remote Control**, then keep the session connected. The `/remote-control` command is for supported CLI environments and can be unavailable inside the App. Use your existing signed-in Claude account. Account eligibility, organization policy, Trusted Devices and usage limits still apply. See [Anthropic's Remote Control guide](https://code.claude.com/docs/en/remote-control).
3. For a CLI, run it inside tmux. mydash validates the process start time, session, TTY and pane. A prompt with a draft, an approval, recent terminal typing or an unrecognized screen prevents sending. mydash never types into an arbitrary shell.
4. Select the Agent tab. The conversation title and automatic/manual target mode stay visible. Click the title to open the searchable conversation picker, showing work state, latest-project marker, update time, recent message preview, connection source and short ID. The list overlays messages without moving them. Opening a newer thread does not silently retarget an edited question, an outstanding delivery or a conversation you are reading back through.
5. Write a message. Only your text is sent by default. Attach an article passage explicitly. On a Codex App connection, choose **Add images** or paste an image; up to four images, 5 MB each. Images may be sent without text.

Sending is available on the hosting computer and trusted Tailnet connections. Approved ordinary LAN browsers can read conversations but cannot send, upload/read attachment files, manage deliveries or change session settings.

## Queues, errors and recovery

Every unfinished delivery has its own card and action. Undispatched Codex App messages expire after 30 minutes instead of sending much later. You can cancel an undispatched Codex App message. For an unconfirmed delivery, inspect the original App first and use **I checked Codex App. Stop waiting.** to unblock the queue. This does not stop work already executing in Codex.

Claude Remote Control currently accepts messages from mydash only while idle; it does not queue them during a running turn or approval. This avoids attributing the previous task’s completion to a new message. Claude App may label a Remote Control message as coming from another session and apply its existing permission protections. Account quota errors appear in the conversation and end the reply wait; they do not mean the message was never delivered.

“Delivered” and “completed” are separate states. An Agent processing error does not imply a failed send. Codex App retries that continue the same task are followed without resubmitting the user message. Uncertain delivery is never automatically repeated. Conversation or approval prompts still need the original Agent's existing confirmation flow.

If a connection is unavailable, the article's question can remain as a draft. On macOS, **Connect and send** first persists the message in the durable queue and wakes the original App thread. It waits for that thread to connect and become idle; you can cancel before dispatch. Other unavailable connections keep the question as a draft; **Record a question** does not submit it. Drafts, quotes, attachment references and reading positions are kept in this browser tab and separated by article version, file, Agent and conversation. Private mode or clearing browser storage can remove them. Messages show a recent bounded window, rather than the entire transcript; tool output and internal reasoning are omitted. There is no “all history” search in this release.

## Image storage

Settings → **Conversation images** shows the local storage size and cleanup actions. Removing an unused image from a draft releases its upload. Unreferenced uploads expire 30 days after upload or their latest read; cleanup runs when another image is uploaded, and the settings page provides explicit cleanup.

**Clean unused uploads** can remove attachments from unsent drafts, so they may need to be attached again. Queued, active and sent delivery references are retained. **Delete completed attachments** additionally removes files retained for completed conversations, after explicit confirmation. This may make older history images unavailable. Queued and active deliveries remain protected. The upload store is capped at 256 MB (including manifests) and roughly 1024 image pairs; cleanup provides a way to reclaim capacity. Text delivery records remain as private local files for retry deduplication and history, independently of image cleanup.

## Local access and troubleshooting

On the hosting computer, bookmark `http://127.0.0.1:4870/`, or run `mydash url --local` for a custom port. It works while the mydash service is running even if Tailscale is off. Other devices need Tailscale or approved LAN access. A fully unloaded Tailscale URL cannot show an in-page warning; use the saved local address. An already-open page shows a recovery notice on disconnect without reloading an unsent question.

For Claude login errors, sign in in the original Claude client. For an account/usage limit or Trusted Devices requirement, resolve it in Claude; mydash does not change these restrictions. If the App or terminal cannot confirm delivery, inspect the original session before retrying. For an unsupported App protocol, update mydash or continue in the original App.

See [SECURITY.md](../SECURITY.md) for trust boundaries, credential handling and retained data. The macOS GUI credential helper only reads the existing unlocked login keychain for the background service; it is removed by `mydash uninstall`.
