# Changelog

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
