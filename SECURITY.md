# Security

mydash is meant for one person's own machine and tailnet. This computer and the tailnet need no login: anyone who can reach the port there can read everything published. Devices on the same Wi-Fi need an access code plus explicit approval from this computer or a trusted Tailnet connection. Temporary sessions expire within 12 hours; remembered sessions within 30 days. Keep it on `127.0.0.1` or behind Tailscale, and do not expose it to the internet.

What it does to limit damage:

- The server listens on `127.0.0.1` only and checks the `Host` header (DNS rebinding).
- Write requests need a custom header, a JSON body and a same-origin `Origin`.
- Published HTML and SVG run from a separate port, a different origin, so their scripts cannot call the workbench.
- Workbench pages carry a Content Security Policy that allows only mydash's own scripts; raw `<script>`, `<base>` and `javascript:` links in Markdown and Word documents are neutralised as well.
- To-do auto-checks (`<!-- check: … -->`) run only in explicit to-dos, show their command on the page, have a 15-second limit, and never run for items published from another machine.
- Hooks for Claude Code and Codex leave sessions nobody is watching (`claude -p`, the Agent SDK) alone.
- `mydash publish` refuses `.env` files, private keys and files containing API tokens unless `--allow-secret` is given.

To report a vulnerability, open a [private security advisory](https://github.com/vanmiku/mydash/security/advisories/new) on GitHub rather than a public issue.

## Optional conversation connections

Viewing and sending are off by default and enabled separately. Viewing exposes recent original project conversations to anyone authorized to open this workbench, not only the files published here. Tool outputs and internal reasoning are omitted; secret-pattern filtering is an additional safeguard, not a guarantee that every sensitive fact is recognized. Only use this feature with workbench readers you trust.

Local and trusted Tailnet browsers can send when enabled. Ordinary authorized LAN browsers can read conversations but cannot send, manage deliveries, upload/read session images or clean image storage. Native conversation APIs retain the same workbench origin and custom-header checks. Project association uses canonical folders and excludes remote/cloud/SSH/WSL sessions from local handoff.

Codex App messages travel over a private, same-user local socket with owner, project and protocol checks. CLI messages use a verified process-start/TTY/tmux mapping and literal bracketed paste, with draft and approval checks. Claude Remote Control messages use Anthropic's existing session endpoint and native login; message content therefore passes through the Agent's existing service. Original Agent permissions and sandbox settings are inherited, not weakened. Uncertain submissions are not automatically repeated.

On macOS, a boot service may create a same-user GUI LaunchAgent to read the existing unlocked login keychain. Its directory and Unix socket are private (0700/0600); it relays only an unexpired access credential in memory, not a refresh token or disk credential cache. Disabling session viewing prevents credential service. `mydash uninstall` removes the helper and private socket. Native account login, account limits and trusted-device enrollment stay in the original client.

Delivery records and uploaded images are private files under `~/.mydash/state`. Text receipts remain for retry deduplication and status history. Removing an unused draft attachment releases its upload; unused images expire after 30 days and can be explicitly cleaned in Settings. Queued/active and sent attachments are protected by default. Explicitly deleting completed attachments may make images in earlier conversation history unavailable. Export or retain images before doing so if that history matters. Browser drafts live in that tab's sessionStorage and may be removed by private browsing or clearing browser storage. See [the conversation guide](docs/sessions.md).
