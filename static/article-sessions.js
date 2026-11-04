(() => {
  const node = document.getElementById('article-session-data');
  if (!node) return;
  const data = JSON.parse(node.textContent);
  const T = (key, vars = {}) =>
    (window.__LANG === 'en' ? key : window.__T?.[key] || key).replace(/\{(\w+)\}/g, (_, n) => vars[n] ?? '');
  const rail = document.getElementById('article-rail');
  const $ = (selector) => rail.querySelector(selector);
  const tabs = [...rail.querySelectorAll('.article-modes [role=tab]')];
  const select = $('#article-session'),
    picker = $('.article-session-picker'),
    popup = $('.article-session-picker-popover'),
    search = $('#article-session-search'),
    switchButton = $('[data-article-switch]'),
    input = $('#article-message'),
    box = $('.article-messages');
  const form = $('.article-compose'),
    send = form.querySelector('[type=submit]');
  const status = $('.article-send-status'),
    state = $('.article-session-state');
  const prefix = 'mydash.article.' + JSON.stringify([data.id, data.v, data.file]);
  const mobile = matchMedia('(max-width: 1199px), (max-height: 599px)');
  const newId = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, '0')).join('');
  const load = (key) => {
    try {
      return JSON.parse(sessionStorage.getItem(key)) || {};
    } catch {
      return {};
    }
  };
  const store = (key, value) => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {}
  };
  const projectKey = 'mydash.project-chat.' + (data.scope || data.project || data.id.split('/')[0]);
  const choices = load(projectKey);
  choices.pins ||= {};
  let sessions = data.sessions,
    agent = ['codex', 'claude'].includes(choices.agent)
      ? choices.agent
      : data.sessions[0]?.agent || (data.agent === 'claude' ? 'claude' : 'codex');
  let id = '',
    draft = {},
    pending = false,
    uploading = false,
    available = false,
    sendReason = 'not_connected',
    transport = null,
    waitingForReply = false,
    generation = 0,
    lastHtml = null,
    selection = '',
    opener = null;
  let polling = false,
    restoreScroll = true,
    loaded = false,
    composerTouched = false;
  let inertNodes = [],
    priorOverflow = '',
    articleScroll = null;
  const draftKey = () => prefix + '.' + agent + '.' + (id || 'unselected');
  function save() {
    draft.text = input.value;
    if (
      !restoreScroll &&
      !$('.article-conversation').hidden &&
      (!mobile.matches || rail.classList.contains('is-open'))
    )
      draft.scroll = box.scrollTop;
    store(draftKey(), draft);
  }
  function showQuote() {
    $('.article-quote').hidden = !draft.quote;
    $('.article-quote blockquote').textContent = draft.quote || '';
  }
  function compose(open, manual = false) {
    form.hidden = !open;
    const toggle = $('[data-article-compose-toggle]');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open
      ? T('Hide input')
      : input.value.trim() || draft.quote
        ? T('Continue question')
        : available
          ? T('Message {agent}', { agent: agentName() })
          : T('Record a question');
    if (manual) {
      composerTouched = true;
      draft.composeOpen = open;
      save();
    }
  }
  $('[data-article-compose-toggle]').addEventListener('click', () => {
    compose(form.hidden, true);
    if (!form.hidden) input.focus({ preventScroll: true });
  });
  $('[data-article-details]').addEventListener('click', () => {
    const detail = $('[data-article-session-detail]'),
      button = $('[data-article-details]');
    detail.hidden = !detail.hidden;
    button.setAttribute('aria-expanded', String(!detail.hidden));
  });
  function setAvailable(value, reason = sendReason) {
    available = value;
    sendReason = reason;
    if (value && !composerTouched) compose(true);
    else compose(!form.hidden);
    send.disabled = pending || uploading || !available || !id;
    const imageButton = $('[data-article-add-image]');
    imageButton.hidden = agent !== 'codex' || transport !== 'codex-app';
    imageButton.disabled = pending || uploading || !available || (draft.images?.length || 0) >= 4;
    $('#article-image-files').disabled = imageButton.disabled;
  }
  function agentName() {
    return agent === 'claude' ? 'Claude Code' : 'Codex';
  }
  function hint() {
    const help = $('[data-article-send-help]');
    help.textContent = !id
      ? T('Choose a session to continue.')
      : available
        ? transport === 'codex-app'
          ? T('Connected to Codex App')
          : transport === 'claude-remote'
            ? T('Connected to Claude Remote Control')
            : T('Connected to the original tmux session')
        : T('Sync only');
    help.disabled = available || !id;
    help.title = available
      ? T('Messages go to this project conversation.')
      : T('Why is sending unavailable?');
    const contextReason =
      data.reason === 'discovering'
        ? T('Still indexing older conversations. This list updates automatically.')
        : data.reason === 'project_ambiguous'
          ? T(
              'This project name refers to several folders. Republish this article from its correct project folder to connect safely.'
            )
          : data.reason === 'project_remote'
            ? T(
                'This article was published from another computer. Continue its conversation on that computer.'
              )
            : data.reason === 'project_missing'
              ? T('The project folder is unavailable. Republish this article from the current folder.')
              : null;
    const reason =
      contextReason ||
      (!id
        ? agent === 'codex'
          ? T('No Codex conversation has synced for this project. Open it in Codex App and send a message.')
          : T('No Claude Code conversation has synced for this project yet.')
        : sendReason === 'disabled'
          ? T('Web messaging is turned off in Settings. Conversation syncing still works.')
          : sendReason === 'ended'
            ? T('This conversation has ended. Its records are still available.')
            : sendReason === 'lan'
              ? T(
                  'This device can view conversations. Sending is available only on this computer or a trusted Tailscale connection.'
                )
              : agent === 'claude'
                ? sendReason === 'claude_busy'
                  ? T(
                      'Claude is working or waiting for approval. Send when it is idle, or continue in Claude App.'
                    )
                  : sendReason === 'claude_login'
                    ? T(
                        'Sign in to Claude Code on this computer, then try again. mydash uses your existing account.'
                      )
                    : sendReason === 'claude_forbidden'
                      ? T(
                          'Claude refused access to this conversation. Check the account and connection permissions in Claude App.'
                        )
                      : sendReason === 'claude_trusted'
                        ? T(
                            'Claude requires trusted-device verification for this conversation. Continue in Claude App; mydash cannot send to protected sessions yet.'
                          )
                        : sendReason === 'claude_offline'
                          ? T(
                              'The original Claude session is offline. Open it and keep Remote Control connected.'
                            )
                          : sendReason === 'claude_unavailable'
                            ? T(
                                'Claude Remote Control did not respond. Keep the original session open and try again.'
                              )
                            : T(
                                'In Claude App, open this session and turn on Remote Control in its details. A running tmux session can also connect directly.'
                              )
                : sendReason === 'app_not_open'
                  ? T(
                      'Codex App is running, but this conversation is not connected. Open this exact conversation on the computer hosting mydash, then retry.'
                    )
                  : sendReason === 'app_closed'
                    ? T('Start Codex App on this computer to connect this conversation.')
                    : sendReason === 'app_mismatch'
                      ? T(
                          'The App conversation belongs to a different project folder. Select the correct conversation in Codex App.'
                        )
                      : sendReason === 'app_incompatible'
                        ? T(
                            'This Codex App connection version is unsupported. Sending is paused to protect the conversation.'
                          )
                        : sendReason === 'app_history_limit'
                          ? T(
                              'This Codex conversation is too large to sync. Select a shorter conversation to connect.'
                            )
                          : sendReason === 'app_unavailable'
                            ? T(
                                'Codex App did not respond. Keep the App running and open this conversation, then try again.'
                              )
                            : T(
                                'Open this conversation in Codex App on this computer. mydash will connect automatically.'
                              ));
    const explanation = $('#article-send-reason');
    explanation.textContent = reason;
    const reasonKey = agent + ':' + sendReason + ':' + Boolean(id);
    if (available) {
      explanation.hidden = true;
      help.setAttribute('aria-expanded', 'false');
    } else if (
      help.dataset.reason !== reasonKey &&
      (agent === 'claude' || !id || sendReason.startsWith('app_') || sendReason === 'ended')
    ) {
      explanation.hidden = false;
      help.setAttribute('aria-expanded', 'true');
    }
    help.dataset.reason = reasonKey;
    $('[data-article-switch-codex]').hidden =
      available ||
      agent !== 'claude' ||
      ['disabled', 'lan'].includes(sendReason) ||
      !sessions.some((s) => s.agent === 'codex' && s.state !== 'ended');
    $('[data-article-reconnect]').hidden =
      available || !id || agent !== 'codex' || !sendReason.startsWith('app_');
    $('.article-send-hint').textContent = available
      ? agent === 'codex'
        ? T('Only your message and the images or passages you attach will be sent.')
        : T('Only your message and any passages you attach will be sent.')
      : T('Kept on this page. Copy it and paste it into the original conversation to send.');
    form.querySelector('label').textContent = available
      ? T('Message {agent}', { agent: agentName() })
      : T('Question to keep for {agent}', { agent: agentName() });
    input.placeholder = T('For example: explain this paragraph or suggest a change…');
    send.hidden = !available;
    $('[data-article-copy]').hidden = available;
    $('[data-article-quote]').textContent = available ? T('Attach passage') : T('Add to question');
  }
  $('[data-article-reconnect]').addEventListener('click', async () => {
    const token = generation,
      button = $('[data-article-reconnect]');
    const label = T('Connecting to Codex App…');
    button.disabled = true;
    status.textContent = label;
    try {
      await pollChat();
    } finally {
      button.disabled = false;
      if (token === generation && status.textContent === label) status.textContent = '';
    }
  });
  $('[data-article-switch-codex]').addEventListener('click', () => {
    if (pending || uploading) return;
    choose('codex', '', true);
    mode('conversation');
  });
  $('[data-article-send-help]').addEventListener('click', () => {
    const explanation = $('#article-send-reason');
    explanation.hidden = !explanation.hidden;
    $('[data-article-send-help]').setAttribute('aria-expanded', String(!explanation.hidden));
  });
  function closePicker(restoreFocus = false) {
    popup.hidden = true;
    switchButton.setAttribute('aria-expanded', 'false');
    if (restoreFocus) switchButton.focus({ preventScroll: true });
  }
  function openPicker(keyboard = false) {
    if (pending || uploading || switchButton.disabled) return;
    search.value = '';
    delete select.dataset.signature;
    popup.hidden = false;
    renderSelect();
    switchButton.setAttribute('aria-expanded', 'true');
    if (keyboard) (select.querySelector('[aria-selected="true"]') || search).focus();
    else search.focus({ preventScroll: true });
  }
  switchButton.addEventListener('click', () => (popup.hidden ? openPicker() : closePicker()));
  switchButton.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      openPicker(true);
    }
  });
  document.addEventListener('click', (event) => {
    if (!popup.hidden && !picker.contains(event.target)) closePicker();
  });
  picker.addEventListener('focusout', (event) => {
    if (event.relatedTarget && !picker.contains(event.relatedTarget)) closePicker();
  });
  picker.addEventListener('keydown', (event) => {
    if (popup.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePicker(true);
      return;
    }
    const options = [...select.querySelectorAll('[role=option]')];
    const index = options.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = Math.min(index + 1, options.length - 1);
    else if (event.key === 'ArrowUp') next = index < 0 ? options.length - 1 : Math.max(0, index - 1);
    else if (index >= 0 && event.key === 'Home') next = 0;
    else if (index >= 0 && event.key === 'End') next = options.length - 1;
    if (next !== undefined && options[next]) {
      event.preventDefault();
      options[next].focus({ preventScroll: true });
      options[next].scrollIntoView({ block: 'nearest' });
    }
  });
  search.addEventListener('input', () => {
    select.scrollTop = 0;
    renderSelect();
  });
  select.addEventListener('click', (event) => {
    const option = event.target.closest('[role=option]');
    if (!option || pending || uploading) return;
    choose(agent, option.dataset.value, true);
    closePicker(true);
  });
  function latestFor(agentId) {
    const matching = sessions.filter((s) => s.agent === agentId);
    return matching.find((s) => s.current) || matching[0];
  }
  function sessionState(value) {
    return value === 'busy'
      ? T('Working')
      : value === 'idle'
        ? T('Idle')
        : value === 'ended'
          ? T('Ended')
          : value === 'needs_input'
            ? T('Needs confirmation')
            : T('Status unknown');
  }
  const sessionTime = new Intl.DateTimeFormat(window.__LANG === 'en' ? 'en' : 'zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  function updatedAt(value) {
    const time = new Date(value);
    return Number.isFinite(time.getTime())
      ? T('Updated {time}', {
          time: sessionTime.format(time),
        })
      : '';
  }
  function renderSelect() {
    const current = sessions.filter((s) => s.agent === agent);
    const target = current.find((s) => s.id === id);
    const title = target?.title || (id ? T('Session unavailable') : T('No session for this agent yet.'));
    $('[data-article-target-mode]').textContent = choices.pins[agent]
      ? T('Selected conversation')
      : T('Following latest');
    $('[data-article-target-title]').textContent = title;
    switchButton.title = title;
    switchButton.setAttribute(
      'aria-label',
      T('Switch conversation') + ': ' + title + ' · ' + $('[data-article-target-mode]').textContent
    );
    switchButton.disabled = pending || uploading || !current.length;
    if (popup.hidden) return;
    const query = search.value.trim().toLocaleLowerCase();
    const signature = JSON.stringify([current, id, choices.pins[agent], query]);
    if (select.dataset.signature === signature) return;
    select.dataset.signature = signature;
    const focused = select.contains(document.activeElement)
      ? document.activeElement.dataset.value
      : undefined;
    const pickerScroll = select.scrollTop;
    select.replaceChildren();
    const text = (tag, value, className = '') => {
      const n = document.createElement(tag);
      n.textContent = value;
      if (className) n.className = className;
      return n;
    };
    const option = (value, title, session, following = false) => {
      const o = document.createElement('button');
      o.type = 'button';
      o.className = 'article-session-option';
      o.dataset.value = value;
      o.setAttribute('role', 'option');
      o.setAttribute('aria-selected', String(value === (choices.pins[agent] || '')));
      o.tabIndex = -1;
      const heading = text('span', '', 'article-picker-heading');
      const name = text('strong', title);
      name.dataset.sessionTitle = '';
      heading.append(
        name,
        text('span', value === (choices.pins[agent] || '') ? '✓' : '', 'article-picker-check')
      );
      heading.lastChild.setAttribute('aria-hidden', 'true');
      o.append(heading);
      if (following)
        o.append(
          text('span', session?.title || T('No session for this agent yet.'), 'article-picker-follow-target')
        );
      if (session) {
        const meta = text('span', '', 'article-picker-meta');
        const badge = text('span', sessionState(session.state), 'article-picker-state');
        badge.dataset.state = session.state;
        meta.append(badge);
        if (session.current && !following) meta.append(text('span', T('Latest in project')));
        const time = updatedAt(session.at);
        if (time) meta.append(text('span', time));
        o.append(meta);
        if (!following) {
          if (session.preview) o.append(text('span', session.preview, 'article-picker-preview'));
          const source =
            session.transport === 'codex-app'
              ? 'Codex App'
              : session.transport === 'claude-remote'
                ? 'Claude Remote Control'
                : session.transport === 'tmux'
                  ? 'tmux'
                  : T('Sync only');
          o.append(text('span', source + ' · #' + session.id.slice(-12), 'article-picker-source'));
        }
      }
      select.append(o);
    };
    if (!query && current.length) option('', T('Follow current conversation'), latestFor(agent), true);
    for (const session of current) {
      if (
        query &&
        ![session.title, session.preview, session.id].join(' ').toLocaleLowerCase().includes(query)
      )
        continue;
      option(session.id, session.title, session);
    }
    $('.article-picker-empty').hidden = Boolean(select.children.length);
    select.scrollTop = pickerScroll;
    if (focused !== undefined && !popup.hidden) {
      const replacement = [...select.children].find((o) => o.dataset.value === focused);
      (replacement || search).focus({ preventScroll: true });
    }
  }
  function choose(nextAgent, nextId, manual = false) {
    if (pending || uploading) return;
    if (loaded) save();
    agent = nextAgent;
    const current = sessions.filter((s) => s.agent === agent);
    if (manual) {
      if (nextId) choices.pins[agent] = nextId;
      else delete choices.pins[agent];
    }
    const preferred = nextId ?? choices.pins[agent];
    if (preferred && !current.some((s) => s.id === preferred)) delete choices.pins[agent];
    id = current.some((s) => s.id === preferred) ? preferred : latestFor(agent)?.id || '';
    choices.agent = agent;
    store(projectKey, choices);
    closePicker();
    $('.article-session-update').hidden = true;
    sendReason = current.find((s) => s.id === id)?.sendReason || 'not_connected';
    generation++;
    lastHtml = null;
    restoreScroll = true;
    draft = load(draftKey());
    input.value = typeof draft.text === 'string' ? draft.text : '';
    status.textContent = '';
    showQuote();
    showImages();
    composerTouched =
      typeof draft.composeOpen === 'boolean' || Boolean(input.value || draft.quote || draft.images?.length);
    compose(draft.composeOpen ?? Boolean(input.value || draft.quote || draft.images?.length));
    loaded = true;
    box.replaceChildren();
    showDelivery([]);
    const empty = document.createElement('p');
    empty.className = 'set-hint';
    empty.textContent = id
      ? T('Loading conversation…')
      : T('Open this project in your agent and send a message to register its conversation.');
    box.appendChild(empty);
    syncTabs();
    renderSelect();
    setAvailable(false);
    hint();
    const s = current.find((s) => s.id === id);
    state.textContent = s ? T('Loading conversation…') : T('Choose a session to continue.');
    $('[data-article-session-detail]').textContent =
      T('Project: {project}', { project: data.project || data.id.split('/')[0] }) +
      '\n' +
      (id || T('No session selected')) +
      '\n' +
      T('About {title}, v{v}', { title: data.title, v: data.v }) +
      '\n' +
      data.file;
    pollChat();
  }
  async function read(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw Error(r.status);
    return r.json();
  }
  function showDelivery(deliveries = []) {
    const delivery = deliveries.at(-1),
      card = $('.article-delivery');
    waitingForReply = deliveries.some((d) =>
      [
        'queued',
        'waiting_receipt',
        'waiting_connection',
        'paused',
        'dispatching',
        'working',
        'needs_input',
        'processing_failed',
        'uncertain',
      ].includes(d.state)
    );
    window.mydashRenderDeliveries(card, deliveries, transport);
  }
  $('.article-delivery').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-article-cancel-delivery]');
    if (!button || button.disabled) return;
    const nonce = button.dataset.nonce;
    button.disabled = true;
    try {
      const response = await fetch('/api/sessions/cancel', {
        method: 'POST',
        headers: { 'X-Mydash': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, nonce, stopWaiting: button.dataset.stopWaiting === 'true' }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      await pollChat();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  async function pollChat() {
    if (!id || document.hidden) return;
    const token = generation,
      target = id;
    try {
      const r = await read('/api/sessions/' + encodeURIComponent(target));
      if (token !== generation) return;
      const current = sessions.find((s) => s.id === target);
      if (current && r.session.state) current.state = r.session.state;
      renderSelect();
      state.textContent = r.stateLabel;
      if (lastHtml !== r.html) {
        const atBottom = box.scrollHeight - box.clientHeight - box.scrollTop < 100;
        const scroll = box.scrollTop;
        box.innerHTML = r.html || '';
        if (!r.html) {
          const p = document.createElement('p');
          p.className = 'set-hint';
          p.textContent = T('No conversation yet.');
          box.appendChild(p);
        }
        if (!$('.article-conversation').hidden && (!mobile.matches || rail.classList.contains('is-open'))) {
          box.scrollTop = restoreScroll
            ? (draft.scroll ?? box.scrollHeight)
            : atBottom
              ? box.scrollHeight
              : scroll;
          restoreScroll = false;
        } else restoreScroll = true;
        lastHtml = r.html;
      }
      transport = r.session.transport;
      const details = $('[data-article-session-detail]');
      let appLink = details.querySelector('a');
      if (/^claude:\/\/code\/session_[A-Za-z0-9]{8,80}$/.test(r.session.appUrl || '')) {
        if (!appLink) {
          appLink = document.createElement('a');
          details.append(document.createElement('br'), appLink);
        }
        appLink.href = r.session.appUrl;
        appLink.textContent = T('View this shared conversation in Claude App');
      } else if (appLink) appLink.remove();
      showDelivery(r.session.deliveries);
      setAvailable(r.session.canSend, r.session.sendReason || 'not_connected');
      hint();
    } catch {
      if (token !== generation) return;
      setAvailable(false);
      hint();
      state.textContent = T('Session unavailable');
      status.textContent = T('The session is unavailable. Your draft is kept.');
    }
  }
  async function poll() {
    if (
      document.hidden ||
      polling ||
      pending ||
      $('#article-conversation-pane').hidden ||
      (mobile.matches && !rail.classList.contains('is-open'))
    )
      return;
    polling = true;
    try {
      const r = await read('/api/article-sessions?id=' + encodeURIComponent(data.id) + '&v=' + data.v);
      if (r.scope !== undefined && data.scope && r.scope !== data.scope) {
        setAvailable(false);
        status.textContent = T('The project folder changed. Refresh to load its current conversations.');
        return;
      }
      sessions = r.sessions;
      data.reason = r.reason;
      renderSelect();
      const next = latestFor(agent);
      if (!choices.pins[agent] && next && next.id !== id) {
        const readingPast = box.scrollHeight - box.clientHeight - box.scrollTop > 120;
        if (
          popup.hidden &&
          !waitingForReply &&
          !draft.images?.length &&
          !input.value.trim() &&
          !draft.quote &&
          !form.contains(document.activeElement) &&
          !readingPast
        ) {
          choose(agent);
          return;
        } else {
          const update = $('.article-session-update');
          const message =
            input.value.trim() || draft.quote
              ? T('A newer project conversation is available. Your draft stays in this one.')
              : T('A newer project conversation is available.');
          if (update.dataset.target !== next.id) {
            update.querySelector('span').textContent = message;
            update.dataset.target = next.id;
          }
          update.hidden = false;
        }
      } else $('.article-session-update').hidden = true;
      if (id && !sessions.some((s) => s.id === id)) {
        setAvailable(false);
        state.textContent = T('Session unavailable');
      } else await pollChat();
    } catch {
      setAvailable(false);
      status.textContent = T('The session is unavailable. Your draft is kept.');
    } finally {
      polling = false;
    }
  }
  $('[data-article-current]').addEventListener('click', () => choose(agent, '', true));
  input.addEventListener('input', () => {
    draft.nonce = null;
    composerTouched = true;
    draft.composeOpen = true;
    save();
  });
  box.addEventListener(
    'scroll',
    () => {
      if (!restoreScroll) save();
    },
    { passive: true }
  );
  window.addEventListener('pagehide', save);
  document.addEventListener('selectionchange', () => {
    const s = getSelection(),
      sheet = document.querySelector('.sheet');
    if (s && !s.isCollapsed && sheet?.contains(s.anchorNode) && sheet.contains(s.focusNode)) {
      selection = s.toString().slice(0, 3000);
      $('.article-selection').hidden = !selection.trim();
      $('.article-selection blockquote').textContent = selection;
    }
  });
  $('[data-article-clear-selection]').addEventListener('click', () => {
    selection = '';
    $('.article-selection').hidden = true;
  });
  $('[data-article-quote]').addEventListener('click', () => {
    if (pending) return;
    if (!selection) {
      status.textContent = T('Select a passage in the document first.');
      return;
    }
    compose(true, true);
    draft.quote = selection;
    selection = '';
    $('.article-selection').hidden = true;
    status.textContent = T('Article passage attached. Now write your question.');
    draft.nonce = null;
    showQuote();
    save();
    input.focus({ preventScroll: true });
  });
  $('[data-article-unquote]').addEventListener('click', () => {
    if (pending) return;
    draft.quote = '';
    draft.nonce = null;
    showQuote();
    save();
  });
  function showImages() {
    draft.images = (Array.isArray(draft.images) ? draft.images : [])
      .filter((image) => /^[a-f0-9]{40}$/.test(image.id || ''))
      .slice(0, 4);
    const preview = $('.article-image-preview');
    preview.replaceChildren();
    preview.hidden = !draft.images.length;
    for (const image of draft.images) {
      const tile = document.createElement('div'),
        img = document.createElement('img'),
        remove = document.createElement('button');
      img.src = '/api/session-images/' + image.id;
      img.alt = image.name || T('Image');
      remove.type = 'button';
      remove.className = 'act';
      remove.textContent = '×';
      remove.dataset.removeImage = image.id;
      remove.setAttribute('aria-label', T('Remove image {name}', { name: image.name || T('Image') }));
      remove.addEventListener('click', () => {
        if (pending || uploading) return;
        fetch('/api/sessions/images/discard', {
          method: 'POST',
          headers: { 'X-Mydash': '1', 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, image: image.id }),
        }).catch(() => {});
        draft.images = draft.images.filter((x) => x.id !== image.id);
        draft.nonce = null;
        showImages();
        save();
        setAvailable(available);
      });
      tile.append(img, remove);
      preview.append(tile);
    }
  }
  async function addImages(files) {
    if (pending || uploading || !available || transport !== 'codex-app' || !files.length) return;
    if (files.length + (draft.images?.length || 0) > 4) {
      status.textContent = T('You can attach up to 4 images.');
      return;
    }
    if (files.some((file) => file.size > 5 * 1024 * 1024)) {
      status.textContent = T('Each image must be 5 MB or smaller.');
      return;
    }
    uploading = true;
    setAvailable(available);
    switchButton.disabled = true;
    tabs.forEach((tab) => (tab.disabled = true));
    status.textContent = T('Uploading images…');
    try {
      for (const file of files) {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(Error(T('Could not read this image.')));
          reader.readAsDataURL(file);
        });
        const response = await fetch('/api/sessions/images', {
          method: 'POST',
          headers: { 'X-Mydash': '1', 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, name: file.name, data }),
        });
        const result = await response.json();
        if (!response.ok) throw Error(result.error);
        draft.images ||= [];
        draft.images.push(result.image);
        draft.nonce = null;
        draft.composeOpen = true;
        composerTouched = true;
        showImages();
        save();
      }
      compose(true);
      status.textContent = T('Images attached. Send them with a message or on their own.');
    } catch (error) {
      status.textContent = error.message || T('Could not upload this image.');
    } finally {
      uploading = false;
      $('#article-image-files').value = '';
      tabs.forEach((tab) => (tab.disabled = false));
      renderSelect();
      setAvailable(available);
    }
  }
  $('[data-article-add-image]').addEventListener('click', () => $('#article-image-files').click());
  $('#article-image-files').addEventListener('change', (event) => addImages([...event.target.files]));
  input.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith('image/'));
    if (files.length && available && transport === 'codex-app') {
      event.preventDefault();
      addImages(files);
    }
  });
  $('[data-article-copy]').addEventListener('click', async () => {
    if (!input.value.trim()) {
      status.textContent = T('Write your question first.');
      input.focus({ preventScroll: true });
      return;
    }
    const question = (draft.quote ? '> ' + draft.quote + '\n\n' : '') + input.value;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(question);
      else {
        const copy = document.createElement('textarea');
        copy.value = question;
        copy.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        rail.appendChild(copy);
        try {
          copy.select();
          if (!document.execCommand('copy')) throw Error();
        } finally {
          copy.remove();
          input.focus({ preventScroll: true });
        }
      }
      status.textContent = T('Question copied. Paste it into your original {agent} conversation to send.', {
        agent: agentName(),
      });
    } catch {
      status.textContent = T('Could not copy. Select the question and copy it manually.');
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (pending || uploading || !available || !id || (!input.value.trim() && !draft.images?.length)) return;
    const payload = JSON.stringify({
      text: input.value,
      quote: draft.quote || '',
      comment: draft.comment || null,
      images: (draft.images || []).map((image) => image.id),
    });
    if (draft.payload !== payload) {
      draft.nonce = newId();
      draft.payload = payload;
    }
    draft.nonce ||= newId();
    save();
    const text = input.value,
      quote = draft.quote || '',
      target = id;
    pending = true;
    setAvailable(available);
    switchButton.disabled = true;
    tabs.forEach((t) => (t.disabled = true));
    input.readOnly = true;
    status.textContent = T('Sending…');
    try {
      const r = await fetch('/api/sessions/send', {
        method: 'POST',
        headers: { 'X-Mydash': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: target,
          text,
          quote,
          comment: draft.comment || null,
          nonce: draft.nonce,
          images: (draft.images || []).map((image) => image.id),
          article: { id: data.id, v: data.v, file: data.file },
        }),
      });
      const result = await r.json();
      if (!r.ok) throw Error(result.error || T('That did not work. Try again in a moment.'));
      input.value = '';
      draft = {};
      showQuote();
      showImages();
      save();
      status.textContent = ['codex-app', 'claude-remote'].includes(result.transport)
        ? ''
        : T('Handed to the terminal. Waiting for the conversation to update.');
      waitingForReply = true;
      await pollChat();
    } catch (error) {
      save();
      status.textContent =
        error.message || T('Check the terminal before retrying. The previous delivery may have reached it.');
    } finally {
      pending = false;
      input.readOnly = false;
      tabs.forEach((t) => (t.disabled = false));
      renderSelect();
      setAvailable(available);
    }
  });
  function syncTabs() {
    rail.dataset.agent = agent;
    const contents = rail.dataset.mode === 'contents';
    for (const tab of tabs) {
      const active = contents ? tab.dataset.articleMode === 'contents' : tab.dataset.articleAgent === agent;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    $('.article-conversation').setAttribute('aria-labelledby', 'article-tab-' + agent);
  }
  function mode(value, refresh = true) {
    const resuming = loaded && rail.dataset.mode === 'contents' && value === 'conversation';
    if (!['contents', 'conversation'].includes(value)) value = 'conversation';
    if (loaded && rail.dataset.mode === 'conversation') save();
    rail.dataset.mode = value;
    choices.mode = value;
    store(projectKey, choices);
    $('.article-contents').hidden = value !== 'contents';
    $('.article-conversation').hidden = value !== 'conversation';
    syncTabs();
    if (resuming && refresh) pollChat();
    if (value === 'contents') closePicker();
    if (value === 'conversation')
      requestAnimationFrame(() => {
        if (lastHtml !== null) {
          box.scrollTop = draft.scroll ?? box.scrollHeight;
          restoreScroll = false;
        }
      });
  }
  function activate(tab) {
    if (pending) return;
    if (tab.dataset.articleMode === 'contents') mode('contents');
    else {
      const switching = tab.dataset.articleAgent !== agent;
      if (switching) choose(tab.dataset.articleAgent);
      mode('conversation', !switching);
    }
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', (e) => {
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? tabs.length - 1
            : e.key === 'ArrowRight'
              ? (index + 1) % tabs.length
              : e.key === 'ArrowLeft'
                ? (index + tabs.length - 1) % tabs.length
                : null;
      if (next === null || pending) return;
      e.preventDefault();
      tabs[next].focus();
      activate(tabs[next]);
    });
  });
  const mask = document.querySelector('.article-rail-mask');
  function close() {
    closePicker();
    save();
    rail.classList.remove('is-open', 'is-expanded');
    mask.hidden = true;
    rail.removeAttribute('role');
    rail.removeAttribute('aria-modal');
    for (const n of inertNodes) n.inert = false;
    inertNodes = [];
    document.body.style.overflow = priorOverflow;
    document.querySelectorAll('[data-article-open]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    opener?.focus({ preventScroll: true });
    opener = null;
    size();
    if (articleScroll) window.scrollTo(articleScroll.x, articleScroll.y);
    articleScroll = null;
  }
  function open(value, trigger, expanded = false) {
    mode(value);
    if (!mobile.matches && !expanded) {
      compose(true, true);
      input.focus({ preventScroll: true });
      return;
    }
    if (rail.classList.contains('is-open')) return;
    opener = trigger || document.activeElement;
    priorOverflow = document.body.style.overflow;
    articleScroll = { x: window.scrollX, y: window.scrollY };
    rail.classList.add('is-open');
    if (value === 'conversation') pollChat();
    rail.classList.toggle('is-expanded', expanded);
    mask.hidden = false;
    rail.setAttribute('role', 'dialog');
    rail.setAttribute('aria-modal', 'true');
    document.body.style.overflow = 'hidden';
    inertNodes = [
      ...document.querySelectorAll('.doc-main, .side, .topbar, .tabbar, .foot, .article-tools'),
    ].filter((n) => !n.inert);
    inertNodes.forEach((n) => (n.inert = true));
    document.querySelectorAll('[data-article-open]').forEach((b) => b.setAttribute('aria-expanded', 'true'));
    $('[data-article-close]').focus();
  }
  document
    .querySelectorAll('[data-article-open]')
    .forEach((b) => b.addEventListener('click', () => open(b.dataset.articleOpen, b)));
  $('[data-article-expand]').addEventListener('click', (e) => open('conversation', e.currentTarget, true));
  $('[data-article-close]').addEventListener('click', close);
  mask.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (!rail.classList.contains('is-open')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
    if (e.key === 'Tab') {
      const focusable = [
        ...rail.querySelectorAll('button, input, textarea, a, [tabindex="0"], summary'),
      ].filter((n) => !n.disabled && n.tabIndex >= 0 && n.getClientRects().length);
      const first = focusable[0],
        last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  });
  $('#article-toc').addEventListener('click', (e) => {
    if (e.target.closest('a') && rail.classList.contains('is-open')) close();
  });
  function size() {
    if (!mobile.matches && !rail.classList.contains('is-expanded'))
      rail.style.setProperty(
        '--rail-height',
        Math.max(280, innerHeight - Math.max(rail.getBoundingClientRect().top, 72) - 16) + 'px'
      );
  }
  mobile.addEventListener('change', () => {
    if (!mobile.matches && rail.classList.contains('is-open') && !rail.classList.contains('is-expanded'))
      close();
    size();
  });
  window.addEventListener('resize', size);
  window.addEventListener('scroll', size, { passive: true });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.cm-agent');
    if (!b || pending) return;
    if (
      Number(b.dataset.commentVersion) !== data.v ||
      (b.dataset.commentFile && b.dataset.commentFile !== data.file)
    ) {
      open('conversation', b);
      status.textContent = T('Open the comment’s version and file before sending it.');
      return;
    }
    const target = sessions.find((s) => s.id === id) || latestFor(agent);
    if (!target) {
      open('conversation', b);
      status.textContent = T('No project conversation is available yet.');
      return;
    }
    const card = b.closest('.cm-item');
    choose(target.agent, target.id);
    if (input.value.trim()) {
      open('conversation', b);
      status.textContent = T('Your draft is kept. Clear it before adding a comment.');
      return;
    }
    input.value = card.querySelector(':scope > p')?.textContent || '';
    draft.quote = card.querySelector('blockquote')?.textContent || '';
    compose(true, true);
    draft.comment = b.dataset.comment;
    draft.nonce = null;
    showQuote();
    save();
    open('conversation', b);
    input.focus({ preventScroll: true });
  });
  mode(choices.mode || 'conversation');
  choose(agent);
  size();
  setInterval(poll, 3000);
})();
