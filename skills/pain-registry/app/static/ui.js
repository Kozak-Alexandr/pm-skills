/* Реестр болей — интерфейс. Без фреймворка: состояние в S, рендер строками,
 * события через делегирование по data-act / data-change. */
(function () {
  'use strict';
  const PR = window.PR;
  const U = PR.util;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, a, b, c) => { const m = Math.abs(n) % 100, k = m % 10; return n + ' ' + (m > 10 && m < 20 ? c : k > 1 && k < 5 ? b : k === 1 ? a : c); };
  const KIND = { epic: 'Эпик', feature: 'Фича', bug: 'Баг', research: 'Исследование' };
  const STATUS = { new: 'Новый', taken: 'В работе', parked: 'Отложен', rejected: 'Отклонён' };
  const QS = { verified: ['ok', 'Цитата дословная'], approx: ['warn', 'Цитата приблизительная'], missing: ['bad', 'Цитата не найдена'] };
  const SRC = { llm: 'модель', heuristic: 'эвристика', baseline: 'бейзлайн', manual: 'вручную' };

  const S = {
    ws: PR.newWorkspace(), view: 'backlog', selB: null, filter: 'all', query: '', themeCat: '',
    mode: 'standalone', engine: { kind: 'none', label: 'Без модели', llm: null, detail: '' },
    running: false, ctl: null, live: null, liveLog: [], progress: 0, drawer: null, server: null, store: null,
    confirmClear: false, folderPath: '', loaded: false,
  };
  window.__PR_STATE = S;

  /* ───────── хранилище ───────── */
  const serverStore = {
    name: 'папка data/ на этом компьютере',
    async load() { const r = await fetch('api/workspace'); return r.ok ? r.json() : null; },
    async save(ws) { await fetch('api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ws) }); },
  };
  const idbStore = {
    name: 'только этот браузер',
    db() {
      return new Promise((res, rej) => {
        try { const r = indexedDB.open('pain-registry', 1); r.onupgradeneeded = () => r.result.createObjectStore('ws'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); }
      });
    },
    async load() { try { const db = await this.db(); return await new Promise((res) => { const q = db.transaction('ws').objectStore('ws').get('main'); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); } catch (e) { return null; } },
    async save(ws) { try { const db = await this.db(); db.transaction('ws', 'readwrite').objectStore('ws').put(JSON.parse(JSON.stringify(ws)), 'main'); } catch (e) { /* хранилище недоступно — работаем в памяти */ } },
  };
  let saveTimer = null;
  function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(() => S.store && S.store.save(S.ws).catch(() => toast('Не удалось сохранить рабочее пространство')), 500); }

  /* ───────── движок ───────── */
  async function initEnvironment() {
    try {
      const r = await fetch('api/status', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        if (j && j.mode === 'local') { S.mode = 'local'; S.server = j.config; S.store = serverStore; }
      }
    } catch (e) { /* не локальный режим */ }
    if (!S.store) { S.mode = window.claude && window.claude.use ? 'artifact' : 'standalone'; S.store = idbStore; }
    let ws = null;
    try { ws = await S.store.load(); } catch (e) { ws = null; }
    S.ws = ws && ws.docs ? PR.migrate(ws) : PR.newWorkspace();
    S.loaded = true;
    if (S.mode === 'local') {
      S.engine = { kind: 'server', label: S.server.model, llm: PR.makeServerLLM(), detail: S.server.base_url };
    }
    render();
    if (S.mode === 'artifact') {
      const sample = await window.claude.use('sample');
      if (sample) S.engine = { kind: 'claude', label: 'Claude', llm: PR.makeClaudeLLM(sample, S.ws.settings.llm.tier), detail: 'через claude.ai, расходует лимит смотрящего' };
      S.engineChecked = true;
      render();
    }
  }
  const activeLLM = () => (S.ws.settings.useModel === false ? null : S.engine.llm);

  /* ───────── уведомления ───────── */
  let toastTimer;
  function toast(msg) {
    let el = $('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 3200);
  }

  async function saveFile(filename, data, mime) {
    if (S.mode === 'artifact') {
      const dl = await window.claude.use('downloads');
      if (!dl) { toast('Скачивание недоступно в этом окне'); return; }
      try { await dl.save({ filename, data }); } catch (e) { if (e && e.code !== 'cancelled') toast('Файл не сохранён: ' + (e.message || e.code)); }
      return;
    }
    const url = URL.createObjectURL(new Blob([data], { type: mime || 'text/plain;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  async function copy(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg || 'Скопировано'); }
    catch (e) { toast('Буфер обмена недоступен — используйте экспорт в Markdown'); }
  }

  /* ───────── иконки ───────── */
  const I = {
    backlog: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    themes: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="7" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><circle cx="12" cy="17" r="3"/><path d="M9 9l2 5M15 9l-2 5"/></svg>',
    sources: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>',
    pipeline: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="6" height="6" rx="1"/><rect x="15" y="4" width="6" height="6" rx="1"/><rect x="9" y="14" width="6" height="6" rx="1"/><path d="M9 7h6M6 10v3a2 2 0 0 0 2 2h1M18 10v3a2 2 0 0 1-2 2h-1"/></svg>',
    quality: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    settings: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    play: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>',
    open: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    upload: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>',
  };

  /* ───────── общий каркас ───────── */
  const NAV = [
    ['backlog', 'Бэклог', () => S.ws.backlog.length],
    ['themes', 'Темы', () => S.ws.themes.length],
    ['sources', 'Источники', () => S.ws.docs.length],
    ['pipeline', 'Конвейер', () => ''],
    ['quality', 'Качество', () => S.ws.docs.filter((d) => d.reviewed).length || ''],
    ['settings', 'Настройки', () => ''],
  ];

  function render() {
    const app = $('#app');
    if (!app) return;
    const eng = S.ws.settings.useModel === false ? { cls: 'warn', text: 'Без модели: эвристика' }
      : S.engine.llm ? { cls: 'on', text: S.engine.label } : { cls: 'warn', text: S.mode === 'artifact' && !S.engineChecked ? 'Подключаю Claude…' : S.mode === 'artifact' ? 'Claude недоступен: войдите в claude.ai. Работает эвристика' : 'Модель не подключена' };
    app.innerHTML = `
      <nav class="rail" aria-label="Разделы">
        <div class="brand"><div class="brand-mark">${I.backlog}</div><div><div class="brand-name">Реестр болей</div><div class="brand-sub">обратная связь → бэклог</div></div></div>
        ${NAV.map(([id, label, cnt]) => `<button class="nav-btn" data-act="nav" data-v="${id}" ${S.view === id ? 'aria-current="page"' : ''}>${I[id]}<span>${label}</span><span class="count">${cnt()}</span></button>`).join('')}
        <div class="rail-foot">
          <div class="engine"><span class="dot ${eng.cls}"></span><span>${esc(eng.text)}</span></div>
          <div class="hint">Данные: ${esc(S.store ? S.store.name : '…')}</div>
        </div>
      </nav>
      <main class="main" id="main">${S.loaded ? VIEWS[S.view]() : '<div class="empty">Загрузка…</div>'}</main>`;
    renderDrawer();
  }

  function head(title, sub, actions) {
    return `<div class="page-head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="actions">${actions || ''}</div></div>`;
  }
  function demoBanner() {
    if (!S.ws.demo) return '';
    return `<div class="banner"><div class="grow"><b>Это пример на вымышленных компаниях.</b> Результат подготовлен заранее, чтобы показать, как выглядит бэклог с происхождением. Загрузите свои расшифровки, конспекты, таблицы обращений или письма — и запустите конвейер.</div><button class="btn sm primary" data-act="clear-demo">Начать со своих файлов</button></div>`;
  }
  const runBtn = (label) => S.running ? `<button class="btn" data-act="stop">Остановить</button>` : `<button class="btn primary" data-act="run" data-scope="new">${I.play}${label || 'Запустить конвейер'}</button>`;

  /* ───────── БЭКЛОГ ───────── */
  function viewBacklog() {
    const ws = S.ws;
    const live = PR.liveItems(ws);
    const llmItems = ws.items.filter((i) => i.source === 'llm' || i.source === 'heuristic');
    const verified = llmItems.length ? Math.round(100 * llmItems.filter((i) => i.quoteStatus === 'verified').length / llmItems.length) : 0;
    let list = ws.backlog.slice();
    if (S.filter === 'P1') list = list.filter((b) => b.priority === 'P1');
    if (S.filter === 'block') list = list.filter((b) => b.stats.blockers);
    if (S.query) { const q = U.norm(S.query); list = list.filter((b) => U.norm(b.title + ' ' + b.problem).includes(q)); }
    if (!S.selB || !ws.backlog.some((b) => b.id === S.selB)) S.selB = (list[0] || {}).id || null;
    const maxScore = Math.max(1, ...ws.backlog.map((b) => b.score));
    const sel = ws.backlog.find((b) => b.id === S.selB);
    if (!ws.backlog.length) {
      return head('Бэклог', 'Пункты появятся после первого прогона конвейера.') + demoBanner() + `<div class="card empty"><h3>Бэклог пока пуст</h3><p>Добавьте источники и запустите конвейер: он извлечёт обратную связь, сгруппирует её в темы и предложит задачи.</p><div class="actions"><button class="btn" data-act="nav" data-v="sources">Добавить источники</button>${runBtn()}</div></div>`;
    }
    return head('Бэклог', 'Каждый пункт собран из тем, а каждая тема — из дословных цитат клиентов. Откройте пункт, чтобы увидеть, из чего он получился, и провалиться до реплики в исходном файле.',
      `<button class="btn" data-act="export-md">Markdown</button><button class="btn" data-act="export-csv">CSV для трекера</button>${runBtn('Пересобрать')}`) + demoBanner() + `
      <div class="kpis">
        <div class="kpi"><b>${ws.docs.length}</b><span>источников</span></div>
        <div class="kpi"><b>${live.length}</b><span>единиц обратной связи</span></div>
        <div class="kpi"><b>${ws.themes.length}</b><span>тем</span></div>
        <div class="kpi"><b>${ws.backlog.length}</b><span>пунктов бэклога</span></div>
        <div class="kpi"><b>${verified}%</b><span>цитат найдено дословно</span></div>
      </div>
      <div class="split">
        <section class="card blist" aria-label="Пункты бэклога">
          <div class="blist-head">
            ${[['all', 'Все'], ['P1', 'P1'], ['block', 'Блокеры сделок']].map(([k, l]) => `<button class="btn sm ${S.filter === k ? 'primary' : ''}" data-act="filter" data-v="${k}">${l}</button>`).join('')}
            <input class="input" id="bq" type="search" placeholder="Поиск" value="${esc(S.query)}" data-change="query" style="flex:1;min-width:120px">
          </div>
          ${list.map((b) => `
            <button class="brow" data-act="selb" data-id="${b.id}" aria-selected="${b.id === S.selB}">
              <span class="prio ${b.priority}">${b.priority}</span>
              <span style="min-width:0"><span class="brow-title">${esc(b.title)}</span>
                <span class="brow-meta"><span>${KIND[b.kind] || b.kind}</span><span>${plural(b.stats.orgs, 'клиент', 'клиента', 'клиентов')}</span><span>${plural(b.stats.items, 'цитата', 'цитаты', 'цитат')}</span>${b.stats.blockers ? '<span class="pill bad">блокер сделки</span>' : ''}${b.status && b.status !== 'new' ? `<span class="pill">${STATUS[b.status]}</span>` : ''}</span></span>
              <span class="score"><b>${b.score}</b><span class="scorebar"><i style="width:${Math.round(100 * b.score / maxScore)}%"></i></span></span>
            </button>`).join('') || '<div class="empty">Ничего не найдено</div>'}
        </section>
        <section class="detail">${sel ? backlogDetail(sel) : ''}</section>
      </div>`;
  }

  const PART_COLORS = ['var(--accent)', 'var(--violet)', 'var(--bad)', 'var(--warn)', 'var(--ok)'];
  function backlogDetail(b) {
    const lin = PR.lineage(S.ws, b);
    const total = b.scoreParts.reduce((s, p) => s + p.pts, 0) || 1;
    return `
      <div class="card pad detail-head">
        <div class="chips"><span class="prio ${b.priority}">${b.priority}</span><span class="pill accent">${KIND[b.kind] || b.kind}</span>
          ${b.stats.blockers ? `<span class="pill bad">блокер сделки у ${b.stats.blockers}</span>` : ''}
          <span class="pill">${b.createdBy === 'llm' ? 'сформулировано моделью' : b.createdBy === 'demo' ? 'пример' : 'шаблон без модели'}</span>
          <select class="select" data-change="bstatus" data-id="${b.id}" aria-label="Статус" style="margin-left:auto;padding:3px 8px">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${b.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </div>
        <h2>${esc(b.title)}</h2>
        <div class="cols2 prose">
          <div><div class="eyebrow">Проблема</div><p>${esc(b.problem)}</p></div>
          <div><div class="eyebrow">Что сделать</div><p>${esc(b.proposal)}</p></div>
        </div>
        ${b.acceptance && b.acceptance.length ? `<div><div class="eyebrow">Критерии приёмки</div><ul class="ac">${b.acceptance.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>` : ''}
        <div class="actions"><button class="btn sm" data-act="copy-item" data-id="${b.id}">Скопировать для трекера</button></div>
      </div>
      <div class="card pad breakdown">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px"><h3>Почему такой приоритет</h3><span class="mono">скор ${b.score}</span></div>
        <div class="stack" role="img" aria-label="Состав скора">${b.scoreParts.map((p, i) => p.pts > 0 ? `<i style="width:${(100 * p.pts / total).toFixed(1)}%;background:${PART_COLORS[i]}"></i>` : '').join('')}</div>
        <div class="legend">${b.scoreParts.map((p, i) => `<span><i style="background:${PART_COLORS[i]}"></i>${p.k}: ${p.v} × ${p.w}<b>${p.pts}</b></span>`).join('')}</div>
        <div class="hint">Скор считает формула, а не модель. Веса меняются в настройках.</div>
      </div>
      <div class="card pad" style="display:flex;flex-direction:column;gap:12px">
        <div><h3>Из чего собрано</h3><p class="muted" style="margin:2px 0 0">${plural(new Set(lin.flatMap((x) => x.items.map((i) => i.item.docId))).size, 'источник', 'источника', 'источников')} → ${plural(lin.length, 'тема', 'темы', 'тем')} → этот пункт. Толщина линии — число цитат.</p></div>
        <div class="flow">${flowSVG(b, lin)}</div>
      </div>
      ${lin.map(({ theme, items }, k) => `
        <details class="theme-block" ${k === 0 ? 'open' : ''}>
          <summary><div><div class="theme-title">${esc(theme.title)}</div><div class="theme-stmt">${esc(theme.statement)}</div></div>
            <div class="chips"><span class="pill accent">${plural(theme.stats.orgs, 'клиент', 'клиента', 'клиентов')}</span><span class="pill">${plural(items.length, 'цитата', 'цитаты', 'цитат')}</span></div></summary>
          <div class="ev-list">${items.map(evRow).join('')}</div>
        </details>`).join('')}`;
  }

  function evRow({ item, doc, seg }) {
    const qs = QS[item.quoteStatus] || QS.missing;
    return `<div class="ev">
      <div style="min-width:0"><q>${esc(item.quote)}</q><div class="ev-sum">${esc(item.summary)}</div>
        <div class="ev-meta"><b>${esc(doc ? (doc.org || doc.orgGuess || doc.title) : '')}</b><span>${doc ? U.fmtDate(doc.date) : ''}</span>${seg && seg.ts ? `<span class="mono">${esc(seg.ts)}</span>` : ''}<span class="pill ${item.type === 'blocker' ? 'bad' : ''}">${PR.TYPE_LABEL[item.type] || item.type}</span><span class="faint" title="${esc(doc ? doc.name : '')}">${esc(doc ? doc.kind : '')}</span></div></div>
      <div class="ev-side"><span class="pill ${qs[0]}" title="${qs[1]}">${item.quoteStatus === 'verified' ? '✓ дословно' : item.quoteStatus === 'approx' ? '≈ близко' : '✗ нет'}</span>
        <button class="btn sm" data-act="open-src" data-doc="${item.docId}" data-item="${item.id}">${I.open}В источнике</button></div>
    </div>`;
  }

  function flowSVG(b, lin) {
    const docs = new Map();
    lin.forEach(({ theme, items }) => items.forEach(({ item, doc }) => {
      if (!doc) return;
      const d = docs.get(doc.id) || { doc, n: 0, themes: new Map() };
      d.n++; d.themes.set(theme.id, (d.themes.get(theme.id) || 0) + 1); docs.set(doc.id, d);
    }));
    const L = [...docs.values()].sort((a, b) => b.n - a.n);
    const T = lin.map((x) => ({ theme: x.theme, n: x.items.length }));
    const rowH = 34, W = 820, x1 = 8, w1 = 250, x2 = 330, w2 = 260, x3 = 650, w3 = 162;
    const H = Math.max(L.length, T.length, 1) * rowH + 16;
    const yL = (i) => 8 + i * rowH + (H - 16 - L.length * rowH) / 2;
    const yT = (i) => 8 + i * rowH + (H - 16 - T.length * rowH) / 2;
    const yB = H / 2 - 22;
    const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Происхождение пункта бэклога">`;
    L.forEach((d, i) => {
      [...d.themes.entries()].forEach(([tid, n]) => {
        const j = T.findIndex((t) => t.theme.id === tid); if (j < 0) return;
        const ya = yL(i) + 13, yb = yT(j) + 13;
        svg += `<path class="link" stroke-width="${2 + n * 2.5}" d="M${x1 + w1},${ya} C${x1 + w1 + 40},${ya} ${x2 - 40},${yb} ${x2},${yb}"/>`;
      });
    });
    T.forEach((t, j) => { const ya = yT(j) + 13, yb = yB + 22; svg += `<path class="link" stroke-width="${2 + t.n * 2.5}" d="M${x2 + w2},${ya} C${x2 + w2 + 30},${ya} ${x3 - 30},${yb} ${x3},${yb}"/>`; });
    L.forEach((d, i) => { svg += `<g><title>${esc(d.doc.title)}</title><rect class="node" x="${x1}" y="${yL(i)}" width="${w1}" height="26" rx="6"/><text x="${x1 + 10}" y="${yL(i) + 17}">${esc(cut(d.doc.org || d.doc.orgGuess || d.doc.title, 24))}</text><text class="lbl-muted" x="${x1 + w1 - 8}" y="${yL(i) + 17}" text-anchor="end">${d.n}</text></g>`; });
    T.forEach((t, j) => { svg += `<g><title>${esc(t.theme.title)}</title><rect class="node theme" x="${x2}" y="${yT(j)}" width="${w2}" height="26" rx="6"/><text x="${x2 + 10}" y="${yT(j) + 17}">${esc(cut(t.theme.title, 30))}</text></g>`; });
    svg += `<g><title>${esc(b.title)}</title><rect class="node target" x="${x3}" y="${yB}" width="${w3}" height="44" rx="8"/><text class="t-target" x="${x3 + 10}" y="${yB + 19}">${esc(cut(b.title, 20))}</text><text class="t-target" x="${x3 + 10}" y="${yB + 35}" style="font-weight:400;opacity:.85">${b.priority} · скор ${b.score}</text></g>`;
    return svg + '</svg>';
  }

  /* ───────── ТЕМЫ ───────── */
  function viewThemes() {
    const ws = S.ws;
    const cats = ws.settings.taxonomy;
    let themes = ws.themes.slice().sort((a, b) => b.stats.orgs - a.stats.orgs || b.stats.items - a.stats.items);
    if (S.themeCat) themes = themes.filter((t) => t.category === S.themeCat);
    const inB = (t) => ws.backlog.filter((b) => b.themes.includes(t.id));
    const catName = (id) => (cats.find((c) => c.id === id) || { name: id }).name;
    return head('Темы', 'Промежуточный слой между цитатами и бэклогом. Темы отсортированы по числу разных клиентов: один клиент на нескольких встречах считается один раз.',
      `<select class="select" data-change="themecat" aria-label="Категория"><option value="">Все категории</option>${cats.map((c) => `<option value="${c.id}" ${S.themeCat === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`) + `
      <div class="card table-wrap"><table class="grid"><thead><tr><th>Тема</th><th>Категория</th><th class="r">Клиентов</th><th class="r">Внутр.</th><th class="r">Цитат</th><th class="r">Блокеры</th><th>Период</th><th>В бэклоге</th></tr></thead><tbody>
      ${themes.map((t) => `<tr>
        <td style="min-width:260px"><details><summary style="cursor:pointer"><b>${esc(t.title)}</b><div class="muted" style="font-size:12.5px">${esc(t.statement)}</div></summary>
          <div class="ev-list" style="margin-top:6px">${PR.liveItems(ws).filter((i) => i.themeId === t.id).map((i) => { const d = ws.docs.find((x) => x.id === i.docId); return evRow({ item: i, doc: d, seg: d && d.segments[i.seg] }); }).join('')}</div></details></td>
        <td>${esc(catName(t.category))}</td><td class="r num">${t.stats.orgs}</td><td class="r num">${t.stats.orgsInt}</td><td class="r num">${t.stats.items}</td><td class="r num">${t.stats.blockers || ''}</td>
        <td class="num" style="white-space:nowrap">${t.stats.first ? U.fmtDate(t.stats.first) + (t.stats.last !== t.stats.first ? ' – ' + U.fmtDate(t.stats.last) : '') : '—'}</td>
        <td>${inB(t).map((b) => `<a href="#" data-act="goto-b" data-id="${b.id}">${esc(b.title)}</a>`).join('<br>') || '<span class="faint">—</span>'}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">Тем пока нет — запустите конвейер</td></tr>'}
      </tbody></table></div>`;
  }

  /* ───────── ИСТОЧНИКИ ───────── */
  const FORMATS = ['txt', 'md', 'docx', 'pdf', 'pptx', 'xlsx', 'csv', 'tsv', 'json', 'vtt', 'srt', 'html', 'eml'];
  function viewSources() {
    const ws = S.ws;
    const counts = (d) => { const its = ws.items.filter((i) => i.docId === d.id); return { llm: its.filter((i) => i.source === 'llm').length, base: its.filter((i) => i.source === 'baseline').length, heur: its.filter((i) => i.source === 'heuristic').length }; };
    const speakers = new Map();
    ws.docs.forEach((d) => new Set(d.segments.map((s) => s.speaker).filter(Boolean)).forEach((sp) => speakers.set(sp, (speakers.get(sp) || 0) + 1)));
    const vendors = new Set(ws.settings.vendorSpeakers);
    const sug = new Set(PR.suggestVendors(ws.docs).map((x) => x.speaker));
    const topSpeakers = [...speakers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);
    return head('Источники', 'Расшифровки встреч, конспекты, таблицы обращений, письма, презентации. Формат определяется автоматически, организация и дата — из названия и текста; их можно поправить прямо в таблице.') + `
      <label class="drop" id="drop" for="file-in">
        <span style="color:var(--accent)">${I.upload}</span>
        <span class="grow"><b>Перетащите файлы сюда или нажмите, чтобы выбрать</b><div class="formats">${FORMATS.map((f) => `<span>${f}</span>`).join('')}${S.mode === 'local' ? '<span>mp3</span><span>m4a</span><span>wav</span>' : ''}</div></span>
        <span class="btn primary">Выбрать файлы</span>
        <input id="file-in" type="file" multiple hidden data-change="files">
      </label>
      ${S.mode === 'local' ? `<div class="card pad" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap"><div class="field" style="flex:1;min-width:240px"><label for="folder">Добавить всю папку с этого компьютера</label><input class="input" id="folder" placeholder="C:/Users/me/interviews" value="${esc(S.folderPath)}" data-change="folder"></div><label class="engine"><input type="checkbox" id="rec" checked> с подпапками</label><button class="btn" data-act="import-folder">Добавить папку</button></div>` : ''}
      ${topSpeakers.length ? `<div class="card pad" style="display:flex;flex-direction:column;gap:8px"><div><h3>Кто из спикеров — наша команда</h3><p class="muted" style="margin:2px 0 0">Их реплики не считаются обратной связью клиента. Подсвечены те, кто есть в большинстве источников.</p></div>
        <div class="chips">${topSpeakers.map(([sp, n]) => `<label class="pill ${vendors.has(sp) ? 'accent' : sug.has(sp) ? 'warn' : ''}" style="cursor:pointer"><input type="checkbox" data-change="vendor" data-sp="${esc(sp)}" ${vendors.has(sp) ? 'checked' : ''} style="margin:0 4px 0 0">${esc(sp)} <span class="mono faint">${n}</span></label>`).join('')}</div></div>` : ''}
      <div class="card table-wrap"><table class="grid"><thead><tr><th>Источник</th><th>Тип</th><th>Дата</th><th>Организация</th><th>Сегмент</th><th class="r">Реплик</th><th class="r">Найдено</th><th class="r" title="Активное время проверки в инструменте">С инструментом</th><th class="r" title="Сколько минут ушло на разбор этого источника вручную, по секундомеру">Вручную, мин</th><th>Эталон</th><th></th></tr></thead><tbody>
      ${ws.docs.map((d) => { const c = counts(d); return `<tr>
        <td style="min-width:220px"><a href="#" data-act="open-src" data-doc="${d.id}"><b>${esc(d.title)}</b></a><div class="faint" style="font-size:12px">${esc(d.name)}${d.termFixes ? ` · исправлено терминов: ${d.termFixes}` : ''}</div></td>
        <td>${esc(d.kind)}</td>
        <td><input class="cell-input mono" type="date" value="${esc(d.date)}" data-change="doc-date" data-id="${d.id}" aria-label="Дата"></td>
        <td><input class="cell-input" value="${esc(d.org)}" placeholder="${esc(d.orgGuess || 'не определена')}" data-change="doc-org" data-id="${d.id}" aria-label="Организация"></td>
        <td><select class="cell-input" data-change="doc-seg" data-id="${d.id}" aria-label="Сегмент">${['', 'LE', 'SMB', 'внутренний'].map((s) => `<option value="${s}" ${d.segment === s ? 'selected' : ''}>${s || '—'}</option>`).join('')}</select></td>
        <td class="r num">${d.segments.length}</td>
        <td class="r num" title="модель / бейзлайн">${d.status === 'extracted' ? `${c.llm || c.heur} <span class="faint">/ ${c.base}</span>` : '<span class="pill">ждёт</span>'}</td>
        <td class="r num">${PR.reviewMinutes(d) ? PR.reviewMinutes(d).toFixed(1) + ' мин' : '—'}</td>
        <td class="r"><input class="cell-input mono" type="number" min="0" step="1" style="width:64px;text-align:right" value="${d.manualMin || ''}" placeholder="—" data-change="doc-manual" data-id="${d.id}" aria-label="Минут на ручной разбор"></td>
        <td><input type="checkbox" data-change="doc-rev" data-id="${d.id}" ${d.reviewed ? 'checked' : ''} aria-label="Размечен как эталон"></td>
        <td><button class="btn sm ghost" data-act="del-doc" data-id="${d.id}" aria-label="Удалить">✕</button></td></tr>`; }).join('') || '<tr><td colspan="11" class="empty">Источников пока нет</td></tr>'}
      </tbody></table></div>`;
  }

  async function addFiles(files) {
    let ok = 0;
    const transcribe = S.mode === 'local' ? async (f) => {
      const r = await fetch('api/transcribe?name=' + encodeURIComponent(f.name), { method: 'POST', body: await f.arrayBuffer() });
      const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
    } : null;
    for (const f of files) {
      if (S.ws.docs.some((d) => d.name === f.name && d.size === f.size)) { toast(`«${f.name}» уже добавлен`); continue; }
      try {
        toast(`Читаю «${f.name}»…`);
        const doc = await PR.parseFile(f, { transcribe });
        PR.normalizeDoc(doc, S.ws.settings, S.ws.docs);
        S.ws.docs.push(doc); ok++;
      } catch (e) { toast(`«${f.name}»: ${e.message}`); await U.sleep(1200); }
    }
    if (ok) {
      const sug = PR.suggestVendors(S.ws.docs).map((x) => x.speaker).filter((s) => !S.ws.settings.vendorSpeakers.includes(s));
      if (sug.length && !S.ws.settings.vendorSpeakers.length) { S.ws.settings.vendorSpeakers.push(...sug); S.ws.docs.forEach((d) => PR.normalizeDoc(d, S.ws.settings, S.ws.docs)); }
      toast(`Добавлено: ${plural(ok, 'источник', 'источника', 'источников')}. Запустите конвейер, чтобы обработать.`);
      persist(); render();
    }
  }

  async function importFolder() {
    const path = ($('#folder') || {}).value || '';
    const rec = ($('#rec') || {}).checked;
    if (!path) { toast('Укажите путь к папке'); return; }
    S.folderPath = path;
    try {
      const r = await fetch(`api/folder?path=${encodeURIComponent(path)}&recursive=${rec ? 1 : 0}`);
      const j = await r.json(); if (!r.ok) throw new Error(j.error);
      const allowed = new RegExp('\\.(' + FORMATS.join('|') + '|markdown|htm|mp3|m4a|wav|ogg)$', 'i');
      const files = j.files.filter((f) => allowed.test(f.name));
      toast(`Найдено файлов: ${files.length}`);
      const wrapped = files.map((f) => ({ name: f.name, size: f.size, lastModified: f.mtime,
        async blob() { if (!this._b) this._b = await (await fetch('api/file?path=' + encodeURIComponent(f.path))).blob(); return this._b; },
        async text() { return (await this.blob()).text(); }, async arrayBuffer() { return (await this.blob()).arrayBuffer(); } }));
      await addFiles(wrapped);
    } catch (e) { toast('Папка не добавлена: ' + e.message); }
  }

  /* ───────── КОНВЕЙЕР ───────── */
  const STAGE_DESC = {
    'Нормализация': 'Исправляет искажённые термины по глоссарию и отделяет реплики нашей команды',
    'Извлечение': 'Находит атомарные единицы обратной связи с дословной цитатой и категорией',
    'Сверка цитат': 'Ищет каждую цитату в исходнике; ненайденные не попадают в бэклог',
    'Темы': 'Группирует единицы в темы, переиспользуя уже существующие',
    'Бэклог': 'Превращает темы в задачи; приоритет считает формула',
  };
  function viewPipeline() {
    const ws = S.ws;
    const run = S.live || ws.runs[0];
    const pending = ws.docs.filter((d) => d.status !== 'extracted').length;
    const names = Object.keys(STAGE_DESC);
    const st = (n) => run && run.stages.find((s) => s.name === n);
    const curIdx = S.running && run ? run.stages.length - 1 : -1;
    const llm = activeLLM();
    const engineText = llm ? `${S.engine.kind === 'claude' ? 'Claude через claude.ai' : 'OpenAI-совместимая модель'} · ${esc(S.engine.label)}${S.engine.detail ? ' · ' + esc(S.engine.detail) : ''}` : 'Без модели: извлечение и темы делает эвристика (это и есть бейзлайн)';
    return head('Конвейер', 'Пять ступеней от файла до задачи. Каждая ступень пишет, сколько обработала, сколько заняла и сколько токенов потратила.') + `
      <div class="card pad" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
        <div style="flex:1;min-width:240px"><div class="eyebrow">Движок</div><div style="margin-top:2px">${engineText}</div>
          ${S.engine.kind === 'claude' && llm ? '<div class="hint">Первый вызов попросит разрешение. Расшифровки уходят в Claude — загружайте только обезличенные данные.</div>' : ''}
          ${S.mode === 'local' && llm ? '<div class="hint">Вызовы идут через server.py на ваш endpoint; ключ хранится на сервере.</div>' : ''}</div>
        <div class="actions">
          <label class="engine"><input type="checkbox" id="opt-rebuild"> пересобрать темы с нуля</label>
          ${S.running ? '<button class="btn" data-act="stop">Остановить</button>' : `<button class="btn" data-act="run" data-scope="all">Все источники заново</button><button class="btn primary" data-act="run" data-scope="new" ${!ws.docs.length ? 'disabled' : ''}>${I.play}${pending ? 'Обработать новые: ' + pending : 'Пересобрать темы и бэклог'}</button>`}
        </div>
      </div>
      ${S.running ? `<div class="progress" aria-label="Прогресс"><i style="width:${Math.round(S.progress * 100)}%"></i></div>` : ''}
      <div class="stages">${names.map((n, i) => { const s = st(n); return `<div class="stage ${i === curIdx ? 'active' : s && !S.running || (S.running && i < curIdx) ? 'done' : ''}">
        <div class="stage-n">${i + 1}</div><div class="stage-name">${n}</div><div class="stage-desc">${STAGE_DESC[n]}</div>
        <div class="stage-stat">${s ? `${s.count}${s.note ? ' ' + esc(s.note) : ''}<br>${(s.ms / 1000).toFixed(1)} с${s.calls ? ` · ${s.calls} выз. · ${s.estimated ? '≈' : ''}${(s.tokIn + s.tokOut).toLocaleString('ru-RU')} ток.` : ''}${s.errors ? ` · <span style="color:var(--bad)">ошибок ${s.errors}</span>` : ''}` : '—'}</div></div>`; }).join('')}</div>
      <div class="cols2">
        <div class="card pad" style="display:flex;flex-direction:column;gap:8px"><h3>Журнал прогона</h3><div class="log" id="log">${((S.running ? S.liveLog : run && run.log) || []).map((l) => `<div class="${l.level === 'error' ? 'error' : ''}">${new Date(l.t).toLocaleTimeString('ru-RU')}  ${esc(l.msg)}</div>`).join('') || 'Здесь появится ход обработки.'}</div></div>
        <div class="card pad" style="display:flex;flex-direction:column;gap:8px"><h3>Итог последнего прогона</h3>${run && run.totals ? runSummary(run) : '<p class="muted">Прогонов ещё не было.</p>'}</div>
      </div>
      <div class="card table-wrap"><table class="grid"><thead><tr><th>Когда</th><th>Движок</th><th class="r">Вызовов</th><th class="r">Токенов</th><th class="r">Время</th><th class="r">Стоимость</th><th>Итог</th></tr></thead><tbody>
        ${ws.runs.map((r) => `<tr><td class="num">${new Date(r.startedAt).toLocaleString('ru-RU')}</td><td>${esc(r.engine)}</td><td class="r num">${r.totals ? r.totals.calls : ''}</td><td class="r num">${r.totals ? (r.totals.estimated ? '≈' : '') + (r.totals.tokIn + r.totals.tokOut).toLocaleString('ru-RU') : ''}</td><td class="r num">${r.totals ? (r.totals.ms / 1000).toFixed(1) + ' с' : ''}</td><td class="r num">${r.totals && r.totals.costRub ? r.totals.costRub + ' ₽' : '—'}</td><td>${r.ok ? '<span class="pill ok">готово</span>' : r.error ? `<span class="pill bad" title="${esc(r.error)}">ошибка</span>` : '<span class="pill">идёт</span>'}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Прогонов нет</td></tr>'}
      </tbody></table></div>`;
  }
  function runSummary(run) {
    const ex = run.stages.find((s) => s.name === 'Извлечение') || {};
    const nd = run.docsProcessed || S.ws.docs.length || 1;
    const t = run.totals;
    return `<div class="kpis">
      <div class="kpi"><b>${(t.ms / 1000).toFixed(1)} с</b><span>весь прогон</span></div>
      <div class="kpi"><b>${ex.ms ? ((ex.ms / 1000) / nd).toFixed(1) + ' с' : '—'}</b><span>извлечение на источник</span></div>
      <div class="kpi"><b>${t.estimated ? '≈' : ''}${(t.tokIn + t.tokOut).toLocaleString('ru-RU')}</b><span>токенов (вход + выход)</span></div>
      <div class="kpi"><b>${t.costRub ? t.costRub + ' ₽' : '—'}</b><span>стоимость по ценам из настроек</span></div></div>
      ${t.estimated ? '<div class="hint">≈ — оценка: Claude в артефакте не сообщает точное число токенов, считаем 3,2 символа на токен.</div>' : ''}`;
  }

  async function runPipeline(scope) {
    if (S.running) return;
    const ws = S.ws;
    if (!ws.docs.length) { toast('Сначала добавьте источники'); return; }
    if (ws.demo) ws.demo = false;
    const llm = activeLLM();
    if (!llm && S.ws.settings.useModel !== false) toast('Модель не подключена — работает эвристика');
    const rebuild = ($('#opt-rebuild') || {}).checked || scope === 'all';
    if (scope === 'all') ws.docs.forEach((d) => (d.status = 'parsed'));
    S.running = true; S.ctl = new AbortController(); S.liveLog = []; S.progress = 0;
    S.view = 'pipeline'; render();
    let last = 0;
    const repaint = () => { const now = Date.now(); if (now - last > 400 && S.view === 'pipeline') { last = now; render(); } };
    const docs = ws.docs.filter((d) => d.status !== 'extracted').map((d) => d.id);
    const run = await PR.runPipeline(ws, llm, { docs, rebuildThemes: rebuild }, {
      signal: S.ctl.signal,
      log: (msg, level) => { S.liveLog.push({ t: Date.now(), msg, level }); const el = $('#log'); if (el) { el.insertAdjacentHTML('beforeend', `<div class="${level === 'error' ? 'error' : ''}">${new Date().toLocaleTimeString('ru-RU')}  ${esc(msg)}</div>`); el.scrollTop = el.scrollHeight; } },
      progress: (p) => { S.progress = p; repaint(); },
      update: (r) => { S.live = r; repaint(); },
    });
    run.docsProcessed = docs.length;
    S.running = false; S.live = null; S.selB = null;
    persist(); render();
    toast(run.ok ? `Готово: ${plural(ws.backlog.length, 'пункт', 'пункта', 'пунктов')} бэклога` : 'Конвейер остановлен: ' + run.error);
  }

  /* ───────── КАЧЕСТВО ───────── */
  function viewQuality() {
    const e = PR.evaluate(S.ws);
    const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
    const model = e.llm.preds ? e.llm : e.heuristic;
    const bar = (label, v, cls) => `<div class="bar-row"><span>${label}</span><span class="bar-track"><i class="${cls}" style="width:${Math.round((v || 0) * 100)}%"></i></span><span class="num r">${pct(v)}</span></div>`;
    const lastLLM = S.ws.runs.find((r) => r.ok && r.totals && r.totals.calls);
    const ex = lastLLM && lastLLM.stages.find((s) => s.name === 'Извлечение');
    const perDoc = lastLLM && ex ? { ms: ex.ms / (lastLLM.docsProcessed || 1), tok: (ex.tokIn + ex.tokOut) / (lastLLM.docsProcessed || 1) } : null;
    return head('Качество', 'Сравнение модели с бейзлайном на ключевых словах по вашей разметке. Откройте источник, отметьте каждую найденную единицу как верную или ошибочную, добавьте пропущенное выделением текста и поставьте галочку «Эталон».',
      `<button class="btn" data-act="export-labels">Скачать разметку (CSV)</button>`) + `
      <div class="kpis">
        <div class="kpi"><b>${e.reviewedDocs}</b><span>источников размечено</span></div>
        <div class="kpi"><b>${e.gold}</b><span>эталонных единиц</span></div>
        <div class="kpi"><b>${e.labeled}</b><span>решений разметчика</span></div>
        <div class="kpi"><b>${e.quotes.total ? pct(e.quotes.verified / e.quotes.total) : '—'}</b><span>цитат модели найдено дословно</span></div>
        <div class="kpi"><b>${e.vendorLeak}</b><span>реплик вендора принято за клиента</span></div>
      </div>
      ${e.reviewedDocs ? '' : '<div class="banner warn"><div class="grow">Метрик пока нет: ни один источник не отмечен как эталон. Откройте источник на вкладке «Источники», разметьте найденное и поставьте галочку «Эталон».</div></div>'}
      <div class="cols2">
        <div class="card pad" style="display:flex;flex-direction:column;gap:12px"><h3>${e.llm.preds ? 'Модель' : 'Эвристика'} против бейзлайна</h3>
          <div class="eyebrow">Точность — доля найденного, что верно</div>${bar(e.llm.preds ? 'Модель' : 'Эвристика', model.precision, 'llm')}${bar('Бейзлайн', e.baseline.precision, 'base')}
          <div class="eyebrow">Полнота — доля эталона, что найдено</div>${bar(e.llm.preds ? 'Модель' : 'Эвристика', model.recall, 'llm')}${bar('Бейзлайн', e.baseline.recall, 'base')}
          <div class="eyebrow">F1</div>${bar(e.llm.preds ? 'Модель' : 'Эвристика', model.f1, 'llm')}${bar('Бейзлайн', e.baseline.f1, 'base')}
          <div class="hint">Найдено: модель ${model.preds}, бейзлайн ${e.baseline.preds}. Совпадение — тот же источник и пересечение цитаты не меньше 50% слов.</div></div>
        <div class="card pad" style="display:flex;flex-direction:column;gap:10px"><h3>Скорость и стоимость</h3>
          ${perDoc ? `<div class="kpis"><div class="kpi"><b>${(perDoc.ms / 1000).toFixed(1)} с</b><span>извлечение на источник</span></div><div class="kpi"><b>${Math.round(perDoc.tok).toLocaleString('ru-RU')}</b><span>токенов на источник</span></div></div>` : '<p class="muted">Появится после прогона с моделью.</p>'}
          <div class="eyebrow">Категории</div><p style="margin:0">Точность категории на подтверждённых единицах: <b>${pct(model.catAcc)}</b> <span class="faint">(${model.catN} шт.)</span></p>
          <div class="eyebrow">Цитаты модели</div><p style="margin:0">дословно ${e.quotes.verified} · близко ${e.quotes.approx} · не найдено ${e.quotes.missing}</p></div>
      </div>
      ${timeCard(PR.timeSavings(S.ws))}`;
  }

  function timeCard(t) {
    const m = (v) => (v == null ? '—' : v.toFixed(1) + ' мин');
    return `<div class="card pad" style="display:flex;flex-direction:column;gap:10px;margin-top:16px"><h3>Время продакта</h3>
      <p class="muted" style="margin:0">С инструментом — активное время в окне источника, считается само. Вручную — минуты по секундомеру на разбор источника без инструмента, вносятся в таблице источников. Чтобы сравнение было честным, вручную и с инструментом разбираются разные, но похожие по объёму источники; время приводится к 10 тысячам знаков.</p>
      <div class="kpis">
        <div class="kpi"><b>${t.tool.n}</b><span>источников проверено в инструменте</span></div>
        <div class="kpi"><b>${m(t.tool.per10k)}</b><span>с инструментом на 10 тыс. знаков</span></div>
        <div class="kpi"><b>${t.manual.n}</b><span>источников разобрано вручную</span></div>
        <div class="kpi"><b>${m(t.manual.per10k)}</b><span>вручную на 10 тыс. знаков</span></div>
        <div class="kpi"><b>${t.savedPct == null ? '—' : Math.round(t.savedPct * 100) + '%'}</b><span>экономия времени</span></div>
        <div class="kpi"><b>${t.hoursYear == null ? '—' : Math.round(t.hoursYear) + ' ч'}</b><span>в год при ${t.meetingsYear} встречах</span></div>
      </div>
      ${t.tool.n ? `<p class="hint" style="margin:0">На один источник в инструменте: отклонено ${t.tool.wrong.toFixed(1)}, подтверждено ${t.tool.ok.toFixed(1)}, добавлено руками ${t.tool.added.toFixed(1)}. Мало подтверждений при большом времени — сигнал, что модель много пропускает.</p>` : ''}
      ${t.tool.n < 3 || t.manual.n < 3 ? '<div class="banner warn"><div class="grow">Для вывода нужно хотя бы по 3 источника каждым способом.</div></div>' : ''}</div>`;
  }

  /* ───────── НАСТРОЙКИ ───────── */
  function viewSettings() {
    const st = S.ws.settings;
    const srv = S.server || {};
    return head('Настройки', 'Модель, таксономия, глоссарий искажений и формула приоритета. Изменения сохраняются сразу.') + `
      <div class="settings-grid">
        <div class="card pad" style="display:flex;flex-direction:column;gap:10px"><h3>Модель</h3>
          <label class="engine"><input type="checkbox" data-change="usemodel" ${st.useModel !== false ? 'checked' : ''}> Использовать модель (иначе работает эвристика-бейзлайн)</label>
          ${S.mode === 'local' ? `
            <div class="field"><label for="c-url">Адрес OpenAI-совместимого API</label><input class="input" id="c-url" value="${esc(srv.base_url)}" placeholder="http://llm.internal:8000/v1"></div>
            <div class="field"><label for="c-model">Модель</label><input class="input" id="c-model" value="${esc(srv.model)}"></div>
            <div class="field"><label for="c-key">Ключ API ${srv.key_source === 'env_file' ? '(взят из ' + esc(srv.env_file) + ')' : srv.has_key ? '(задан, оставьте пустым, чтобы не менять)' : ''}</label><input class="input" id="c-key" type="password" autocomplete="off"></div>
            <div class="field"><label for="c-stt">Модель распознавания речи (для аудио)</label><input class="input" id="c-stt" value="${esc(srv.stt_model)}" placeholder="whisper-1"></div>
            <label class="engine"><input type="checkbox" id="c-json" ${srv.json_mode !== false ? 'checked' : ''}> Просить JSON-режим (response_format)</label>
            <div class="actions"><button class="btn primary" data-act="save-config">Сохранить</button><button class="btn" data-act="test-llm">Проверить связь</button></div>`
            : S.mode === 'artifact' ? `<p class="muted" style="margin:0">Claude через claude.ai. Расход идёт из лимита того, кто запускает.</p>
            <div class="field"><label for="tier">Уровень модели</label><select class="select" id="tier" data-change="tier">${[['quick', 'Быстрая'], ['default', 'Сбалансированная'], ['complex', 'Самая точная']].map(([k, v]) => `<option value="${k}" ${st.llm.tier === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>`
            : '<p class="muted" style="margin:0">Откройте прототип через server.py, чтобы подключить модель.</p>'}
          <div class="field"><label for="chunk">Размер порции текста на вызов, символов</label><input class="input" id="chunk" type="number" min="4000" step="1000" value="${st.llm.chunkChars}" data-change="chunk"></div>
          <div class="field"><label for="conc">Параллельных вызовов</label><input class="input" id="conc" type="number" min="1" max="6" value="${st.llm.concurrency}" data-change="conc"></div>
          <div class="cols2"><div class="field"><label for="pin">Цена входа, ₽ за 1 млн токенов</label><input class="input" id="pin" type="number" min="0" value="${st.prices.inRubPer1M}" data-change="pin"></div><div class="field"><label for="pout">Цена выхода, ₽ за 1 млн токенов</label><input class="input" id="pout" type="number" min="0" value="${st.prices.outRubPer1M}" data-change="pout"></div></div>
        </div>
        <div class="card pad" style="display:flex;flex-direction:column;gap:10px"><h3>Продукт и источники</h3>
          <div class="field"><label for="product">Чем занимается продукт — модель учитывает это при извлечении</label><textarea class="input" id="product" rows="2" data-change="product" style="font-family:var(--f-ui)">${esc(st.product)}</textarea></div>
          <div class="field"><label for="vendors">Наша команда: имена спикеров через запятую</label><textarea class="input" id="vendors" rows="2" data-change="vendors" style="font-family:var(--f-ui)">${esc(st.vendorSpeakers.join(', '))}</textarea></div>
          <div class="field"><label for="intorgs">Внутренние организации (считаются отдельно от клиентов)</label><input class="input" id="intorgs" value="${esc((st.internalOrgs || []).join(', '))}" data-change="intorgs"></div>
          <h3 style="margin-top:6px">Формула приоритета</h3>
          <div class="cols2">${[['orgExt', 'За внешнего клиента'], ['orgInt', 'За внутренний источник'], ['blocker', 'За клиента с блокером'], ['severity', 'За среднюю критичность'], ['recency', 'За долю свежих']].map(([k, l]) => `<div class="field"><label for="w-${k}">${l}</label><input class="input" id="w-${k}" type="number" step="0.5" value="${st.weights[k]}" data-change="weight" data-k="${k}"></div>`).join('')}</div>
        </div>
      </div>
      <div class="card pad" style="display:flex;flex-direction:column;gap:10px"><div><h3>Таксономия</h3><p class="muted" style="margin:2px 0 0">Постоянный набор категорий: модель раскладывает по нему, а не придумывает новые на каждом прогоне. Ключевые слова нужны бейзлайну.</p></div>
        ${st.taxonomy.map((c, i) => `<div class="tax-row"><input class="input mono" value="${esc(c.id)}" data-change="tax" data-i="${i}" data-f="id" aria-label="id"><input class="input" value="${esc(c.name)}" data-change="tax" data-i="${i}" data-f="name" aria-label="Название"><input class="input" value="${esc(c.desc)}" data-change="tax" data-i="${i}" data-f="desc" aria-label="Описание"><input class="input" value="${esc(c.keywords)}" data-change="tax" data-i="${i}" data-f="keywords" aria-label="Ключевые слова"><button class="btn sm ghost" data-act="tax-del" data-i="${i}" aria-label="Удалить">✕</button></div>`).join('')}
        <div><button class="btn sm" data-act="tax-add">Добавить категорию</button></div></div>
      <div class="card pad" style="display:flex;flex-direction:column;gap:8px"><div><h3>Глоссарий искажений расшифровки</h3><p class="muted" style="margin:2px 0 0">По строке на термин: регулярное выражение искажения, затем «=>», затем правильное написание. Применяется до модели.</p></div>
        <textarea class="input" id="gloss" rows="8" data-change="gloss">${esc(st.glossary.map((g) => g.from + ' => ' + g.to).join('\n'))}</textarea></div>
      <div class="card pad" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><h3 style="margin-right:auto">Данные</h3>
        <button class="btn" data-act="export-json">Экспорт рабочего пространства</button>
        <label class="btn" for="imp">Импорт<input id="imp" type="file" accept=".json" hidden data-change="import"></label>
        <button class="btn ${S.confirmClear ? 'primary' : ''}" data-act="clear">${S.confirmClear ? 'Точно удалить всё?' : 'Очистить'}</button></div>`;
  }

  /* ───────── ПРОСМОТР ИСТОЧНИКА ───────── */
  function markText(text, items) {
    const low = text.toLowerCase().replace(/ё/g, 'е');
    const ranges = [];
    items.slice().sort((a, b) => b.quote.length - a.quote.length).forEach((it) => {
      const q = it.quote.toLowerCase().replace(/ё/g, 'е').trim();
      if (q.length < 3) return;
      const at = low.indexOf(q);
      if (at < 0 || ranges.some((r) => at < r.b && at + q.length > r.a)) return;
      ranges.push({ a: at, b: at + q.length, it });
    });
    ranges.sort((x, y) => x.a - y.a);
    let out = '', pos = 0;
    ranges.forEach((r) => { out += esc(text.slice(pos, r.a)) + `<mark class="${r.it.source === 'baseline' ? 'base' : ''}" data-act="focus-item" data-id="${r.it.id}" title="${esc(r.it.summary)}">${esc(text.slice(r.a, r.b))}</mark>`; pos = r.b; });
    return out + esc(text.slice(pos));
  }

  function renderDrawer() {
    let host = $('#drawer-host');
    if (!host) { host = document.createElement('div'); host.id = 'drawer-host'; document.body.appendChild(host); }
    const dr = S.drawer;
    if (!dr) { host.innerHTML = ''; return; }
    const doc = S.ws.docs.find((d) => d.id === dr.docId);
    if (!doc) { S.drawer = null; host.innerHTML = ''; return; }
    const its = S.ws.items.filter((i) => i.docId === doc.id && (i.source !== 'baseline' || dr.showBase));
    const cats = S.ws.settings.taxonomy;
    const themeTitle = (id) => (S.ws.themes.find((t) => t.id === id) || {}).title;
    host.innerHTML = `<div class="drawer-back" data-act="close-drawer-bg"><div class="drawer" role="dialog" aria-modal="true" aria-label="${esc(doc.title)}">
      <div class="drawer-head"><div style="min-width:0;flex:1"><div class="eyebrow">${esc(doc.kind)} · ${esc(doc.name)}</div><h2 style="margin-top:2px">${esc(doc.title)}</h2>
        <div class="chips" style="margin-top:6px"><span class="pill">${U.fmtDate(doc.date)}</span>${doc.org || doc.orgGuess ? `<span class="pill accent">${esc(doc.org || doc.orgGuess)}</span>` : ''}${doc.segment ? `<span class="pill">${esc(doc.segment)}</span>` : ''}<span class="pill">${plural(doc.segments.length, 'реплика', 'реплики', 'реплик')}</span>${doc.termFixes ? `<span class="pill violet">исправлено терминов: ${doc.termFixes}</span>` : ''}</div></div>
        <div class="actions"><label class="engine"><input type="checkbox" data-change="dr-orig" ${dr.orig ? 'checked' : ''}> исходный текст</label><label class="engine"><input type="checkbox" data-change="dr-base" ${dr.showBase ? 'checked' : ''}> показать бейзлайн</label><label class="engine"><input type="checkbox" data-change="doc-rev" data-id="${doc.id}" ${doc.reviewed ? 'checked' : ''}> эталон</label><button class="btn" data-act="close-drawer">Закрыть</button></div></div>
      <div class="drawer-body">
        <div class="transcript" id="transcript">${doc.segments.map((s) => {
          const txt = dr.orig ? s.text : (s.norm || s.text);
          const segItems = its.filter((i) => i.seg === s.i);
          return `<div class="seg ${s.role === 'vendor' ? 'vendor' : ''} ${dr.focusSeg === s.i ? 'focus' : ''}" data-seg="${s.i}" id="seg-${s.i}">
            <div class="seg-ts">${esc(s.ts)}</div><div style="min-width:0">${s.speaker ? `<div class="seg-sp">${esc(s.speaker)}${s.role === 'vendor' ? '<span class="pill">наша команда</span>' : ''}</div>` : ''}<div class="seg-text">${markText(txt, segItems)}</div>${s.meta ? `<div class="faint" style="font-size:12px">${esc(s.meta)}</div>` : ''}</div></div>`; }).join('')}
          <div class="hint" style="padding:12px 8px">Выделите фрагмент текста, чтобы добавить пропущенную обратную связь вручную.</div></div>
        <aside class="side"><div style="display:flex;justify-content:space-between;align-items:baseline"><h3>Найдено в источнике</h3><span class="mono faint">${its.length}</span></div>
          ${its.length ? its.slice().sort((a, b) => a.seg - b.seg).map((i) => `<div class="icard ${dr.focusItem === i.id ? 'sel' : ''} ${i.label === 'wrong' ? 'wrong' : ''}" id="ic-${i.id}">
            <div class="row"><span class="pill ${i.source === 'llm' ? 'accent' : i.source === 'manual' ? 'violet' : ''}">${SRC[i.source]}</span><span class="pill ${i.type === 'blocker' ? 'bad' : ''}">${PR.TYPE_LABEL[i.type]}</span><span class="pill ${(QS[i.quoteStatus] || QS.missing)[0]}">${i.quoteStatus === 'verified' ? '✓' : i.quoteStatus === 'approx' ? '≈' : '✗'}</span><a href="#" class="mono" style="margin-left:auto;font-size:12px" data-act="focus-seg" data-seg="${i.seg}">#${i.seg}</a></div>
            <div style="font-weight:600;line-height:1.35">${esc(i.summary)}</div>
            <div class="muted" style="font-size:12.5px">«${esc(i.quote)}»</div>
            ${i.themeId && themeTitle(i.themeId) ? `<div style="font-size:12px">Тема: <b>${esc(themeTitle(i.themeId))}</b></div>` : ''}
            <div class="row"><select class="select" style="padding:2px 6px;font-size:12px;flex:1;min-width:0" data-change="item-cat" data-id="${i.id}" aria-label="Категория">${cats.map((c) => `<option value="${c.id}" ${(i.labelCategory || i.category) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
              <button class="lbl-btn ok" aria-pressed="${i.label === 'ok'}" data-act="label" data-id="${i.id}" data-v="ok" title="Верно">✓ верно</button><button class="lbl-btn bad" aria-pressed="${i.label === 'wrong'}" data-act="label" data-id="${i.id}" data-v="wrong" title="Ошибка">✗</button>${i.source === 'manual' ? `<button class="lbl-btn" data-act="del-item" data-id="${i.id}">удалить</button>` : ''}</div></div>`).join('') : '<p class="muted">Пока ничего: запустите конвейер или выделите текст слева.</p>'}
        </aside></div></div></div>`;
    if (dr.scrollTo != null) { const el = $('#seg-' + dr.scrollTo); if (el) el.scrollIntoView({ block: 'center' }); dr.scrollTo = null; }
  }

  /* Замер времени проверки источника. Считается только активное время: вкладка видна
     и за последние 2 минуты была мышь или клавиатура — открытое и забытое окно не в счёт. */
  const IDLE_MS = 120000;
  let lastInput = Date.now();
  ['mousemove', 'mousedown', 'keydown', 'wheel', 'scroll'].forEach((ev) => document.addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true, capture: true }));
  function tickReview() {
    const r = S.review; if (!r) return;
    const now = Date.now();
    if (!document.hidden && now - lastInput < IDLE_MS) r.activeMs += now - r.tick;
    r.tick = now;
  }
  setInterval(tickReview, 5000);
  function startReview(docId) {
    if (S.review && S.review.docId === docId) return;
    stopReview();
    S.review = { docId, startedAt: new Date().toISOString(), activeMs: 0, tick: Date.now(), ok: 0, wrong: 0, added: 0 };
  }
  function stopReview() {
    const r = S.review; if (!r) return;
    tickReview(); S.review = null;
    if (r.activeMs < 5000) return; // случайно открыли и закрыли
    const doc = S.ws.docs.find((d) => d.id === r.docId); if (!doc) return;
    (doc.reviewLog = doc.reviewLog || []).push({ startedAt: r.startedAt, activeMs: r.activeMs, ok: r.ok, wrong: r.wrong, added: r.added });
    persist();
  }
  window.addEventListener('beforeunload', stopReview);

  function openSource(docId, itemId) {
    startReview(docId);
    const it = S.ws.items.find((i) => i.id === itemId);
    S.drawer = { docId, focusItem: itemId || null, focusSeg: it ? it.seg : null, scrollTo: it ? it.seg : null, showBase: false, orig: false };
    renderDrawer();
  }

  /* выделение текста → ручная единица */
  document.addEventListener('mouseup', () => {
    const pop = $('.sel-pop'); if (pop) pop.remove();
    if (!S.drawer) return;
    const sel = window.getSelection();
    const txt = sel && sel.toString().trim();
    if (!txt || txt.length < 6) return;
    const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    const seg = node && node.closest && node.closest('.seg');
    if (!seg) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const b = document.createElement('button');
    b.className = 'btn sm primary sel-pop'; b.textContent = 'Добавить как обратную связь';
    b.style.left = Math.min(window.innerWidth - 220, rect.left) + 'px'; b.style.top = Math.max(8, rect.top - 38) + 'px';
    b.dataset.act = 'add-manual'; b.dataset.seg = seg.dataset.seg; b.dataset.quote = txt.slice(0, 600);
    document.body.appendChild(b);
  });

  /* ───────── обработчики ───────── */
  const VIEWS = { backlog: viewBacklog, themes: viewThemes, sources: viewSources, pipeline: viewPipeline, quality: viewQuality, settings: viewSettings };

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const ws = S.ws;
    if (el.tagName === 'A') e.preventDefault();
    switch (act) {
      case 'nav': S.view = el.dataset.v; S.confirmClear = false; render(); window.scrollTo(0, 0); break;
      case 'selb': S.selB = el.dataset.id; render(); if (window.innerWidth < 1100) { const d = $('.detail'); d && d.scrollIntoView({ behavior: 'smooth' }); } break;
      case 'goto-b': S.selB = el.dataset.id; S.view = 'backlog'; render(); break;
      case 'filter': S.filter = el.dataset.v; render(); break;
      case 'run': runPipeline(el.dataset.scope); break;
      case 'stop': S.ctl && S.ctl.abort(); toast('Останавливаю после текущего вызова…'); break;
      case 'open-src': openSource(el.dataset.doc, el.dataset.item); break;
      case 'close-drawer': stopReview(); S.drawer = null; renderDrawer(); render(); break;
      case 'close-drawer-bg': if (e.target === el) { stopReview(); S.drawer = null; renderDrawer(); render(); } break;
      case 'focus-item': S.drawer.focusItem = el.dataset.id; renderDrawer(); { const c = $('#ic-' + el.dataset.id); c && c.scrollIntoView({ block: 'nearest' }); } break;
      case 'focus-seg': S.drawer.focusSeg = +el.dataset.seg; S.drawer.scrollTo = +el.dataset.seg; renderDrawer(); break;
      case 'label': {
        const it = ws.items.find((i) => i.id === el.dataset.id); if (!it) break;
        it.label = it.label === el.dataset.v ? null : el.dataset.v;
        if (S.review && it.label) S.review[it.label === 'ok' ? 'ok' : 'wrong']++;
        PR.refresh(ws); persist(); renderDrawer(); break;
      }
      case 'del-item': ws.items = ws.items.filter((i) => i.id !== el.dataset.id); PR.refresh(ws); persist(); renderDrawer(); break;
      case 'add-manual': {
        const doc = ws.docs.find((d) => d.id === S.drawer.docId);
        const it = { id: U.uid('i'), docId: doc.id, seg: +el.dataset.seg, quote: el.dataset.quote, summary: el.dataset.quote.slice(0, 200), type: 'pain', category: 'other', severity: 2, confidence: 1, source: 'manual', themeId: null, label: 'ok', blocker: false, speaker: (doc.segments[+el.dataset.seg] || {}).speaker || '' };
        it.quoteStatus = PR.verifyQuote(doc, it);
        ws.items.push(it); el.remove(); window.getSelection().removeAllRanges();
        if (S.review) S.review.added++;
        S.drawer.focusItem = it.id; persist(); renderDrawer(); toast('Добавлено. Тема появится при следующем прогоне.'); break;
      }
      case 'del-doc': ws.docs = ws.docs.filter((d) => d.id !== el.dataset.id); ws.items = ws.items.filter((i) => i.docId !== el.dataset.id); PR.refresh(ws); persist(); render(); break;
      case 'clear-demo': S.ws = PR.newWorkspace(); S.view = 'sources'; persist(); render(); break;
      case 'clear': if (!S.confirmClear) { S.confirmClear = true; render(); break; } S.confirmClear = false; S.ws = PR.newWorkspace(); persist(); render(); toast('Рабочее пространство очищено'); break;
      case 'export-md': saveFile('backlog.md', PR.exportMarkdown(ws), 'text/markdown;charset=utf-8'); break;
      case 'export-csv': saveFile('backlog.csv', PR.exportCSV(ws), 'text/csv;charset=utf-8'); break;
      case 'export-json': saveFile('pain-registry-workspace.json', JSON.stringify(ws, null, 1), 'application/json'); break;
      case 'export-labels': {
        const esc2 = (s) => '"' + String(s || '').replace(/"/g, '""') + '"';
        const rows = ['doc;org;seg;source;label;category;label_category;type;quote;summary'];
        ws.items.filter((i) => i.label || i.source === 'manual').forEach((i) => { const d = ws.docs.find((x) => x.id === i.docId) || {}; rows.push([esc2(d.name), esc2(d.org), i.seg, i.source, i.label || '', i.category, i.labelCategory || '', i.type, esc2(i.quote), esc2(i.summary)].join(';')); });
        saveFile('labels.csv', '\ufeff' + rows.join('\n'), 'text/csv;charset=utf-8'); break;
      }
      case 'copy-item': {
        const b = ws.backlog.find((x) => x.id === el.dataset.id);
        const lin = PR.lineage(ws, b);
        copy(`${b.title}\n\n${b.problem}\n\n${b.proposal}\n\nКритерии приёмки:\n${b.acceptance.map((a) => '- ' + a).join('\n')}\n\nДоказательства:\n${lin.flatMap((x) => x.items.slice(0, 3).map(({ item, doc }) => `- «${item.quote}» — ${doc.org || doc.orgGuess || doc.title}, ${U.fmtDate(doc.date)}`)).join('\n')}`, 'Пункт скопирован');
        break;
      }
      case 'import-folder': importFolder(); break;
      case 'tax-add': ws.settings.taxonomy.splice(ws.settings.taxonomy.length - 1, 0, { id: 'new' + ws.settings.taxonomy.length, name: 'Новая категория', desc: '', keywords: '' }); persist(); render(); break;
      case 'tax-del': ws.settings.taxonomy.splice(+el.dataset.i, 1); persist(); render(); break;
      case 'save-config': {
        const body = { base_url: $('#c-url').value.trim(), model: $('#c-model').value.trim(), stt_model: $('#c-stt').value.trim(), json_mode: $('#c-json').checked };
        if ($('#c-key').value) body.api_key = $('#c-key').value;
        const r = await fetch('api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json(); S.server = j.config; S.engine.label = j.config.model; S.engine.detail = j.config.base_url; toast('Настройки модели сохранены'); render(); break;
      }
      case 'test-llm': {
        toast('Проверяю связь…');
        try { const r = await fetch('api/llm/test', { method: 'POST' }); const j = await r.json(); toast(r.ok ? `Модель ответила за ${j.ms} мс: «${(j.text || '').trim().slice(0, 40)}»` : j.error); }
        catch (err) { toast('Сервер недоступен'); }
        break;
      }
      default: break;
    }
  });

  document.addEventListener('change', async (e) => {
    const el = e.target.closest('[data-change]');
    if (!el) return;
    const ws = S.ws, st = ws.settings, k = el.dataset.change;
    const doc = el.dataset.id && ws.docs.find((d) => d.id === el.dataset.id);
    switch (k) {
      case 'files': await addFiles([...el.files]); el.value = ''; return;
      case 'import': {
        try { S.ws = PR.migrate(JSON.parse(await el.files[0].text())); persist(); render(); toast('Импортировано'); } catch (err) { toast('Файл не похож на рабочее пространство'); }
        return;
      }
      case 'doc-date': doc.date = el.value; PR.refresh(ws); break;
      case 'doc-org': doc.org = el.value.trim(); PR.refresh(ws); break;
      case 'doc-seg': doc.segment = el.value; PR.refresh(ws); break;
      case 'doc-rev': doc.reviewed = el.checked; break;
      case 'doc-manual': doc.manualMin = Math.max(0, +el.value || 0) || null; break;
      case 'vendor': {
        const sp = el.dataset.sp;
        st.vendorSpeakers = el.checked ? [...new Set([...st.vendorSpeakers, sp])] : st.vendorSpeakers.filter((x) => x !== sp);
        ws.docs.forEach((d) => PR.normalizeDoc(d, st, ws.docs));
        ws.items.forEach((i) => { const d = ws.docs.find((x) => x.id === i.docId); i.vendorSpeech = !!(d && (d.segments[i.seg] || {}).role === 'vendor'); });
        PR.refresh(ws); break;
      }
      case 'bstatus': { const b = ws.backlog.find((x) => x.id === el.dataset.id); if (b) b.status = el.value; break; }
      case 'item-cat': { const it = ws.items.find((i) => i.id === el.dataset.id); if (it) { it.labelCategory = el.value; if (it.source === 'manual') it.category = el.value; } persist(); return; }
      case 'dr-base': S.drawer.showBase = el.checked; renderDrawer(); return;
      case 'dr-orig': S.drawer.orig = el.checked; renderDrawer(); return;
      case 'themecat': S.themeCat = el.value; break;
      case 'usemodel': st.useModel = el.checked; break;
      case 'tier': st.llm.tier = el.value; if (S.engine.kind === 'claude') { const sample = await window.claude.use('sample'); S.engine.llm = PR.makeClaudeLLM(sample, el.value); } break;
      case 'chunk': st.llm.chunkChars = Math.max(4000, +el.value || 24000); break;
      case 'conc': st.llm.concurrency = U.clamp(+el.value || 2, 1, 6); break;
      case 'pin': st.prices.inRubPer1M = +el.value || 0; break;
      case 'pout': st.prices.outRubPer1M = +el.value || 0; break;
      case 'product': st.product = el.value; break;
      case 'vendors': st.vendorSpeakers = el.value.split(',').map((x) => x.trim()).filter(Boolean); ws.docs.forEach((d) => PR.normalizeDoc(d, st, ws.docs)); break;
      case 'intorgs': st.internalOrgs = el.value.split(',').map((x) => x.trim()).filter(Boolean); break;
      case 'weight': st.weights[el.dataset.k] = +el.value || 0; PR.refresh(ws); break;
      case 'tax': st.taxonomy[+el.dataset.i][el.dataset.f] = el.value; persist(); return;
      case 'gloss': st.glossary = el.value.split('\n').map((l) => l.split('=>')).filter((p) => p.length === 2 && p[0].trim()).map(([f, t]) => ({ from: f.trim(), to: t.trim() })); ws.docs.forEach((d) => PR.normalizeDoc(d, st, ws.docs)); break;
      case 'folder': S.folderPath = el.value; return;
      default: return;
    }
    persist();
    if (!['doc-rev'].includes(k) || !S.drawer) render();
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'bq') { S.query = e.target.value; const pos = e.target.selectionStart; render(); const q = $('#bq'); if (q) { q.focus(); q.setSelectionRange(pos, pos); } }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.drawer) { stopReview(); S.drawer = null; renderDrawer(); render(); } });

  document.addEventListener('dragover', (e) => { const d = e.target.closest && e.target.closest('#drop'); if (d) { e.preventDefault(); d.classList.add('over'); } });
  document.addEventListener('dragleave', (e) => { const d = e.target.closest && e.target.closest('#drop'); if (d) d.classList.remove('over'); });
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const d = $('#drop'); if (d) d.classList.remove('over');
    addFiles([...e.dataTransfer.files]);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initEnvironment); else initEnvironment();
})();
