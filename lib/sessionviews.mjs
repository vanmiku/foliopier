import { Marked } from 'marked';
import hljs from 'highlight.js';
import { esc } from './render.mjs';
import { t, locale } from './i18n.mjs';
import { layout } from './views.mjs';
import { agentInfo } from './agents.mjs';
export function sessionRows(sessions) {
  if (!sessions.length)
    return `<p class="set-hint">${t('No sessions have reported here yet. Send a message in your terminal to register it.')}</p>`;
  const row = (s) =>
    `<a class="session-row" href="/sessions/${encodeURIComponent(s.id)}"><span class="session-state state-${esc(s.state)}">${stateLabel(s.state)}</span><span><strong>${esc(agentInfo(s.agent)?.name || s.agent)} · ${esc(s.title)}</strong><small>${esc(s.preview)}</small></span></a>`;
  const active = sessions.filter((s) => s.state !== 'ended'),
    ended = sessions.filter((s) => s.state === 'ended');
  return (
    active.map(row).join('') +
    (ended.length
      ? `<details class="session-ended"><summary>${t('Ended')} · ${ended.length}</summary>${ended.map(row).join('')}</details>`
      : '')
  );
}
export function sessionSection(sessions, project = '') {
  return `<details class="session-section" open><summary>${t('Terminal sessions')} · ${sessions.length}</summary><div data-session-list data-project="${esc(project)}">${sessionRows(sessions)}</div></details>`;
}
export function stateLabel(state) {
  if (state === 'needs_input') return t('Needs confirmation');
  return state === 'busy'
    ? t('Working')
    : state === 'idle'
      ? t('Idle')
      : state === 'ended'
        ? t('Ended')
        : t('Status unknown');
}
// Conversations render Markdown, but never document forms, executable HTML or remote images.
function safeMessageUrl(href) {
  try {
    const url = new URL(href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
const messageMarkdown = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return esc(text);
    },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens),
        url = safeMessageUrl(href);
      return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    },
    image({ href, text }) {
      const label = esc(text || href),
        url = safeMessageUrl(href);
      return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    },
    code({ text, lang }) {
      const language = (lang || '').split(/\s+/)[0];
      const code =
        language && hljs.getLanguage(language)
          ? hljs.highlight(text, { language, ignoreIllegals: true }).value
          : esc(text);
      return `<pre><code class="hljs">${code}</code></pre>`;
    }
  }
});
function renderMessage(text) {
  return messageMarkdown
    .parse(String(text || ''))
    .replace(/<table>/g, '<div class="session-table"><table>')
    .replace(/<\/table>/g, '</table></div>');
}
export function messageRows(rows, agent = '') {
  return rows
    .map((m) => {
      if (m.kind === 'tools')
        return `<details class="session-tools"><summary>${t('{n} tool call|{n} tool calls', { n: m.tools.length })}</summary><p>${esc(m.tools.join(' · '))}</p></details>`;
      const date = m.at ? new Date(m.at) : null;
      const time =
        date && Number.isFinite(date.getTime())
          ? `<time datetime="${date.toISOString()}" title="${esc(date.toLocaleString(locale()))}">${esc(date.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }))}</time>`
          : '';
      const speaker = m.kind === 'user' ? t('You') : agentInfo(agent)?.name || t('Agent');
      return `<article class="session-message ${m.kind === 'user' ? 'user' : 'assistant'}" data-agent="${esc(agent)}"><header class="session-message-meta"><strong class="session-speaker">${esc(speaker)}</strong>${time}</header>${m.attachments?.length ? `<p class="session-attachments">${t('{n} attachment|{n} attachments', { n: m.attachments.length })}</p>` : ''}<div class="session-markdown">${renderMessage(m.text)}</div></article>`;
    })
    .join('');
}
export function sessionPage(s) {
  const body = `<header class="page-head"><div><p><a href="/p/${encodeURIComponent(s.project)}">${esc(s.project)}</a></p><h1 class="page-title">${esc(agentInfo(s.agent)?.name || s.agent)}</h1><p class="page-sub">${esc(s.title)} · <span data-session-state>${stateLabel(s.state)}</span></p></div></header>
 <div id="session-chat" data-session-id="${esc(s.id)}"><p class="set-hint">${t('Recent conversation only. Tool output and internal reasoning are not shown.')}</p><div class="session-messages" id="session-messages">${messageRows(s.messages, s.agent)}</div>
 <div class="session-deliveries article-delivery" hidden role="status" aria-live="polite"></div><form id="session-send"><label for="session-text">${t('Message this session')}</label><textarea id="session-text" name="message" maxlength="12000" rows="4" required${s.canSend ? '' : ' disabled'}></textarea><p class="set-hint" data-session-send-hint>${s.canSend ? s.transport==='codex-app'?t('Connected to Codex App'):s.transport==='claude-remote'?t('Connected to Claude Remote Control'):t('Connected to the original tmux session') : t('Sending is unavailable. Check the connection or messaging settings.')}</p><button class="act" type="submit"${s.canSend ? '' : ' disabled'}>${t('Send')}</button><p class="session-send-status" role="status" aria-live="polite"></p></form></div>`;
  return layout({ title: t('Terminal sessions'), page: 'session', body, data: { project: s.project } });
}
