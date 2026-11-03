# Changelog

## Unreleased

- Connect long Codex App conversations with snapshots above 32 MiB. Receive fragmented frames with linear copying, retain a 64 MiB frame bound, and explain oversized histories instead of a generic timeout.
- Use live App turn activity when choosing the current project conversation, so stale transcript timestamps do not keep an older thread selected.

## 0.2.1 (2026-11-03)

Conversation connections are opt-in preview features. Existing settings are preserved; new installations leave conversation viewing and sending off. See [connection setup and limitations](docs/sessions.md) / [中文说明](docs/sessions.zh-CN.md).

- Article companions use one row of Contents / Codex / Claude Code tabs, Agent icons, compact Markdown conversations, independent scrolling, a laptop expansion view and an accessible mobile drawer. Drafts, explicit quotes, images and reading positions stay with their original article version, file, Agent and conversation.
- Codex App can receive text and up to four images directly in the original open local thread. Busy threads queue messages, persist them across service restarts and distinguish delivery from processing/completion. A processing error can recover through the App's continuation turns without resending the question. Every unfinished message has its own cancellation or uncertainty-resolution control.
- Discover existing Codex and native Claude sessions without requiring an earlier mydash hook. Index large histories incrementally, prioritize recent sessions, look up known IDs directly and keep Agent discovery budgets independent. The standalone session list uses the same discovery sources.
- Canonical project directories separate unrelated same-name folders. Articles keep the latest directory association of that article; other articles cannot change its target. Git worktrees continue to share their main project. Missing, ambiguous and remotely-published project contexts are explained.
- Connect verified Claude Code and Codex tmux panes, matching process start identity, TTY and terminal input state. Text is pasted literally, approvals/drafts prevent handoff, and reply receipts use the correct Agent's completion boundaries. A missing optional hook directory no longer causes a false sending failure.
- Claude App Code sessions can connect through their existing Remote Control link and native login. Controller events track the same original thread. Login, policy, connectivity and trusted-device restrictions are shown; mydash does not start another executor, refresh the account itself or change Agent permissions. The macOS boot service can obtain the existing login credential through a private GUI-session helper; uninstall removes it.
- Claude Remote Control accepts native decimal-string sequence numbers and follows client events through worker replies, including quota failures. Busy/approval states pause new remote sends to avoid confusing the prior turn with a new reply. The connection guide uses the App’s actual Remote Control switch.
- Restore unfinished Codex deliveries independently of history display limits, including threads beyond the previous 100-session cutoff. Unconfirmed deliveries never retry automatically.
- Session image storage shows usage and explicit cleanup. Draft removal releases unused uploads; unreferenced uploads expire after 30 days. Queued/active and sent attachments are retained by default. Separately deleting completed attachments requires confirmation because older history images may become unavailable.
- Local/trusted Tailnet connections can send; ordinary authorized LAN browsers remain conversation-view-only, including for delivery management and image storage actions. Viewing sessions exposes their original text to workbench readers; published HTML/SVG remains isolated from write APIs.
- Settings and access panels provide a bookmarkable hosting-computer URL independent of Tailscale. Disconnected pages show recovery instructions without discarding input. `mydash url --local` supports custom ports and refuses to mistake a remote publishing client for a hosting server.
- No new runtime dependencies or published-item data schema migration. Desktop connection protocols are version checked; see the guide for supported platforms and account prerequisites.

## 0.1.6 (2026-11-02)

- **Open on another device** now has a same-Wi-Fi switch. It opens/closes LAN listeners immediately without a terminal or service restart.
- New LAN browsers need both the access code and approval from this computer or a trusted Tailscale connection. Match the pairing code before allowing a device. Approval covers all projects and workbench actions; it is not per-project sharing. Pending devices cannot read projects, files or live updates, or approve other devices.
- Name devices, deny requests, revoke individual devices, log out a borrowed computer, or change the code to disconnect everyone. Switching LAN access off revokes all LAN devices; active streams are disconnected on revocation. Expired requests cannot later be approved.
- Temporary access is limited to 12 hours on the server; **Remember this device** permits 30 days. Installations have independent identities and cookie names. Existing sessions retain trust for at most 30 days from their original sign-in and can be revoked in the device list; use **Change code and disconnect all devices** after updating if old devices should lose access immediately.
- LAN HTTP is still unencrypted. The panel explains the authorization scope and recommends Tailscale with trusted-device access rules on company/shared networks. No content is merged between installations on the same Wi-Fi, and there is no new runtime dependency.

