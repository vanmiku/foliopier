# Temporary document sharing

The host needs FolioPier AI and a Tailscale client that supports Funnel. Visitors need only a browser, a share link and its access code.

## Setup

1. Open **Settings → Internet document sharing** and select **Enable internet sharing**.
2. Complete the Tailscale sign-in and Funnel authorization shown by the page. An organization administrator may need to permit this device.
3. After authorization, return to FolioPier AI and select **Enable internet sharing** again. In 0.3.0, **Check again** only reads the status; it does not retry setup. Local service, Funnel configuration, PDF readiness and external verification are separate checks.
4. If you came from an article, use **Return to document and continue sharing** to restore the draft.

FolioPier AI uses a dedicated HTTPS port, 8443 or 10000. It preserves other routes and the private workbench on port 443. Initial DNS propagation may take time. A successful local check does not prove internet reachability; test from a phone with Wi-Fi turned off.

One-click PDF downloads require Chrome, Chromium or Edge on the hosting computer. Reading still works when the PDF browser is missing. The settings page links to browser installation instructions.

## Share and manage

Choose **Share** on an article. The main Markdown document is selected; choose any additional files yourself. Use the visitor preview to check the public content, then generate a link and 8-digit code. Codes appear only on creation or reset; the store retains salted hashes. Copy the full share information or copy the link and code separately.

Shares default to 24 hours and support 1 hour, 7 days or a custom expiry, up to 30 days. They follow published updates by default, or can remain on the version being viewed. Local file edits are not public until published. Newly referenced resources require owner approval; visitors retain the previous shared version while approval is pending.

Visitors can switch shared files, read tables and diagrams, download allowed PDFs and leave private comments. HTML attachments are isolated static previews without document scripts. Agent conversations, internal feedback, approval answers and workbench controls are excluded from the sharing interface. Review the document itself before sharing; secret scanning cannot identify every sensitive passage.

Read comments in the article's share manager, in Settings or through `foliopier feedback`. Comments retain the file and version and are labelled as external, untrusted input. They never send instructions to an Agent. A visitor can see only comments belonging to that browser session.

Extend a share, reset its code, change selected files or stop it from the share manager. Resetting the code invalidates existing visitor sessions. Archiving an article does not stop sharing; the interface warns about active links. Turning off all sharing revokes old links, which do not return when sharing is re-enabled. Saved downloads cannot be recalled.

Keep the host online with FolioPier AI and Tailscale running. There is no cloud copy to serve visitors while the host sleeps or loses connectivity. The device domain appears in public certificate records; certificate issuance does not publish the document body.

See the [official Tailscale Funnel guide](https://tailscale.com/docs/features/tailscale-funnel).
