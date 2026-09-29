/* Druckplatte – Frontend. Alle Daten kommen vom Server und sind dort bereits datenschutzgefiltert:
 * fremde private Aufträge werden nie an den Browser übertragen (kein Ausblenden per CSS). */
(function () {
  'use strict';

  const COLORS = [
    { name: 'Weiß', hex: '#F2F1ED' }, { name: 'Schwarz', hex: '#2B2A2E' }, { name: 'Grau', hex: '#8B8B93' },
    { name: 'Rot', hex: '#E4573D' }, { name: 'Blau', hex: '#3E7CE0' }, { name: 'Grün', hex: '#4CAF7D' },
    { name: 'Gelb', hex: '#F2C744' }, { name: 'Orange', hex: '#F2884B' }, { name: 'Transparent', hex: '#C9CBCE' },
    { name: 'Silber', hex: '#B8BCC2' }, { name: 'Gold', hex: '#D4AF57' }, { name: 'Sonstige', hex: '#7C9CFF' },
  ];
  const FILAMENTS = ['PLA', 'PETG', 'ABS', 'TPU', 'ASA', 'Nylon', 'PLA+', 'Resin', 'Sonstige'];
  const STATUS = {
    ready: { label: 'Fertigstellung', cls: 'status-ready' },
    progress: { label: 'In Bearbeitung', cls: 'status-progress' },
    fail: { label: 'Geht nicht', cls: 'status-fail' },
  };
  const POLL_MS = 5000;
  const ADMIN_EXTRA_EVERY = 6; // Support/Benutzer für Admins alle 6 Live-Updates nachladen

  const state = {
    me: null,
    live: null,
    liveKey: '',
    clockSkew: 0,
    support: [],
    users: [],
    devices: [],
    activeFilter: null,
    editingId: null,
    currentType: 'model',
    pendingImage: '',
    imageDirty: false,
    deepLink: parseDeepLink(),
    pollTimer: null,
    pollCount: 0,
    loginEmail: '',
    highlight: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const grid = $('#grid');
  const emptyState = $('#emptyState');
  const gridHeading = $('#gridHeading');
  const overlay = $('#overlay');
  const supportOverlay = $('#supportOverlay');
  const textOverlay = $('#textOverlay');
  const profileOverlay = $('#profileOverlay');
  const adminOverlay = $('#adminOverlay');
  const toastEl = $('#toast');

  // ------------------------------------------------------------------ Hilfen

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
  }

  /** Nur http(s)-Links und eigene Bild-URLs werden in href/src übernommen. */
  function safeUrl(url) {
    const value = String(url || '');
    if (/^\/api\/images\/[A-Za-z0-9_-]+$/.test(value)) return value;
    if (/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
    } catch {
      return '';
    }
  }

  function colorHex(name) {
    const c = COLORS.find((x) => x.name === name);
    return c ? c.hex : '#7C9CFF';
  }

  function isMakerWorldLink(url) {
    try {
      const parsed = new URL(url);
      return /^https?:$/.test(parsed.protocol) && /(^|\.)makerworld\.com(\.cn)?$/i.test(parsed.hostname);
    } catch {
      return false;
    }
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }
  function formatDate(ts) {
    return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function formatDateTime(ts) {
    return new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function formatClock(ts) {
    return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
  function formatDuration(minutes) {
    const min = Math.max(0, Math.round(minutes));
    if (min < 60) return `${min} Min.`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} Std. ${m} Min.` : `${h} Std.`;
  }
  function serverNow() {
    return Date.now() - state.clockSkew;
  }
  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  // ------------------------------------------------------------------ API

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  async function api(method, path, body) {
    const init = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch {
      throw new ApiError(0, 'network', 'Keine Verbindung zum Server');
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* leere Antwort */
    }
    const authCall = path.startsWith('/api/auth/request-code') || path.startsWith('/api/auth/verify-code');
    if (res.status === 401 && !authCall) {
      onLoggedOut(data.error === 'access_required');
      throw new ApiError(401, data.error, data.message || 'Anmeldung erforderlich');
    }
    if (!res.ok) throw new ApiError(res.status, data.error, data.message || 'Unerwarteter Fehler');
    return data;
  }

  async function run(action, successMessage) {
    try {
      const result = await action();
      if (successMessage) toast(successMessage);
      return result;
    } catch (err) {
      if (err.status !== 401) toast(err.message);
      return null;
    }
  }

  // ------------------------------------------------------------------ Anmeldung

  function showGate(accessRequired) {
    $('#loginGate').hidden = false;
    $('#emailForm').hidden = false;
    $('#codeForm').hidden = true;
    setGateError(accessRequired ? 'Die Cloudflare-Access-Anmeldung ist abgelaufen – bitte Seite neu laden.' : '');
    fetch('/api/health')
      .then((r) => r.json())
      .then((h) => {
        $('#g-preview-note').hidden = h.env !== 'preview';
      })
      .catch(() => {});
    setTimeout(() => $('#g-email').focus(), 50);
  }
  function hideGate() {
    $('#loginGate').hidden = true;
  }
  function setGateError(msg) {
    $('#g-error').textContent = msg || '';
  }

  $('#emailForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#g-email').value.trim();
    const btn = $('#g-send');
    btn.disabled = true;
    setGateError('');
    try {
      await api('POST', '/api/auth/request-code', { email });
      state.loginEmail = email;
      $('#g-code-hint').textContent = `Falls die Adresse berechtigt ist, haben wir einen Code an ${email} gesendet. Er ist 10 Minuten gültig.`;
      $('#emailForm').hidden = true;
      $('#codeForm').hidden = false;
      $('#g-code').value = '';
      setTimeout(() => $('#g-code').focus(), 50);
    } catch (err) {
      setGateError(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('#codeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('#g-code').value.replace(/\s+/g, '');
    const btn = $('#g-verify');
    btn.disabled = true;
    setGateError('');
    try {
      await api('POST', '/api/auth/verify-code', { email: state.loginEmail, code });
      const me = await api('GET', '/api/me');
      await startApp(me);
      toast('Angemeldet – dieses Gerät ist jetzt 30 Tage vertrauenswürdig');
    } catch (err) {
      setGateError(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('#g-back').addEventListener('click', () => {
    $('#codeForm').hidden = true;
    $('#emailForm').hidden = false;
    setGateError('');
  });

  /** Entfernt alle zuvor empfangenen Daten aus JS-Zustand und DOM. */
  function wipePrivateState() {
    state.me = null;
    state.live = null;
    state.liveKey = '';
    state.support = [];
    state.users = [];
    state.devices = [];
    for (const id of ['grid', 'publicGrid', 'currentPrint', 'queueView', 'ideaList', 'supportList', 'userList', 'deviceList', 'statChips']) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    }
    $('#queueTotal').textContent = '';
    $('#profileEmail').textContent = '';
    $('#profileLabel').textContent = 'Profil';
    $('#s-model').innerHTML = '<option value="">Kein bestimmtes Modell</option>';
    for (const id of ['liveSection', 'publicSection', 'usersSection']) $(`#${id}`).hidden = true;
    for (const id of ['#supportSection', '#ideaSection', '#emptyState', '#gridHeading']) $(id).style.display = 'none';
    closeAllOverlays();
  }

  function onLoggedOut(accessRequired) {
    stopPolling();
    wipePrivateState();
    showGate(accessRequired);
  }

  // ------------------------------------------------------------------ Start & Live-Sync

  async function startApp(me) {
    state.me = me;
    hideGate();
    $('#previewFlag').hidden = me.env !== 'preview';
    $('#profileLabel').textContent = me.user.email;
    applyRoleUI();
    await refreshAll();
    startPolling();
    handleDeepLink();
  }

  async function refreshAll() {
    await refreshLive({ render: false });
    if (state.me && state.me.isAdmin) await Promise.all([loadSupport(), loadUsers()]);
    render();
  }

  async function refreshLive({ render: doRender = true } = {}) {
    const live = await api('GET', '/api/live');
    if (!state.me) return;
    state.clockSkew = Date.now() - live.serverTime;
    const { serverTime, ...rest } = live;
    const key = JSON.stringify(rest);
    const changed = key !== state.liveKey;
    // Zustand wird vollständig ersetzt (nicht gemischt) – was der Server nicht mehr liefert, ist weg.
    state.live = live;
    state.liveKey = key;
    if (live.isAdmin !== state.me.isAdmin) {
      state.me.isAdmin = live.isAdmin;
      if (!live.isAdmin) {
        state.support = [];
        state.users = [];
      }
      applyRoleUI();
    }
    if (!doRender) return;
    if (changed) render();
    else renderCurrentPrint();
  }

  async function pollOnce() {
    if (!state.me || document.visibilityState !== 'visible') return;
    state.pollCount += 1;
    try {
      await refreshLive();
      if (state.me && state.me.isAdmin && state.pollCount % ADMIN_EXTRA_EVERY === 0) {
        await Promise.all([loadSupport(), loadUsers()]);
        renderSupportInbox();
        renderUsers();
        renderChips();
      }
    } catch {
      /* nächster Versuch beim nächsten Intervall */
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(pollOnce, POLL_MS);
  }
  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pollOnce();
  });

  async function loadSupport() {
    const data = await api('GET', '/api/support');
    state.support = data.messages || [];
  }
  async function loadUsers() {
    const data = await api('GET', '/api/admin/users');
    state.users = data.users || [];
  }

  // ------------------------------------------------------------------ Deep-Links aus E-Mails

  function parseDeepLink() {
    const p = location.pathname;
    const m = /^\/auftrag\/([^/]+)$/.exec(p);
    if (m) {
      try {
        return { kind: 'order', ref: decodeURIComponent(m[1]) };
      } catch {
        return null;
      }
    }
    if (p === '/support') return { kind: 'support' };
    if (p === '/profil') return { kind: 'profile' };
    return null;
  }

  function handleDeepLink() {
    const link = state.deepLink;
    if (!link) return;
    state.deepLink = null;
    history.replaceState(null, '', '/');
    if (link.kind === 'order') {
      const target = document.querySelector(`[data-dp="${CSS.escape(link.ref)}"]`);
      if (target) {
        // Hervorhebung bleibt auch über Live-Updates (Neu-Rendern) hinweg 8 Sekunden bestehen.
        state.highlight = { ref: link.ref, until: Date.now() + 8000 };
        applyHighlight();
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => {
          state.highlight = null;
          applyHighlight();
        }, 8000);
      } else {
        toast('Auftrag nicht gefunden');
      }
    } else if (link.kind === 'support') {
      openSupportModal();
    } else if (link.kind === 'profile') {
      openProfile();
    }
  }

  function applyHighlight() {
    const active = state.highlight && Date.now() < state.highlight.until ? state.highlight.ref : null;
    document.querySelectorAll('[data-dp]').forEach((el) => el.classList.toggle('highlight', Boolean(active) && el.dataset.dp === active));
  }

  // ------------------------------------------------------------------ Rollen

  function isAdmin() {
    return Boolean(state.me && state.me.isAdmin);
  }

  function applyRoleUI() {
    if (!state.me) return;
    const adminUser = state.me.user.role === 'admin';
    $('#roleSwitch').hidden = !adminUser;
    $('#adminBtn').classList.toggle('active', isAdmin());
    $('#submitterBtn').classList.toggle('active', !isAdmin());
    $('#statusField').style.display = isAdmin() ? 'block' : 'none';
    const banner = $('#modeBanner');
    if (isAdmin()) {
      banner.className = 'mode-banner admin';
      banner.textContent = '🔒 Admin-Modus – du siehst alle Aufträge, Ideen, Support-Nachrichten und verwaltest die Warteschlange.';
    } else {
      banner.className = 'mode-banner';
      banner.textContent = '📤 Auftraggeber-Modus – du siehst deine eigenen Aufträge. Fremde private Drucke bleiben anonym.';
    }
    $('#emptyText').textContent = isAdmin()
      ? 'Noch keine Modelle auf der Platte.'
      : 'Reich dein erstes Druck-Modell ein – mit MakerWorld-Link, Farbe, Filament und Bild.';
  }

  $('#adminBtn').addEventListener('click', () => {
    if (isAdmin()) return;
    $('#a-password').value = '';
    $('#a-error').textContent = '';
    adminOverlay.classList.add('open');
    setTimeout(() => $('#a-password').focus(), 80);
  });
  $('#submitterBtn').addEventListener('click', async () => {
    if (!isAdmin()) return;
    await run(async () => {
      await api('POST', '/api/admin/leave');
      state.me.isAdmin = false;
      state.support = [];
      state.users = [];
      applyRoleUI();
      await refreshAll();
    }, 'Auftraggeber-Modus aktiv');
  });
  $('#adminForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#adminSubmit');
    btn.disabled = true;
    $('#a-error').textContent = '';
    try {
      await api('POST', '/api/admin/elevate', { password: $('#a-password').value });
      $('#a-password').value = '';
      adminOverlay.classList.remove('open');
      state.me.isAdmin = true;
      applyRoleUI();
      await refreshAll();
      toast('Admin-Modus aktiv');
    } catch (err) {
      $('#a-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
  const closeAdmin = () => adminOverlay.classList.remove('open');
  $('#closeAdmin').addEventListener('click', closeAdmin);
  $('#adminCancel').addEventListener('click', closeAdmin);
  adminOverlay.addEventListener('click', (e) => {
    if (e.target === adminOverlay) closeAdmin();
  });

  // ------------------------------------------------------------------ Darstellung

  function orders() {
    return state.live ? state.live.orders : [];
  }
  function taskOrders() {
    return orders().filter((o) => !(o.type === 'idea' && !o.accepted));
  }
  function pendingIdeas() {
    return orders().filter((o) => o.type === 'idea' && !o.accepted);
  }

  /** Warteschlangen-Position und aktueller Druck für eigene (bzw. als Admin: alle) Aufträge. */
  function printInfo() {
    const positions = new Map();
    let currentId = null;
    if (state.live) {
      for (const entry of state.live.queue.entries) {
        if (entry.order && entry.order.id) positions.set(entry.order.id, entry.position);
      }
      const cp = state.live.currentPrint;
      if (cp && cp.order && cp.order.id) currentId = cp.order.id;
    }
    return { positions, currentId };
  }

  function mediaHtml(imageUrl, color, cls) {
    const src = safeUrl(imageUrl);
    if (src) return `<img src="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
    return `<div class="swatch-fallback ${cls || ''}" style="background:${colorHex(color)}"></div>`;
  }

  function linkHtml(link) {
    const href = safeUrl(link);
    if (!href) return '<span class="link-empty">kein Link</span>';
    return `<a class="link-btn" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">↗ ${escapeHtml(href.replace(/^https?:\/\//, ''))}</a>`;
  }

  function tagsHtml(item, { idea = false, isPublic = false } = {}) {
    return `
      ${idea ? '<span class="tag idea-flag">💡 Idee</span>' : ''}
      ${isPublic ? '<span class="tag public-flag">🌍 Öffentlich</span>' : ''}
      <span class="tag"><span class="swatch-dot" style="background:${colorHex(item.color)}"></span>${escapeHtml(item.color || '—')}</span>
      <span class="tag">${escapeHtml(item.filament || '—')}</span>`;
  }

  function dpBlock(dpRef) {
    if (!dpRef) return '';
    return `<div class="dp-block"><span class="dp-label">Auftragsnummer</span><span class="dp-ref">${escapeHtml(dpRef)}</span></div>`;
  }

  function progressBar(percent) {
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    return `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}"><span style="width:${p}%"></span></div>`;
  }

  function render() {
    if (!state.me || !state.live) return;
    $('#liveSection').hidden = false;
    renderChips();
    renderSupportInbox();
    renderIdeaInbox();
    renderCurrentPrint();
    renderQueue();
    renderGrid();
    renderPublicModels();
    renderUsers();
    renderSupportSelect();
    applyHighlight();
  }

  function renderChips() {
    const list = taskOrders();
    const counts = { ready: 0, progress: 0, fail: 0 };
    list.forEach((o) => {
      if (counts[o.status] !== undefined) counts[o.status] += 1;
    });
    const chips = [
      { key: null, label: 'Alle', dot: null, n: list.length },
      { key: 'ready', label: STATUS.ready.label, dot: 'var(--ready)', n: counts.ready },
      { key: 'progress', label: STATUS.progress.label, dot: 'var(--progress)', n: counts.progress },
      { key: 'fail', label: STATUS.fail.label, dot: 'var(--fail)', n: counts.fail },
    ];
    let html = chips
      .map(
        (c) => `
      <button type="button" class="chip ${state.activeFilter === c.key ? 'active' : ''}" data-filter="${c.key ?? ''}">
        ${c.dot ? `<span class="dot" style="background:${c.dot}"></span>` : ''}
        ${c.label} <span class="n">${c.n}</span>
      </button>`,
      )
      .join('');
    const ideas = pendingIdeas().length;
    if (ideas > 0) html += `<button type="button" class="chip" id="ideaChip">💡 Ideen <span class="n">${ideas}</span></button>`;
    if (isAdmin() && state.support.length > 0) {
      html += `<button type="button" class="chip" id="supportChip">🎧 Support <span class="n">${state.support.length}</span></button>`;
    }
    $('#statChips').innerHTML = html;
    $('#statChips').querySelectorAll('.chip[data-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activeFilter = btn.dataset.filter || null;
        render();
      });
    });
    const ideaChip = $('#ideaChip');
    if (ideaChip) ideaChip.addEventListener('click', () => $('#ideaSection').scrollIntoView({ behavior: 'smooth', block: 'start' }));
    const supportChip = $('#supportChip');
    if (supportChip) supportChip.addEventListener('click', () => $('#supportSection').scrollIntoView({ behavior: 'smooth', block: 'start' }));

    const badge = $('#supportBadge');
    if (isAdmin() && state.support.length > 0) {
      badge.style.display = 'flex';
      badge.textContent = state.support.length;
    } else {
      badge.style.display = 'none';
    }
  }

  function renderIdeaInbox() {
    const pending = pendingIdeas();
    const section = $('#ideaSection');
    if (pending.length === 0) {
      section.style.display = 'none';
      $('#ideaList').innerHTML = '';
      return;
    }
    section.style.display = 'block';
    section.querySelector('.sub').textContent = isAdmin()
      ? 'Dinge, die es auf MakerWorld nicht gibt – zur Prüfung durch dich als Admin.'
      : 'Deine eingereichten Ideen – der Admin prüft sie und plant sie als Auftrag ein.';
    $('#ideaList').innerHTML = pending
      .map((m) => {
        const src = safeUrl(m.imageUrl);
        const thumb = src
          ? `<img class="idea-thumb" src="${escapeHtml(src)}" alt="" referrerpolicy="no-referrer">`
          : '<div class="idea-thumb-fallback">💡</div>';
        const actions = isAdmin()
          ? `<div class="idea-actions">
               <button class="btn btn-primary btn-sm" data-accept="${escapeHtml(m.id)}">Annehmen</button>
               <button class="btn btn-danger-outline btn-sm" data-reject="${escapeHtml(m.id)}">Ablehnen</button>
             </div>`
          : '<span class="idea-waiting">wartet auf Admin</span>';
        return `
        <div class="idea-card" data-dp="${escapeHtml(m.dpRef || '')}">
          ${thumb}
          <div class="idea-body">
            ${m.dpRef ? `<div class="dp-inline">${escapeHtml(m.dpRef)}</div>` : ''}
            <div class="idea-title">${escapeHtml(m.name)}</div>
            ${isAdmin() && m.ownerEmail ? `<div class="owner-line">von ${escapeHtml(m.ownerEmail)}</div>` : ''}
            ${m.note ? `<div class="idea-note">${escapeHtml(m.note)}</div>` : ''}
            <div class="idea-meta">${tagsHtml(m, { idea: true, isPublic: m.isPublic })}</div>
          </div>
          ${actions}
        </div>`;
      })
      .join('');
    if (isAdmin()) {
      $('#ideaList').querySelectorAll('[data-accept]').forEach((btn) =>
        btn.addEventListener('click', () => run(async () => {
          await api('POST', `/api/orders/${encodeURIComponent(btn.dataset.accept)}/accept`);
          await refreshLive();
        }, 'Idee angenommen – jetzt in Bearbeitung')),
      );
      $('#ideaList').querySelectorAll('[data-reject]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const idea = orders().find((o) => o.id === btn.dataset.reject);
          if (!idea || !confirm(`Idee "${idea.name}" ablehnen und entfernen?`)) return;
          run(async () => {
            await api('POST', `/api/orders/${encodeURIComponent(idea.id)}/reject`);
            await refreshLive();
          }, 'Idee abgelehnt');
        }),
      );
    }
  }

  function renderSupportInbox() {
    const section = $('#supportSection');
    if (!isAdmin() || state.support.length === 0) {
      section.style.display = 'none';
      $('#supportList').innerHTML = '';
      return;
    }
    section.style.display = 'block';
    $('#supportList').innerHTML = state.support
      .map(
        (s) => `
      <div class="support-card">
        <div class="support-thumb-fallback">💬</div>
        <div class="support-body">
          <div class="support-title">${s.orderName ? escapeHtml(s.orderName) : 'Allgemeine Nachricht'}${s.dpRef ? ` <span class="dp-inline">${escapeHtml(s.dpRef)}</span>` : ''}</div>
          <div class="support-note">${escapeHtml(s.message)}</div>
          <div class="support-time">${escapeHtml(s.userEmail || 'gelöschter Benutzer')} · ${formatTime(s.createdAt)}</div>
        </div>
        <div class="support-actions">
          ${s.orderExists ? `<button class="btn btn-danger-outline btn-sm" data-delmodel="${escapeHtml(s.id)}">🗑 Modell löschen</button>` : ''}
          <button class="btn btn-ghost btn-sm" data-resolve="${escapeHtml(s.id)}">✓ Erledigt</button>
        </div>
      </div>`,
      )
      .join('');
    $('#supportList').querySelectorAll('[data-delmodel]').forEach((btn) => btn.addEventListener('click', () => resolveSupport(btn.dataset.delmodel, true)));
    $('#supportList').querySelectorAll('[data-resolve]').forEach((btn) => btn.addEventListener('click', () => resolveSupport(btn.dataset.resolve, false)));
  }

  function resolveSupport(id, deleteOrder) {
    const msg = state.support.find((s) => s.id === id);
    if (!msg) return;
    if (deleteOrder && !confirm(`Modell "${msg.orderName}" wirklich löschen?`)) return;
    run(async () => {
      await api('POST', `/api/support/${encodeURIComponent(id)}/resolve`, { deleteOrder });
      await loadSupport();
      await refreshLive({ render: false });
      render();
    }, deleteOrder ? 'Modell gelöscht' : 'Als erledigt markiert');
  }

  function renderCurrentPrint() {
    const el = $('#currentPrint');
    if (!state.live) return;
    // Admin tippt gerade Fortschritt ein → nicht überschreiben
    if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    const cp = state.live.currentPrint;

    if (!cp || cp.kind === 'idle') {
      el.innerHTML = `
        <div class="print-anon">
          <div class="anon-icon">💤</div>
          <div class="print-body"><div class="print-title">Gerade läuft kein Druck</div><div class="muted">Sobald ein Druck startet, siehst du ihn hier.</div></div>
        </div>`;
      return;
    }

    const approx = (c) => `
      ${progressBar(c.progressBucket)}
      <div class="print-meta"><span>ca. <strong>${c.progressBucket} %</strong></span>${
        c.remainingApproxMinutes != null ? `<span>Restzeit ca. <strong>${formatDuration(c.remainingApproxMinutes)}</strong></span>` : ''
      }</div>`;

    if (cp.kind === 'foreign_private') {
      el.innerHTML = `
        <div class="print-anon">
          <div class="anon-icon">🖨️</div>
          <div class="print-body">
            <div class="print-title">Aktuell wird ein anderer Druck bearbeitet.</div>
            ${approx(cp)}
          </div>
        </div>`;
      return;
    }

    if (cp.kind === 'foreign_public') {
      const m = cp.model;
      el.innerHTML = `
        <div class="print-card">
          <div class="print-thumb">${mediaHtml(m.imageUrl, m.color)}</div>
          <div class="print-body">
            <div class="print-label">Öffentliches Modell im Druck</div>
            <div class="print-title">${escapeHtml(m.name)}</div>
            <div class="tag-row">${tagsHtml(m, { isPublic: true })}</div>
            ${approx(cp)}
            <div style="margin-top:8px">${linkHtml(m.link)}</div>
          </div>
        </div>`;
      return;
    }

    // eigener Druck oder Admin-Ansicht
    const o = cp.order;
    const elapsed = cp.startedAt ? (serverNow() - cp.startedAt) / 60000 : null;
    const adminForm =
      cp.kind === 'admin'
        ? `<form class="admin-print-form" id="progressForm">
             <div class="field"><label for="p-progress">Fortschritt %</label><input type="number" id="p-progress" min="0" max="100" step="1" value="${cp.progress}"></div>
             <div class="field"><label for="p-remaining">Rest (Min.)</label><input type="number" id="p-remaining" min="0" step="1" value="${cp.remainingMinutes ?? ''}"></div>
             <div class="btns">
               <button type="submit" class="btn btn-ghost btn-sm">Speichern</button>
               <button type="button" class="btn btn-primary btn-sm" id="finishPrint">✓ Fertig</button>
               <button type="button" class="btn btn-danger-outline btn-sm" id="clearPrint">✕ Entfernen</button>
             </div>
           </form>`
        : '';
    el.innerHTML = `
      <div class="print-card">
        <div class="print-thumb">${mediaHtml(o.imageUrl, o.color)}</div>
        <div class="print-body">
          <div class="print-label ${cp.kind === 'own' ? 'own' : ''}">${cp.kind === 'own' ? 'Dein Druck läuft' : 'Druck läuft'}</div>
          ${o.dpRef ? `<div class="dp-inline">${escapeHtml(o.dpRef)}</div>` : ''}
          <div class="print-title">${escapeHtml(o.name)}</div>
          ${cp.kind === 'admin' ? `<div class="owner-line">${escapeHtml(o.ownerEmail || 'ohne Besitzer')}</div>` : ''}
          <div class="tag-row">${tagsHtml(o, { idea: o.type === 'idea', isPublic: o.isPublic })}<span class="tag">Status: ${escapeHtml((STATUS[o.status] || STATUS.progress).label)}</span></div>
          ${progressBar(cp.progress)}
          <div class="print-meta">
            <span><strong>${Math.round(cp.progress)} %</strong></span>
            ${elapsed != null ? `<span>Laufzeit ${formatDuration(elapsed)}</span>` : ''}
            ${cp.remainingMinutes != null ? `<span>Rest ${formatDuration(cp.remainingMinutes)}</span>` : ''}
            ${cp.etaAt ? `<span>fertig ca. ${formatClock(cp.etaAt)}</span>` : ''}
          </div>
          ${adminForm}
        </div>
      </div>`;

    if (cp.kind === 'admin') {
      $('#progressForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const remaining = $('#p-remaining').value;
        run(async () => {
          await api('POST', '/api/admin/printer/progress', { progress: Number($('#p-progress').value), remainingMinutes: remaining === '' ? null : Number(remaining) });
          document.activeElement.blur();
          await refreshLive();
        }, 'Fortschritt gespeichert');
      });
      $('#finishPrint').addEventListener('click', () =>
        run(async () => {
          await api('POST', '/api/admin/printer/finish');
          await refreshLive();
        }, 'Druck als fertig markiert'),
      );
      $('#clearPrint').addEventListener('click', () => {
        if (!confirm('Aktuellen Druck entfernen (ohne Statusänderung)?')) return;
        run(async () => {
          await api('POST', '/api/admin/printer/clear');
          await refreshLive();
        });
      });
    }
  }

  /** Fasst lange Folgen privater Slots zusammen (übersichtlicher auf dem Handy). */
  function groupPrivateRuns(entries) {
    const out = [];
    let run = [];
    const flush = () => {
      if (run.length >= 3) out.push({ kind: 'private_group', from: run[0].position, to: run[run.length - 1].position, count: run.length });
      else out.push(...run);
      run = [];
    };
    for (const entry of entries) {
      if (entry.kind === 'private_queue_slot') run.push(entry);
      else {
        flush();
        out.push(entry);
      }
    }
    flush();
    return out;
  }

  function queueItemHtml(e) {
    if (e.kind === 'private_queue_slot') {
      return `<li class="q-item private"><span class="q-pos">${e.position}</span><div class="q-body"><div class="q-title">🔒 Privater Druck</div></div></li>`;
    }
    if (e.kind === 'private_group') {
      return `<li class="q-item private"><span class="q-pos">${e.from}–${e.to}</span><div class="q-body"><div class="q-title">🔒 ${e.count} private Drucke</div></div></li>`;
    }
    if (e.kind === 'public_model') {
      const m = e.model;
      return `
        <li class="q-item">
          <span class="q-pos">${e.position}</span>
          <div class="q-thumb">${mediaHtml(m.imageUrl, m.color)}</div>
          <div class="q-body">
            <div class="q-title">${escapeHtml(m.name)}</div>
            <div class="q-sub"><span>🌍 Öffentlich</span><span>${escapeHtml(m.filament || '')} · ${escapeHtml(m.color || '')}</span>${safeUrl(m.link) ? linkHtml(m.link) : ''}</div>
          </div>
        </li>`;
    }
    const o = e.order;
    if (e.kind === 'own') {
      return `
        <li class="q-item own" data-dp="${escapeHtml(o.dpRef || '')}">
          <span class="q-pos">${e.position}</span>
          <div class="q-thumb">${mediaHtml(o.imageUrl, o.color)}</div>
          <div class="q-body">
            <div class="q-title">${escapeHtml(o.name)}</div>
            <div class="q-sub"><strong>Dein Druck · Platz ${e.position}</strong>${o.dpRef ? `<span class="dp-inline">${escapeHtml(o.dpRef)}</span>` : ''}<span>${escapeHtml(o.filament)} · ${escapeHtml(o.color)}</span>${o.type === 'idea' ? '<span>💡 Idee</span>' : ''}<span>Status: ${escapeHtml((STATUS[o.status] || STATUS.progress).label)}</span></div>
          </div>
        </li>`;
    }
    // Admin
    return `
      <li class="q-item">
        <span class="q-pos">${e.position}</span>
        <div class="q-thumb">${mediaHtml(o.imageUrl, o.color)}</div>
        <div class="q-body">
          <div class="q-title">${escapeHtml(o.name)}</div>
          <div class="q-sub">${o.dpRef ? `<span class="dp-inline">${escapeHtml(o.dpRef)}</span>` : ''}<span>${escapeHtml(o.ownerEmail || 'ohne Besitzer')}</span><span>${escapeHtml(o.filament)} · ${escapeHtml(o.color)}</span>${o.isPublic ? '<span>🌍</span>' : ''}</div>
        </div>
        <div class="q-actions">
          <button class="icon-btn" data-qup="${escapeHtml(o.id)}" title="Nach oben" aria-label="Nach oben">↑</button>
          <button class="icon-btn" data-qdown="${escapeHtml(o.id)}" title="Nach unten" aria-label="Nach unten">↓</button>
          <button class="icon-btn" data-qcurrent="${escapeHtml(o.id)}" title="Als aktuellen Druck markieren (steuert keinen Drucker)" aria-label="Als aktuellen Druck markieren">▶</button>
          <button class="icon-btn del" data-qremove="${escapeHtml(o.id)}" title="Aus Warteschlange entfernen" aria-label="Aus Warteschlange entfernen">✕</button>
        </div>
      </li>`;
  }

  function renderQueue() {
    const q = state.live.queue;
    const el = $('#queueView');
    $('#queueTotal').textContent = q.total ? plural(q.total, 'Druck', 'Drucke') : '';
    let summary;
    if (!isAdmin() && q.mine) {
      const ahead = q.mine.aheadCount;
      summary = `<div class="queue-summary"><strong>Dein Platz: ${q.mine.position}</strong><span>${
        ahead === 0 ? 'Du bist als Nächstes dran' : `Noch ${plural(ahead, 'Druck', 'Drucke')} vor dir`
      }</span></div>`;
    } else if (q.total) {
      summary = `<div class="queue-summary neutral">Aktuell ${q.total === 1 ? 'befindet sich 1 Druck' : `befinden sich ${q.total} Drucke`} in der Warteschlange.</div>`;
    } else {
      summary = '<div class="queue-summary neutral">Die Warteschlange ist leer.</div>';
    }
    const items = groupPrivateRuns(q.entries).map(queueItemHtml).join('');
    el.innerHTML = summary + (items ? `<ol class="queue-list">${items}</ol>` : '');

    if (isAdmin()) {
      const bind = (attr, fn) => el.querySelectorAll(`[${attr}]`).forEach((btn) => btn.addEventListener('click', () => fn(btn.getAttribute(attr))));
      bind('data-qup', (id) => queueAction(() => api('POST', `/api/admin/queue/${encodeURIComponent(id)}/move`, { direction: 'up' })));
      bind('data-qdown', (id) => queueAction(() => api('POST', `/api/admin/queue/${encodeURIComponent(id)}/move`, { direction: 'down' })));
      bind('data-qcurrent', (id) => queueAction(() => api('POST', '/api/admin/printer/current', { orderId: id }), 'Als aktueller Druck markiert'));
      bind('data-qremove', (id) => queueAction(() => api('DELETE', `/api/admin/queue/${encodeURIComponent(id)}`), 'Aus Warteschlange entfernt'));
    }
  }

  function queueAction(fn, message) {
    return run(async () => {
      await fn();
      await refreshLive();
    }, message);
  }

  function renderGrid() {
    const tasks = taskOrders();
    const list = state.activeFilter ? tasks.filter((m) => m.status === state.activeFilter) : tasks;
    const { positions, currentId } = printInfo();

    emptyState.style.display = tasks.length === 0 ? 'block' : 'none';
    grid.style.display = tasks.length === 0 ? 'none' : 'grid';
    gridHeading.style.display = tasks.length === 0 ? 'none' : 'block';
    gridHeading.textContent = isAdmin() ? '📋 Alle Druckaufträge' : '📋 Meine Druckaufträge';
    $('#emptyState h2').textContent = isAdmin() ? 'Noch keine Modelle auf der Platte' : 'Noch keine eigenen Aufträge';

    grid.innerHTML = list
      .map((m) => {
        const st = STATUS[m.status] || STATUS.progress;
        let printState = '';
        if (m.id === currentId) printState = '<div class="card-state">🖨️ Wird gerade gedruckt</div>';
        else if (positions.has(m.id)) printState = `<div class="card-state">📋 Warteschlange · Platz ${positions.get(m.id)}</div>`;
        let actions = '';
        if (isAdmin()) {
          const canQueue = m.id !== currentId && !positions.has(m.id);
          actions = `<div class="icon-actions">
             ${canQueue ? `<button class="icon-btn" data-enqueue="${escapeHtml(m.id)}" title="In Warteschlange einreihen" aria-label="In Warteschlange einreihen">➕</button>` : ''}
             ${m.id !== currentId ? `<button class="icon-btn" data-current="${escapeHtml(m.id)}" title="Als aktuellen Druck markieren (steuert keinen Drucker)" aria-label="Als aktuellen Druck markieren">▶</button>` : ''}
             <button class="icon-btn edit" data-edit="${escapeHtml(m.id)}" title="Bearbeiten" aria-label="Bearbeiten">✎</button>
             <button class="icon-btn del" data-delete="${escapeHtml(m.id)}" title="Löschen" aria-label="Löschen">🗑</button>
           </div>`;
        } else {
          actions = `<button type="button" class="vis-btn ${m.isPublic ? 'on' : ''}" data-visibility="${escapeHtml(m.id)}" title="Sichtbarkeit für andere ändern">${m.isPublic ? '🌍 Öffentlich' : '🔒 Privat'}</button>`;
        }
        return `
      <div class="card" data-dp="${escapeHtml(m.dpRef || '')}">
        <div class="clip left"></div>
        <div class="clip right"></div>
        <div class="card-media">
          ${mediaHtml(m.imageUrl, m.color)}
          <div class="status-tag ${st.cls}"><span class="led"></span>${st.label}</div>
        </div>
        <div class="card-body">
          ${dpBlock(m.dpRef)}
          <div class="card-title">${escapeHtml(m.name)}</div>
          ${isAdmin() ? `<div class="owner-line">${escapeHtml(m.ownerEmail || 'ohne Besitzer')}</div>` : ''}
          <div class="tag-row">${tagsHtml(m, { idea: m.type === 'idea', isPublic: m.isPublic })}</div>
          ${m.note ? `<div class="card-note">${escapeHtml(m.note)}</div>` : ''}
          ${printState}
          <div class="card-footer">
            ${linkHtml(m.link)}
            ${actions}
          </div>
        </div>
      </div>`;
      })
      .join('');

    const bind = (attr, fn) => grid.querySelectorAll(`[${attr}]`).forEach((btn) => btn.addEventListener('click', () => fn(btn.getAttribute(attr))));
    if (isAdmin()) {
      bind('data-edit', (id) => openModal(id));
      bind('data-delete', (id) => deleteOrder(id));
      bind('data-enqueue', (id) => queueAction(() => api('POST', '/api/admin/queue', { orderId: id }), 'In Warteschlange eingereiht'));
      bind('data-current', (id) => queueAction(() => api('POST', '/api/admin/printer/current', { orderId: id }), 'Als aktueller Druck markiert'));
    } else {
      bind('data-visibility', (id) => {
        const order = orders().find((o) => o.id === id);
        if (!order) return;
        const next = !order.isPublic;
        run(async () => {
          await api('PATCH', `/api/orders/${encodeURIComponent(id)}`, { isPublic: next });
          await refreshLive();
        }, next ? 'Jetzt öffentlich sichtbar (ohne Auftragsnummer)' : 'Wieder privat');
      });
    }
  }

  function renderPublicModels() {
    const section = $('#publicSection');
    const list = state.live.publicModels || [];
    if (isAdmin() || list.length === 0) {
      section.hidden = true;
      $('#publicGrid').innerHTML = '';
      return;
    }
    section.hidden = false;
    $('#publicGrid').innerHTML = list
      .map(
        (m) => `
      <div class="card">
        <div class="clip left"></div>
        <div class="clip right"></div>
        <div class="card-media">${mediaHtml(m.imageUrl, m.color)}</div>
        <div class="card-body">
          <div class="card-title">${escapeHtml(m.name)}</div>
          <div class="tag-row">${tagsHtml(m, { isPublic: true })}</div>
          <div class="card-footer">${linkHtml(m.link)}</div>
        </div>
      </div>`,
      )
      .join('');
  }

  function renderUsers() {
    const section = $('#usersSection');
    if (!isAdmin() || state.users.length === 0) {
      section.hidden = true;
      $('#userList').innerHTML = '';
      return;
    }
    section.hidden = false;
    const selfEmail = state.me.user.email;
    $('#userList').innerHTML = state.users
      .map((u) => {
        const self = u.email === selfEmail;
        const blocked = u.status !== 'active';
        return `
        <div class="user-row">
          <div class="user-main">
            <div class="user-email">${escapeHtml(u.email)} ${blocked ? '<span class="tag blocked">gesperrt</span>' : ''} ${self ? '<span class="tag current">du</span>' : ''}</div>
            <div class="user-meta">${plural(u.activeDevices, 'aktives Gerät', 'aktive Geräte')} · ${plural(u.orders, 'Auftrag', 'Aufträge')} · seit ${formatDate(u.createdAt)}</div>
          </div>
          <div class="user-actions">
            ${self ? '' : blocked
              ? `<button class="btn btn-ghost btn-sm" data-unblock="${escapeHtml(u.id)}">Entsperren</button>`
              : `<button class="btn btn-danger-outline btn-sm" data-block="${escapeHtml(u.id)}">Sperren</button>`}
            <button class="btn btn-ghost btn-sm" data-reset="${escapeHtml(u.id)}">Geräte zurücksetzen</button>
            ${self ? '' : `<button class="btn btn-danger-outline btn-sm" data-deluser="${escapeHtml(u.id)}">Löschen</button>`}
          </div>
        </div>`;
      })
      .join('');
    const list = $('#userList');
    const find = (id) => state.users.find((u) => u.id === id);
    const bind = (attr, fn) => list.querySelectorAll(`[${attr}]`).forEach((btn) => btn.addEventListener('click', () => fn(btn.getAttribute(attr))));
    const userAction = (fn, message) =>
      run(async () => {
        await fn();
        if (!state.me) return;
        await loadUsers();
        renderUsers();
      }, message);
    bind('data-block', (id) => {
      if (confirm(`${find(id).email} sperren? Alle Geräte werden sofort abgemeldet.`)) userAction(() => api('POST', `/api/admin/users/${encodeURIComponent(id)}/block`), 'Benutzer gesperrt');
    });
    bind('data-unblock', (id) => userAction(() => api('POST', `/api/admin/users/${encodeURIComponent(id)}/unblock`), 'Benutzer entsperrt'));
    bind('data-reset', (id) => {
      if (confirm(`Alle vertrauenswürdigen Geräte von ${find(id).email} abmelden?`)) userAction(() => api('POST', `/api/admin/users/${encodeURIComponent(id)}/reset-devices`), 'Geräte zurückgesetzt');
    });
    bind('data-deluser', (id) => {
      if (confirm(`Konto ${find(id).email} löschen? Geräte werden sofort ungültig, Aufträge bleiben ohne Besitzer erhalten.`)) {
        userAction(() => api('DELETE', `/api/admin/users/${encodeURIComponent(id)}`), 'Konto gelöscht');
      }
    });
  }

  function renderSupportSelect() {
    const sel = $('#s-model');
    const prev = sel.value;
    const list = taskOrders();
    sel.innerHTML =
      '<option value="">Kein bestimmtes Modell</option>' +
      list.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.dpRef ? `${m.dpRef} · ${m.name}` : m.name)}</option>`).join('');
    if (list.some((m) => m.id === prev)) sel.value = prev;
  }

  // ------------------------------------------------------------------ Formular Auftrag / Idee

  function populateSelect(sel, items) {
    sel.innerHTML = items.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  }
  populateSelect($('#f-color'), COLORS.map((c) => c.name));
  populateSelect($('#f-filament'), FILAMENTS);

  function resetForm() {
    $('#f-name').value = '';
    $('#f-link').value = '';
    $('#f-color').value = COLORS[0].name;
    $('#f-filament').value = FILAMENTS[0];
    $('#f-status').value = 'progress';
    $('#f-note').value = '';
    $('#f-image-url').value = '';
    $('#f-public').checked = false;
    state.pendingImage = '';
    state.imageDirty = false;
    updatePreview();
  }

  function updatePreview() {
    const prev = $('#imgPreview');
    const src = safeUrl(state.pendingImage);
    if (src) prev.innerHTML = `<img src="${escapeHtml(src)}" alt="Vorschau" referrerpolicy="no-referrer">`;
    else prev.textContent = 'Bild hierher ziehen, mit Strg+V einfügen oder Datei wählen';
  }

  function setPendingImage(value) {
    state.pendingImage = value;
    state.imageDirty = true;
    updatePreview();
  }

  function applyTypeUI() {
    $('#typeSwitch').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.type === state.currentType));
    if (state.currentType === 'model') {
      $('#f-name-label').textContent = 'Modell';
      $('#f-name').placeholder = 'z. B. Handyhalterung';
      $('#f-link-label').textContent = 'Link zum Modell (MakerWorld)';
      $('#f-link').placeholder = 'https://makerworld.com/...';
      $('#linkHint').hidden = false;
      $('#f-note-label').textContent = 'Notiz (optional)';
      $('#modalHint').textContent = isAdmin()
        ? 'Nur Modelle von MakerWorld – Link erforderlich.'
        : 'Nur Modelle von MakerWorld sind zugelassen. Der Status wird vom Admin gesetzt. Du bekommst sofort eine Auftragsnummer.';
    } else {
      $('#f-name-label').textContent = 'Idee';
      $('#f-name').placeholder = 'z. B. Kabelhalter für Schreibtisch';
      $('#f-link-label').textContent = 'Referenz-Link (optional)';
      $('#f-link').placeholder = 'https://... (optional, falls vorhanden)';
      $('#linkHint').hidden = true;
      $('#f-note-label').textContent = 'Beschreibung';
      $('#modalHint').textContent =
        'Für Dinge, die es auf MakerWorld nicht gibt. Auch Ideen bekommen sofort eine normale DP-Auftragsnummer; der Admin prüft die Idee und plant sie ein.';
    }
  }
  $('#typeSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    state.currentType = btn.dataset.type;
    applyTypeUI();
  });

  function openModal(id) {
    state.editingId = id || null;
    resetForm();
    $('#typeSwitch').style.display = id ? 'none' : 'flex';
    if (id) {
      const m = orders().find((x) => x.id === id);
      if (!m || !isAdmin()) return;
      state.currentType = m.type || 'model';
      $('#modalTitle').textContent = m.dpRef ? `Bearbeiten · ${m.dpRef}` : 'Bearbeiten';
      $('#f-name').value = m.name || '';
      $('#f-link').value = m.link || '';
      $('#f-color').value = m.color || COLORS[0].name;
      $('#f-filament').value = m.filament || FILAMENTS[0];
      $('#f-status').value = m.status || 'progress';
      $('#f-note').value = m.note || '';
      $('#f-public').checked = Boolean(m.isPublic);
      state.pendingImage = m.imageUrl || '';
      state.imageDirty = false;
      if (m.imageUrl && /^https?:/.test(m.imageUrl)) $('#f-image-url').value = m.imageUrl;
      updatePreview();
    } else {
      state.currentType = 'model';
      $('#modalTitle').textContent = isAdmin() ? 'Hinzufügen' : 'Einreichen';
    }
    applyTypeUI();
    overlay.classList.add('open');
    setTimeout(() => $('#f-name').focus(), 80);
  }
  function closeModalFn() {
    overlay.classList.remove('open');
    state.editingId = null;
  }

  function deleteOrder(id) {
    const m = orders().find((x) => x.id === id);
    if (!m || !confirm(`"${m.name}" wirklich löschen?`)) return;
    run(async () => {
      await api('DELETE', `/api/orders/${encodeURIComponent(id)}`);
      await refreshLive();
    }, 'Gelöscht');
  }

  function resizeImageFromFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith('image/')) {
        reject(new Error('Kein Bild'));
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const maxW = 700;
          const scale = Math.min(1, maxW / img.width);
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.75));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  $('#addBtn').addEventListener('click', () => openModal(null));
  $('#emptyAddBtn').addEventListener('click', () => openModal(null));
  $('#closeModal').addEventListener('click', closeModalFn);
  $('#cancelBtn').addEventListener('click', closeModalFn);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModalFn();
  });

  $('#fileBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      setPendingImage(await resizeImageFromFile(file));
      $('#f-image-url').value = '';
    } catch {
      toast('Bild konnte nicht geladen werden');
    }
    e.target.value = '';
  });
  $('#f-image-url').addEventListener('input', (e) => setPendingImage(e.target.value.trim()));

  const imgPreviewEl = $('#imgPreview');
  ['dragenter', 'dragover'].forEach((evt) =>
    imgPreviewEl.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      imgPreviewEl.classList.add('drag-active');
    }),
  );
  ['dragleave', 'dragend'].forEach((evt) =>
    imgPreviewEl.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      imgPreviewEl.classList.remove('drag-active');
    }),
  );
  imgPreviewEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    imgPreviewEl.classList.remove('drag-active');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) {
      try {
        setPendingImage(await resizeImageFromFile(file));
        $('#f-image-url').value = '';
        return;
      } catch {
        /* weiter mit URL-Versuch */
      }
    }
    const uri = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (uri && /^https?:\/\//i.test(uri.trim())) {
      setPendingImage(uri.trim());
      $('#f-image-url').value = uri.trim();
    } else {
      toast('Kein gültiges Bild erkannt');
    }
  });

  document.addEventListener('paste', async (e) => {
    if (!overlay.classList.contains('open')) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        e.preventDefault();
        try {
          setPendingImage(await resizeImageFromFile(item.getAsFile()));
          $('#f-image-url').value = '';
          toast('Bild eingefügt');
        } catch {
          toast('Bild konnte nicht eingefügt werden');
        }
        return;
      }
    }
  });

  $('#modelForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#f-name').value.trim();
    if (!name) {
      toast('Bitte einen Namen eingeben');
      return;
    }
    const link = $('#f-link').value.trim();
    if (state.currentType === 'model' && !isMakerWorldLink(link)) {
      toast('Bitte einen gültigen MakerWorld-Link angeben');
      return;
    }
    const data = {
      name,
      link,
      color: $('#f-color').value,
      filament: $('#f-filament').value,
      note: $('#f-note').value.trim(),
      isPublic: $('#f-public').checked,
    };
    if (isAdmin()) data.status = $('#f-status').value;

    const saveBtn = $('#saveBtn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Speichert …';
    const editingId = state.editingId;
    const submittedIdea = state.currentType === 'idea';
    try {
      let order;
      if (editingId && isAdmin()) {
        if (state.imageDirty) data.image = state.pendingImage;
        order = (await api('PATCH', `/api/orders/${encodeURIComponent(editingId)}`, data)).order;
      } else {
        order = (await api('POST', '/api/orders', { ...data, type: state.currentType, image: state.pendingImage })).order;
      }
      closeModalFn();
      await refreshLive();
      if (!editingId && order && order.dpRef && !isAdmin()) {
        toast(submittedIdea ? `Idee an Admin gesendet · ${order.dpRef}` : `Auftrag eingereicht · ${order.dpRef}`);
      } else {
        toast('Gespeichert');
      }
    } catch (err) {
      if (err.status !== 401) toast(err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Speichern';
    }
  });

  // ------------------------------------------------------------------ Support

  function openSupportModal() {
    $('#s-message').value = '';
    $('#s-model').value = '';
    supportOverlay.classList.add('open');
    setTimeout(() => $('#s-message').focus(), 80);
  }
  function closeSupportModal() {
    supportOverlay.classList.remove('open');
  }
  $('#supportBtn').addEventListener('click', openSupportModal);
  $('#closeSupportModal').addEventListener('click', closeSupportModal);
  $('#supportCancelBtn').addEventListener('click', closeSupportModal);
  supportOverlay.addEventListener('click', (e) => {
    if (e.target === supportOverlay) closeSupportModal();
  });

  $('#supportForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = $('#s-message').value.trim();
    if (!message) {
      toast('Bitte eine Nachricht eingeben');
      return;
    }
    const btn = $('#supportSendBtn');
    btn.disabled = true;
    btn.textContent = 'Sendet …';
    const ok = await run(async () => {
      await api('POST', '/api/support', { message, orderId: $('#s-model').value || null });
      if (isAdmin()) {
        await loadSupport();
        renderSupportInbox();
        renderChips();
      }
      return true;
    }, 'Nachricht an Admin gesendet');
    btn.disabled = false;
    btn.textContent = 'Senden';
    if (ok) closeSupportModal();
  });

  // ------------------------------------------------------------------ Profil & Geräte

  async function openProfile() {
    if (!state.me) return;
    $('#profileEmail').textContent = state.me.user.email;
    profileOverlay.classList.add('open');
    await loadDevices();
  }
  function closeProfile() {
    profileOverlay.classList.remove('open');
  }

  async function loadDevices() {
    const data = await run(() => api('GET', '/api/devices'));
    if (!data) return;
    state.devices = data.devices || [];
    $('#deviceList').innerHTML = state.devices
      .map(
        (d) => `
      <div class="device-item">
        <div class="device-main">
          <div class="device-name">${escapeHtml(d.label)} ${d.current ? '<span class="tag current">dieses Gerät</span>' : ''}</div>
          <div class="device-meta">Registriert: ${formatDateTime(d.createdAt)}<br>Zuletzt verwendet: ${formatDateTime(d.lastUsedAt)}<br>Gültig bis: ${formatDateTime(d.expiresAt)}</div>
        </div>
        <button type="button" class="btn btn-danger-outline btn-sm" data-revoke="${escapeHtml(d.id)}">Gerät abmelden</button>
      </div>`,
      )
      .join('');
    $('#deviceList').querySelectorAll('[data-revoke]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const device = state.devices.find((d) => d.id === btn.dataset.revoke);
        if (!device) return;
        if (device.current && !confirm('Dieses Gerät abmelden? Beim nächsten Besuch ist wieder ein E-Mail-Code nötig.')) return;
        const res = await run(() => api('POST', `/api/devices/${encodeURIComponent(device.id)}/revoke`), 'Gerät abgemeldet');
        if (!res) return;
        if (res.loggedOut) onLoggedOut(false);
        else loadDevices();
      }),
    );
  }

  $('#profileBtn').addEventListener('click', openProfile);
  $('#closeProfile').addEventListener('click', closeProfile);
  profileOverlay.addEventListener('click', (e) => {
    if (e.target === profileOverlay) closeProfile();
  });
  $('#revokeOthersBtn').addEventListener('click', async () => {
    if (!confirm('Alle anderen Geräte abmelden? Dieses Gerät bleibt angemeldet.')) return;
    const res = await run(() => api('POST', '/api/devices/revoke-others'));
    if (res) {
      toast(res.revoked ? `${plural(res.revoked, 'Gerät', 'Geräte')} abgemeldet` : 'Keine anderen Geräte angemeldet');
      loadDevices();
    }
  });
  $('#logoutBtn').addEventListener('click', async () => {
    if (!confirm('Abmelden und dieses Gerät vergessen? Beim nächsten Besuch ist wieder ein E-Mail-Code nötig.')) return;
    const res = await run(() => api('POST', '/api/auth/logout'));
    if (res) {
      onLoggedOut(false);
      toast('Abgemeldet');
    }
  });

  // ------------------------------------------------------------------ AGB / README / Filament-Guide

  const AGB_HTML = `
    <h3>1. Geltungsbereich</h3>
    <p>Diese Bedingungen gelten für die Nutzung von „Druckplatte“ als internes Tool zur Verwaltung von 3D-Druck-Aufträgen zwischen Auftraggeber:innen und Admin.</p>
    <h3>2. Zulässige Modelle</h3>
    <p>Es dürfen ausschließlich 3D-Modelle eingereicht werden, die auf MakerWorld (makerworld.com) verfügbar sind. Eigene Ideen, die dort nicht existieren, können separat als Idee eingereicht und vom Admin geprüft werden.</p>
    <h3>3. Nutzung & Pflichten</h3>
    <ul>
      <li>Eingereichte Angaben (Modell, Farbe, Filament, Bild) sollen wahrheitsgemäß und vollständig sein.</li>
      <li>Der Status eines Auftrags wird ausschließlich vom Admin gepflegt.</li>
      <li>Löschwünsche werden über die Support-Funktion an den Admin gerichtet, nicht eigenständig umgesetzt.</li>
    </ul>
    <h3>4. Haftung</h3>
    <p>Die Nutzung erfolgt ohne Gewähr auf ständige Verfügbarkeit. Für Druckergebnisse, Materialschäden oder Zeitverzug wird keine Haftung übernommen.</p>
    <h3>5. Datenspeicherung & Sichtbarkeit</h3>
    <p>Eingereichte Daten (Aufträge, Ideen, Bilder, Support-Nachrichten) sind nur für dich und den Admin sichtbar. Andere sehen von deinen Aufträgen in der Warteschlange und beim aktuellen Druck nur einen anonymen Platzhalter. Markierst du ein Modell ausdrücklich als öffentlich, sehen andere Bild, Name, Material, Farbe und Link – niemals deine Auftragsnummer oder persönliche Daten.</p>
    <h3>6. Anmeldung & Geräte</h3>
    <p>Die Anmeldung erfolgt mit einem E-Mail-Code. Danach wird das Gerät (Browser) für 30 Tage über ein sicheres Cookie als vertrauenswürdig gespeichert; serverseitig wird nur ein Hash, die grobe Gerätebezeichnung sowie Registrierungs-, Nutzungs- und Ablaufzeitpunkt gespeichert. Geräte können jederzeit im Profil abgemeldet werden.</p>
    <h3>7. Änderungen</h3>
    <p>Diese Bedingungen können jederzeit durch den Admin angepasst werden.</p>
    <div class="disclaimer">Hinweis: Dies ist eine allgemeine Vorlage ohne rechtliche Prüfung, keine Rechtsberatung. Bitte vor produktivem Einsatz individuell anpassen bzw. rechtlich prüfen lassen.</div>
  `;
  const README_HTML = `
    <h3>Was ist Druckplatte?</h3>
    <p>Ein kleines Tool, um 3D-Druck-Aufträge zu sammeln, zu verfolgen und zu verwalten – von der Einreichung bis zur Fertigstellung.</p>
    <h3>Rollen</h3>
    <ul>
      <li><strong>Auftraggeber:in</strong> – reicht Modelle (von MakerWorld) oder eigene Ideen ein, sieht eigene Aufträge, die eigene Position in der Warteschlange und den Status, kann den Status aber nicht selbst ändern.</li>
      <li><strong>Admin</strong> – setzt Status, verwaltet Warteschlange und aktuellen Druck, bearbeitet/löscht Aufträge, nimmt Ideen an oder lehnt sie ab, bearbeitet Support-Nachrichten und verwaltet Benutzer. Zugang über den „🔒 Admin“-Button mit Admin-Passwort (in jeder neuen Sitzung).</li>
    </ul>
    <h3>Auftragsnummern</h3>
    <p>Jeder Auftrag – auch eine Idee – bekommt bei der Einreichung eine Auftragsnummer im Format DP-JJJJ-NNNNNN. Sie ist nur für dich und den Admin sichtbar.</p>
    <h3>Aktueller Druck & Warteschlange</h3>
    <p>Du siehst, was gerade gedruckt wird und wo dein Auftrag in der Warteschlange steht („Dein Platz: 3 · Noch 2 Drucke vor dir“). Fremde private Aufträge erscheinen nur als anonymer Platzhalter; öffentliche Modelle mit Bild, Name, Material, Farbe und Link.</p>
    <h3>Anmeldung</h3>
    <p>Einmal mit E-Mail-Code anmelden – danach ist das Gerät 30 Tage vertrauenswürdig. Website und Links aus Druckplatte-E-Mails öffnen sich in dieser Zeit ohne neuen Code. Nach 30 Tagen ist einmal ein neuer Code nötig. Im Profil siehst und widerrufst du deine Geräte.</p>
    <h3>MakerWorld-Pflicht</h3>
    <p>Nur Modelle von MakerWorld sind zulässig – der Link wird beim Einreichen geprüft. Dinge, die es dort nicht gibt, können als „Eigene Idee“ eingereicht werden.</p>
    <h3>Support</h3>
    <p>Über den „💬 Support“-Button lässt sich eine Nachricht an den Admin schicken, z. B. um ein Modell wieder löschen zu lassen.</p>
    <h3>Bilder hinzufügen</h3>
    <p>Im Bild-Feld kannst du eine Bild-URL eintragen, eine Datei auswählen, ein Bild per Drag &amp; Drop in das Vorschaufeld ziehen oder ein kopiertes Bild mit Strg+V einfügen.</p>
  `;
  const FILAMENT_INFO = [
    { name: 'PLA', icon: '🌱', desc: 'Leicht zu drucken, kaum Verzug, aus Maisstärke – die Einsteiger-Empfehlung. Nicht hitzebeständig (erweicht ab ca. 55–60 °C) und eher spröde.', uses: 'Deko, Prototypen, Spielzeug, Figuren – alles ohne große mechanische oder thermische Belastung' },
    { name: 'PLA+', icon: '🌱+', desc: 'Verbesserte PLA-Rezeptur, zäher und schlagfester als Standard-PLA, dabei genauso einfach zu drucken.', uses: 'Funktionsteile mit etwas mehr Belastung, Halterungen, Werkzeuggriffe' },
    { name: 'PETG', icon: '💧', desc: 'Widerstandsfähig, schlagfest, feuchtigkeitsbeständig, chemisch recht beständig. Etwas anspruchsvoller im Druck (neigt zu Fäden) als PLA.', uses: 'Behälter, Outdoor-Teile, mechanisch beanspruchte Teile, Teile mit Feuchtigkeitskontakt' },
    { name: 'ABS', icon: '🔥', desc: 'Hitzebeständiger und schlagfester als PLA, aber anspruchsvoll im Druck (Verzug, braucht beheiztes Bett/geschlossenen Bauraum, riecht beim Drucken).', uses: 'Gehäuse, Autoteile, mechanisch und thermisch belastete Bauteile' },
    { name: 'ASA', icon: '☀️', desc: 'Ähnliche Eigenschaften wie ABS, zusätzlich UV- und witterungsbeständig. Ähnlich anspruchsvoll im Druck.', uses: 'Teile für den Außenbereich, Gartenmöbel-Halterungen, Dinge mit Sonnenkontakt' },
    { name: 'TPU', icon: '🧦', desc: 'Flexibles, gummiartiges Filament in verschiedenen Härtegraden. Druckt sich langsamer, empfindlich bei hohen Druckgeschwindigkeiten.', uses: 'Handyhüllen, Dichtungen, Scharniere, Anti-Rutsch-Füße, flexible Halterungen' },
    { name: 'Nylon (PA)', icon: '⚙️', desc: 'Sehr robust, abriebfest und zäh, aber anspruchsvoll: zieht Feuchtigkeit aus der Luft und muss vor dem Druck oft getrocknet werden.', uses: 'Zahnräder, Scharniere, stark beanspruchte Funktions- und Maschinenteile' },
    { name: 'Resin', icon: '🧪', desc: 'Flüssigharz für SLA/DLP-Drucker (kein FDM-Filament) – sehr hohe Detailgenauigkeit und glatte Oberfläche, aber spröder und im flüssigen Zustand reizend/giftig (Handschuhe & Belüftung nötig).', uses: 'Miniaturen, Schmuck, Zahnmodelle, Teile mit sehr feinen Details' },
    { name: 'Sonstige', icon: '✨', desc: 'Sammelkategorie für Spezialfilamente wie Holz-, Carbon-, Glow-in-the-dark- oder Metall-Composites. Eigenschaften hängen stark vom jeweiligen Zusatzstoff ab.', uses: 'Optische/haptische Spezialeffekte, individuell je nach Filament nachlesen' },
  ];
  function buildFilamentTable() {
    const rows = FILAMENT_INFO.map(
      (f) => `
      <tr>
        <td class="fname">${f.icon} ${escapeHtml(f.name)}</td>
        <td>${escapeHtml(f.desc)}</td>
        <td class="fuse">${escapeHtml(f.uses)}</td>
      </tr>`,
    ).join('');
    return `
      <p>Übersicht der Filamente aus dem Auswahlmenü – Eigenschaften und wofür sie sich eignen.</p>
      <div class="filament-table-wrap">
        <table class="filament-table">
          <thead><tr><th>Filament</th><th>Eigenschaften</th><th>Geeignet für</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="disclaimer">Allgemeine Richtwerte – Herstellerangaben zum jeweiligen Filament (z. B. Drucktemperatur) haben immer Vorrang.</div>
    `;
  }

  function openTextModal(type) {
    if (type === 'agb') {
      $('#textModalTitle').textContent = 'AGB';
      $('#textModalBody').innerHTML = AGB_HTML;
    } else if (type === 'filament') {
      $('#textModalTitle').textContent = 'Filament-Guide';
      $('#textModalBody').innerHTML = buildFilamentTable();
    } else {
      $('#textModalTitle').textContent = 'README';
      $('#textModalBody').innerHTML = README_HTML;
    }
    textOverlay.classList.add('open');
  }
  function closeTextModal() {
    textOverlay.classList.remove('open');
  }
  $('#agbLink').addEventListener('click', () => openTextModal('agb'));
  $('#readmeLink').addEventListener('click', () => openTextModal('readme'));
  $('#filamentLink').addEventListener('click', () => openTextModal('filament'));
  $('#closeTextModal').addEventListener('click', closeTextModal);
  $('#textCloseBtn2').addEventListener('click', closeTextModal);
  textOverlay.addEventListener('click', (e) => {
    if (e.target === textOverlay) closeTextModal();
  });

  function closeAllOverlays() {
    for (const el of [overlay, supportOverlay, textOverlay, profileOverlay, adminOverlay]) el.classList.remove('open');
    state.editingId = null;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (overlay.classList.contains('open')) closeModalFn();
    if (supportOverlay.classList.contains('open')) closeSupportModal();
    if (textOverlay.classList.contains('open')) closeTextModal();
    if (profileOverlay.classList.contains('open')) closeProfile();
    if (adminOverlay.classList.contains('open')) closeAdmin();
  });

  // ------------------------------------------------------------------ Start

  (async function init() {
    try {
      const me = await api('GET', '/api/me');
      await startApp(me);
    } catch (err) {
      if (err.status !== 401) {
        showGate(false);
        setGateError(err.message);
      }
    }
  })();
})();
