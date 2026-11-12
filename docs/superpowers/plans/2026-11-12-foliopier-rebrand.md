# FolioPier AI Implementation Plan

> **For agentic workers:** Implement task-by-task in this session; review the whole branch independently before landing. Steps use checkbox syntax for tracking.

**Goal:** Ship the FolioPier AI identity and GitHub presentation while preserving existing installations.

**Architecture:** Use shared brand constants and native SVG assets. Keep persisted/internal identifiers compatible, add the primary CLI alias, and update visible copy and presentation. Rename the existing GitHub repository after the pull-request head passes CI, preserving its identity and redirects.

**Tech Stack:** Existing Node.js HTTP server, SVG/CSS, Python Playwright for isolated presentation checks, GitHub Actions.

**Spec:** `docs/plans/2026-11-12-foliopier-rebrand-design.md`

## Global Constraints

- Product name: FolioPier AI. Primary CLI: foliopier. Legacy CLI: mydash.
- No new runtime dependencies. Existing storage and protocol/permission identifiers remain compatible.
- macOS, Linux, and Windows remain supported; keep the existing mobile type scale and theme behavior.
- Version: 0.3.1 in package.json/package-lock.json/CHANGELOG.md; stable release only after CI.
- No domain purchase/DNS deployment, cloud service, or publication of private user content.

## Review Focus

- A legacy installation must still update from its saved old repository URL without losing data or send permissions.
- Both CLI names must work after install and be removed safely on uninstall, including Windows shims.
- Branding must reach English, Chinese, notifications, PWA metadata, public shares and PDF credits without rewriting user content.
- The longer name and primary mark must remain legible on narrow screens and in dark mode.
- New public documentation must install a released version that actually has the new CLI and assets.

### Task 1: Native identity and visible application branding

**Files:** `lib/brand.mjs`, `static/icon.svg`, raster icons/favicon, `lib/views.mjs`, `server.mjs`, `static/app.css`, `static/sw.js`, public share views/locales and other visible copy.
**Interfaces:** Brand constants and SVG markup are trusted local values, with no new request trust or data-storage behavior.

- [x] Create the selected vector mark, companion artwork and practical raster/icon sizes.
- [x] Update visible English/Chinese text, document/PWA titles, notifications, share header/footer and PDF credits; preserve protocol keys and user-supplied variables.
- [x] Verify rendered English/Chinese home, article, settings and public reader, with desktop/mobile and light/dark checks.
- [x] Run i18n checks and affected page/share regressions.

### Task 2: CLI and installation compatibility

**Files:** `package.json`, `package-lock.json`, CLI entry/wrappers, `lib/setup.mjs`, install/integration/checks output, affected install/upgrade tests.
**Interfaces:** Both installed command names reach the same existing entry point and HOME/configuration. Legacy Agent hooks remain usable.

- [x] Add the foliopier command/shims on supported systems, retaining mydash aliases and safe cleanup.
- [x] Update user/Agent instructions and primary command examples without changing stored data or authorization.
- [x] Verify install → both commands → publish → reinstall/upgrade → uninstall in an isolated home; include Windows-mode coverage in CI.

### Task 3: Public documentation and release preparation

**Files:** English/Chinese README, INSTALL/SECURITY/guides/welcome content, synthetic README screenshots, brand assets, CHANGELOG.md and version metadata.
**Interfaces:** Installation points to the same renamed repository and stable release workflow; product capabilities retain documented limitations.

- [x] Rewrite README around read/review/share workflow, replace old visual branding and add compact installation/support links.
- [x] Audit other current public docs, brand links and visible copy; preserve historical release facts and compatibility identifiers where necessary.
- [x] Set 0.3.1 consistently and add release notes explaining the primary/legacy commands and preserved installation.
- [x] Run text hygiene, complete local tests, installation test and browser regressions; inspect image assets and links.

### Task 4: Independent review and GitHub landing

**Files:** Final branch and GitHub repository settings.
**Interfaces:** Existing repository identity, PR/issue history and old URL redirects are retained.

- [x] Have a fresh reviewer examine the whole branch for compatibility, privacy, branding omissions and documentation accuracy; fix findings locally.
- [ ] Push one reviewable branch/PR and require all five CI groups to succeed at the exact head.
- [ ] Rename the existing repository to vanmiku/foliopier, update About/topics and local remote, verify old Git URL redirects.
- [ ] Merge with match-head-commit; follow main CI and automatic v0.3.1 release.
- [ ] Verify normal local upgrade through the old saved remote, installed source equality and retained settings/data; publish the final review and real links.

Execution is native in this existing chat, within the user's request to implement and update GitHub. The logo selection does not authorize overwriting historical user documents or purchasing the domain.
