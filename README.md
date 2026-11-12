<div align="center">

<img src="docs/brand/mark.svg" width="72" height="72" alt="FolioPier AI symbol">

# FolioPier AI

**Read, review and share what your AI agents make.**

Claude Code and Codex publish the files. You read them on your computer or phone, answer questions, compare versions and share the finished work.

[![Release](https://img.shields.io/github/v/release/vanmiku/foliopier?color=b7441c&label=release)](https://github.com/vanmiku/foliopier/releases)
[![Tests](https://github.com/vanmiku/foliopier/actions/workflows/test.yml/badge.svg)](https://github.com/vanmiku/foliopier/actions/workflows/test.yml)
[![MIT](https://img.shields.io/badge/license-MIT-555)](LICENSE)

[Get started](#get-started) · [How it works](#how-it-works) · [Document sharing](#share-selected-work) · [Connection guide](docs/sessions.md) · [中文](README.zh-CN.md)

</div>

<img src="docs/readme/en-hero.png" width="100%" alt="FolioPier AI on a laptop and phone, showing project deliverables and a rendered document.">

## Your agent works. You stay in the review.

Plans, reports, prototypes and spreadsheets deserve a readable home. FolioPier AI is a local-first workbench for the deliverables your coding agents produce. It adds rendered files, project organization, version history, questions and feedback to the workflow you already use.

Published files stay on your machine. There is no hosted account to create. The computer running the workbench must stay online for remote access and temporary document sharing.

## How it works

1. **The agent publishes.** A file or folder becomes a project item. Publishing the same slug again creates the next version.
2. **You review.** Read the rendered content, comment on a passage, answer a question or complete an approval form from your computer or phone.
3. **The work moves forward.** The agent reads your feedback and publishes the revision. Compare changes and share selected files when they are ready.

Installation adds guidance to Claude Code and Codex so they know when to publish and how to read your answers.

## Get started

Paste this into Claude Code or Codex:

```text
Install FolioPier AI for me by following https://github.com/vanmiku/foliopier/blob/main/INSTALL.md
```

Your agent checks the machine, walks you through access and language choices, installs the workbench and reports its address. You handle account authorizations or system password prompts when needed.

**Requires:** Node.js 20 or newer on macOS, Linux or Windows 10/11. LibreOffice is optional for Word and PowerPoint previews. Remote access can use Tailscale; same-network access is also available with an access code and device approval.

On the hosting computer, `http://127.0.0.1:4870/` works without Tailscale while the service is running. Use `foliopier url --local` if you chose another port.

<details>
<summary>Install from source</summary>

```bash
git clone https://github.com/vanmiku/foliopier
cd foliopier
./setup.sh check --json
./setup.sh install --access local --lang en --json
foliopier doctor --json
```

On Windows, use `setup.cmd` instead of `./setup.sh`. For access options, services and upgrading an existing installation, follow [INSTALL.md](INSTALL.md) and the [compatibility notes](docs/compatibility.md).

</details>

## Read the actual files

- **Documents and data:** Markdown with contents, tables, code and Mermaid diagrams; PDF, images, HTML, CSV and Excel tables, Office layout previews, source code, audio and video.
- **Versions:** History and comparisons, with changed words highlighted where supported. A newer version does not discard an in-progress answer or comment.
- **Reading on a phone:** Responsive navigation, light and dark themes, Chinese and English, and print/PDF views.
- **Feedback in context:** Passage comments, approval forms, choices and to-dos. Your agent can read and resolve the feedback as it publishes revisions.

<img src="docs/readme/en-phones.png" width="100%" alt="FolioPier AI mobile views for document reading, questions and sharing.">

## Continue a conversation while reading

Articles offer Contents / Codex / Claude Code tabs. Enable conversation viewing and message sending separately in Settings. Supported connections can send text, with image upload and paste on the Codex App connection. Pending, delivered and completed messages have separate states.

These adapters are **opt-in preview features** with narrower platform coverage than the workbench. The Codex App connector currently requires its supported local IPC environment; automatic wake is implemented on macOS. Verified tmux connections and Claude App Code Remote Control have their own requirements. Accounts, usage limits and original Agent permissions still apply. Ordinary approved LAN browsers can read conversations but cannot send.

Read the [capability matrix and troubleshooting guide](docs/sessions.md) before enabling a connection.

## Share selected work

Turn on **Settings → Internet document sharing**, then use **Share** on an article. Choose the files, access code, expiry, version behavior, PDF downloads and private visitor comments.

Visitors open a browser link without joining your tailnet. The dedicated Tailscale Funnel reader exposes the selected document bundle; Agent conversations and workbench controls stay private. HTML attachments use static, script-free previews. PDF downloads depend on the sharing computer's browser setup.

**Keep the hosting computer online.** This is temporary sharing from your machine, not always-on cloud storage. See the [sharing and setup guide](docs/sharing.md).

## Built around your machine

The server uses Node.js HTTP and stores versioned files locally. The workbench and script-capable file previews use separate origins. Trusted local/Tailnet access and approved ordinary LAN access have different capabilities; public sharing has its own listener and access controls.

The workbench supports launchd, systemd, Windows Startup or a plain background process. Updates follow tested stable releases, and installation preserves existing data and access choices. [Security model](SECURITY.md) · [Connection limits](docs/sessions.md) · [Existing-install compatibility](docs/compatibility.md)

## For agents and contributors

```bash
foliopier publish report.md --slug review --title "Project review"
foliopier feedback --json
foliopier doctor --json
```

The [agent skill](skills/mydash/SKILL.md) explains publishing, questions, approvals and to-dos. To work on the source, read [AGENTS.md](AGENTS.md). Report vulnerabilities through a [private security advisory](https://github.com/vanmiku/foliopier/security/advisories/new).

FolioPier AI is independent of OpenAI and Anthropic. Claude Code, Codex and other product names belong to their respective owners.

[MIT license](LICENSE) · Built by [vanmiku](https://github.com/vanmiku)