## 0.1.5 (2026-11-02)

- Already-correct Mac boot services refresh obsolete staged plists, so the home page no longer asks for administrator approval again after an update.
- Boot authorization runs in the logged-in user's GUI session through a one-shot LaunchAgent. A system daemon no longer tries to open its own password prompt. Passwords remain in the native macOS authorization dialog.
- Authorization error -60007 is explained as unavailable user interaction instead of a wrong password. Missing GUI sessions and timeouts provide clear recovery steps.

## 0.1.4 (2026-11-02)

- New versions on main are tagged and released automatically after all platform and browser checks pass. CI cancels superseded runs, caches npm/pip downloads and tests the two Windows service modes in parallel.
- Updates reuse an unchanged dependency graph only after checking the previous install's fingerprint and validating the installed packages. Missing dependencies, changed packages or a different Node ABI cause a fresh install. New release checks run about once an hour instead of once a day.
- Publishing on Windows briefly retries metadata replacement when a reader or scanner holds the file, retaining the old metadata until replacement succeeds. This avoids intermittent publish failures and missing entries in version history.
- No more terminal for the two steps after install or update. Under **Waiting on you**, the home page offers **Allow** for the mydash hooks in Codex (mydash records Codex's trust for exactly its own hooks, as `/hooks` would) and, on a Mac set to start at boot, **Set up**, which opens the macOS password prompt on that Mac.
- When mydash rewrites its own Codex hooks during an update, the permission you gave carries over, so Codex keeps using them. `mydash doctor` now checks Codex's fingerprint, not only that one exists.
- The node path written into hooks, services and the `mydash` command is the stable one (`/opt/homebrew/bin/node`), not the versioned Homebrew Cellar path. Before, an update from the page wrote the Cellar path and a terminal install wrote the other, so each rewrote the hooks (Codex then stopped trusting them), a Mac already starting at boot was told to run the administrator step again, and `brew upgrade node` would have broken them.

## 0.1.3 (2026-11-02)

- New versions show as an **Update** button in the top bar of every page, instead of a line on the home page. Tapping it asks first, then shows a progress bar through each step (download, dependencies, restart, check); when it is done, **OK** reloads the page. Settings → Updates opens the same window. The home page still reports the result of a night-time or command-line update.
- When the checkout mydash was installed from already contains the release plus newer, unreleased commits (a development copy), the update now says exactly that and how to install it, instead of a vague "commits that are not in the release". Failed results name the version they were going to.

## 0.1.2 (2026-11-02)

No data migration or new runtime dependencies are needed; the update notice on the home page installs it.

- Multiple approval blocks use consistent question IDs, including omitted or repeated IDs. Confirmation disables while submitting, retries are deduplicated, and pages follow approvals closed or handled from the command line.
- Incoming versions keep comments, questions and approval drafts on their original version while you are editing. Comment drafts survive reloads in the same tab; approval drafts also recover when editing a submitted answer. Leaving unsaved edits shows the browser's warning.
- Full-text results follow the selected type, agent, unread and archive filters. Live list updates preserve search focus, project renaming and expanded controls.
- Extensive file comparisons stop within a memory and work budget and offer links to read each version separately.
- Mobile project switching manages focus and background interaction. Text contrast, approval field labels, summary time and to-do progress names are improved. Notification passwords are masked with an explicit show/hide control.
- Settings explain which changes save automatically, show unsaved notification edits, and fit narrow screens. Waiting lists show three items initially; the rest expand with a remembered choice.
- Item headers separate labeled metadata from version history, file lists and publication details. Expanding details keeps every toggle in place, with keyboard access and Escape to collapse.
- The **Update** button on the home page keeps working after the list refreshes itself, for example when an agent publishes while the page is open; before, it did nothing until you reloaded the page.
- Added Node regressions and isolated browser tests; the browser suite also runs in CI.
- A new README with current screenshots.

## 0.1.1 (2026-10-31)

**If you installed 0.1.0, run `mydash update` once** (or ask your agent to). 0.1.0 cannot look for new versions; from 0.1.1 on, mydash tells you itself.

- Updates follow releases: mydash checks the repository it was installed from once a day and shows "mydash 0.1.2 is available" at the top of the home page, with a one-tap Update button. Settings → Updates switches to installing at night (3–5 am), or off. `mydash update` installs the latest release, `mydash update --check` only looks. Commits on `main` between releases are not offered.
- If the new version does not start, the update goes back to the previous one by itself.
- A phone notification when a new version is available (if notifications are set up), and after an automatic update.
- `mydash doctor` shows the installed version and whether a newer one exists.
- Codex items show the ChatGPT mark in the source badge and filter.
- `--access tailscale-node`: the address now follows the device's real name. If the name is taken (`mydash-1`), mydash uses and accepts that name, and tells you; before it kept giving `http://mydash/` and refused the real name.
- `--access tailscale-node`: before the device is approved, install and `mydash publish` give the local address, and switch within a minute after the approval.
- Install and `mydash doctor` say plainly when this computer is not on the tailnet, and which address to use instead. The install result has a new `localUrl` field.

## 0.1.0 (2026-10)

First public version.

- Publish Markdown, PDF, images, HTML, CSV and Excel, Word and PowerPoint, audio, video and code; read them rendered on a computer or a phone.
- Projects by folder, detected from Claude Code and Codex session records; versions, unread state, pins, search, project renaming, dark mode.
- Shows which tool published each item (Claude Code, Codex, or any tool that sets `MYDASH_AGENT`), with a filter by tool; `mydash rebuild --agents` fills this in for older items.
- Installed by a coding agent: `INSTALL.md`, `setup.sh` / `setup.cmd` with `--json`, `mydash doctor`, `mydash integrate claude|codex` (reversible), `mydash update`, `mydash uninstall`.
- macOS (launchd), Linux (systemd user units) and Windows (Startup folder). Access only on this computer, or over Tailscale.
- HTML and SVG run on a separate port; publishing refuses secrets; English and Chinese interface.
- Comments on items (including on a selected passage) that agents read with `mydash feedback` and close with `--resolves`.
- Item types (plan / report / other) with filters; version comparison; Today page; muting, archiving and automatic archiving.
- Full-text search (`mydash search`); Bark / ntfy notifications; print / save as PDF.
- Publishing from another machine with a token (`mydash remote`, `setup install --remote`).
- Same-Wi-Fi access with an access code (`mydash lan`).
- Unchanged files are hard-linked between versions; `mydash rebuild --dedup` and `mydash prune`.
- Approval forms (```approval blocks), to-do lists the user ticks off (auto-ticked by `<!-- check: -->` commands in explicit to-dos), and "ask about this item" threads; `mydash approvals`, `todos`, `asks`, with `wait` to wake the agent.
- Questions, plan approvals and permission prompts from Claude Code and Codex (CLI and the ChatGPT desktop app) also show in mydash; `mydash ask` for any other tool.
- Notification channels: Bark, ntfy, Telegram, Pushover, group webhooks (WeCom, Feishu, DingTalk, Slack, Discord), email over SMTP and web push; several of each, each with a name and an on/off switch.
- macOS: `--service launchd-boot` starts mydash at boot, before anyone logs in; `mydash forward` passes SSH or Screen Sharing through the dedicated Tailscale node.
- Page language per device; settings save as you change them.
- Each notification channel on the settings page has a step-by-step setup guide (English and Chinese); the email guide fills in the server settings for Gmail, QQ Mail, 163 Mail and iCloud.

Security and robustness, from a code review before release:

- Workbench pages carry a Content Security Policy, and Markdown / Word content can no longer run script there (raw `<script>`, `<base>`, `<meta>` and `javascript:` links are neutralised).
- The LAN login check uses the same normalised path as the router, so a remote-publishing token cannot reach other APIs; path segments with an encoded `/` are refused; the post-login redirect only goes to this site.
- To-do auto-checks run only in explicit to-dos and show their command; a timeout kills the whole process group.
- Item locks are refreshed while held and never removed by someone else; page actions use their own lock; Office conversion no longer blocks the server.
- Uninstalling or updating one install no longer touches another install's rules, hooks or Codex rules; hook updates keep their position (Codex trust is positional); hooks the user removed stay removed; settings files keep their formatting.
- `claude -p` sessions are left alone by the hooks; subagent and parallel permission prompts are matched to the right tool call; the Codex desktop app's `request_user_input_async` is handled.
- `sudo mydash service boot` parses the plists with `plutil` and only touches the caller's own services; uninstalling a boot-time setup asks for that step first.
