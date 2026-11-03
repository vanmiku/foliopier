import { esc } from './render.mjs';
import { t } from './i18n.mjs';

export function articleSidebar({ sessions, toc, project, slug, ver, file, scope, reason, agentIcons }) {
  const data = {
    sessions,
    project,
    scope,
    reason,
    id: `${project}/${slug}`,
    v: ver.v,
    file,
    title: ver.title,
    agent: ver.agent
  };
  const links = toc.map((x) => `<li class="d${x.depth}"><a href="#${esc(x.id)}">${x.text}</a></li>`).join('');
  return `<div class="article-tools"><button type="button" class="act" data-article-open="contents" aria-controls="article-rail">${t('Contents')}</button><button type="button" class="act" data-article-open="conversation" aria-controls="article-rail">${t('Agent conversation')}</button></div>
  <div class="article-rail-mask" hidden></div><aside class="article-rail" id="article-rail" aria-label="${t('Document companion')}">
    <div class="article-drawer-head"><strong>${t('Document companion')}</strong><button type="button" class="act" data-article-close>${t('Close')}</button></div>
    <div class="article-rail-toolbar"><nav class="article-modes" role="tablist" aria-label="${t('Contents')} / ${t('Agents')}"><button type="button" role="tab" id="article-mode-contents" class="act" data-article-mode="contents" aria-selected="false" aria-controls="article-contents-pane" tabindex="-1">${t('Contents')}</button><button type="button" class="act" role="tab" id="article-tab-codex" aria-controls="article-conversation-pane" data-article-agent="codex" aria-selected="false" tabindex="-1"><span class="article-agent-icon ag-codex" aria-hidden="true">${agentIcons.codex}</span><span>Codex</span></button><button type="button" class="act" role="tab" id="article-tab-claude" aria-controls="article-conversation-pane" data-article-agent="claude" aria-selected="false" tabindex="-1"><span class="article-agent-icon ag-claude" aria-hidden="true">${agentIcons.claude}</span><span>Claude Code</span></button></nav><button type="button" class="linkish article-expand" data-article-expand aria-label="${t('Expand conversation')}" title="${t('Expand conversation')}">${t('Expand')}</button></div>
    <section class="article-contents" id="article-contents-pane" role="tabpanel" tabindex="0" aria-labelledby="article-mode-contents" hidden><nav id="article-toc" class="toc" aria-label="${t('Contents')}">${links ? `<ol>${links}</ol>` : `<p class="set-hint">${t('This file has no headings.')}</p>`}</nav></section>
    <section class="article-conversation" id="article-conversation-pane" role="tabpanel" tabindex="0" aria-labelledby="article-tab-codex">
    <div class="article-chat-panel" id="article-chat-panel"><label class="article-session-label" for="article-session">${t('Session')}</label><select id="article-session" hidden></select><div class="article-session-meta"><p class="article-session-state" role="status"></p><button type="button" class="linkish" data-article-switch aria-expanded="false" aria-controls="article-session">${t('Switch conversation')}</button><button type="button" class="linkish" data-article-details aria-expanded="false" aria-controls="article-session-detail">${t('Session details')}</button></div><p class="article-session-detail" id="article-session-detail" data-article-session-detail hidden></p>
    <div class="article-session-update" hidden><span></span><button type="button" class="act" data-article-current>${t('Follow current conversation')}</button></div>
    <div class="article-delivery" role="status" aria-live="polite" hidden><p></p><small></small><button type="button" class="linkish" data-article-cancel-delivery hidden>${t('Cancel queued message')}</button></div>
    <div class="article-messages" tabindex="0" aria-label="${t('Recent conversation')}"></div>
    <div class="article-selection" hidden><p>${t('Selected from the article')}</p><blockquote></blockquote><div><button type="button" class="act" data-article-quote>${t('Add to question')}</button><button type="button" class="linkish" data-article-clear-selection>${t('Cancel')}</button></div></div>
    <div class="article-compose-bar"><button type="button" class="article-compose-summary linkish" id="article-compose-summary" data-article-send-help aria-expanded="false" aria-controls="article-send-reason"></button><button type="button" class="act" data-article-compose-toggle aria-expanded="false" aria-controls="article-compose" aria-describedby="article-compose-summary">${t('Record a question')}</button></div><p class="article-send-reason set-hint" id="article-send-reason" hidden></p><button type="button" class="linkish article-switch-codex" data-article-switch-codex hidden>${t('Switch to Codex')}</button><form class="article-compose" id="article-compose" hidden><div class="article-quote" hidden><p>${t('Attached article passage')}</p><blockquote></blockquote><button type="button" class="linkish" data-article-unquote>${t('Remove quote')}</button></div><label for="article-message">${t('Question to keep for {agent}', { agent: ver.agent || t('Agent') })}</label><textarea id="article-message" maxlength="8000" rows="2" aria-describedby="article-compose-hint"></textarea><div class="article-image-preview" aria-label="${t('Attached images')}" hidden></div><input id="article-image-files" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden><p class="article-send-hint set-hint" id="article-compose-hint"></p><div class="article-compose-actions"><button type="button" class="act" data-article-add-image hidden>${t('Add images')}</button><button type="button" class="act" data-article-copy>${t('Copy question')}</button><button type="submit" class="act" disabled>${t('Send')}</button></div></form><p class="article-send-status" role="status" aria-live="polite"></p></div></section>
  </aside><script type="application/json" id="article-session-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}
