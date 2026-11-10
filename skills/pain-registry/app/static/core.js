/* Реестр болей — ядро конвейера.
 * Источник любого формата → сегменты → нормализация терминов и ролей → извлечение
 * атомарных единиц обратной связи (LLM) → сверка цитат → темы → бэклог со скорингом.
 * Каждая сущность хранит ссылки на предыдущую ступень, поэтому из любого пункта
 * бэклога можно спуститься до реплики в исходном файле.
 * Работает в браузере и в Node (для тестов). Без сборщика, без зависимостей,
 * кроме JSZip (docx/xlsx/pptx) и pdf.js (pdf), которые подгружаются по требованию.
 */
(function (global) {
  'use strict';
  const PR = (global.PR = global.PR || {});
  PR.VERSION = '0.3.0';

  /* ───────────────────────── утилиты ───────────────────────── */
  let seq = 0;
  const uid = (p) => p + '_' + Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"'`“”„()\[\]…]/g, ' ')
    .replace(/[.,;:!?–—-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const STOP = new Set(('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это угу вот ну да нет то есть вообще просто как бы типа короче значит например').split(' '));
  const tokens = (s) => norm(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w)).map((w) => (w.length > 6 ? w.slice(0, 6) : w));
  const fmtDate = (iso) => (iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4) : '—');
  const fmtTs = (s) => {
    if (s == null || s === '') return '';
    if (typeof s === 'string') return s;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  };
  const estTokens = (chars) => Math.ceil(chars / 3.2); // кириллица ≈ 3,2 символа на токен
  PR.util = { uid, sleep, clamp, norm, tokens, fmtDate, fmtTs, estTokens };

  /* TF-IDF и косинус — офлайн-эмбеддинги для бейзлайна, дедупликации и устойчивости тем */
  function tfidf(texts) {
    const docs = texts.map(tokens);
    const df = new Map();
    docs.forEach((d) => new Set(d).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
    const N = docs.length;
    return docs.map((d) => {
      const tf = new Map();
      d.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
      const v = new Map();
      let n2 = 0;
      tf.forEach((c, t) => { const w = (1 + Math.log(c)) * Math.log(1 + N / (df.get(t) || 1)); v.set(t, w); n2 += w * w; });
      const n = Math.sqrt(n2) || 1;
      v.forEach((w, t) => v.set(t, w / n));
      return v;
    });
  }
  function cosine(a, b) {
    let s = 0;
    const [x, y] = a.size < b.size ? [a, b] : [b, a];
    x.forEach((w, t) => { const z = y.get(t); if (z) s += w * z; });
    return s;
  }
  function overlap(a, b) {
    const A = new Set(tokens(a)), B = new Set(tokens(b));
    if (!A.size || !B.size) return 0;
    let c = 0; A.forEach((t) => B.has(t) && c++);
    return c / Math.min(A.size, B.size);
  }
  PR.util.tfidf = tfidf; PR.util.cosine = cosine; PR.util.overlap = overlap;

  /* ───────────────────────── настройки по умолчанию ───────────────────────── */
  PR.DEFAULT_TAXONOMY = [
    { id: 'quality', name: 'Качество и надёжность', desc: 'ошибки, сбои, неверные результаты, нестабильность', keywords: 'ошиб сбой баг падает неверн неправильн глюч не работает нестабил теряет' },
    { id: 'ux', name: 'Интерфейс и удобство', desc: 'навигация, тексты, перегруженность, непонятные экраны', keywords: 'интерфейс неудобн непонятн кнопк экран меню навигац много текста долго искать' },
    { id: 'features', name: 'Недостающие возможности', desc: 'функции, которых нет или не хватает', keywords: 'не хватает нет возможност хотелось бы нужна функц добавить умеет' },
    { id: 'performance', name: 'Скорость и производительность', desc: 'медленно, долгие загрузки, таймауты', keywords: 'медленн долго тормоз зависа таймаут скорост грузится' },
    { id: 'integrations', name: 'Интеграции и данные', desc: 'подключение систем, импорт и экспорт, API', keywords: 'интеграц подключ api импорт экспорт выгруз синхрониз коннектор данные' },
    { id: 'reporting', name: 'Отчётность и аналитика', desc: 'отчёты, метрики, дашборды', keywords: 'отчет метрик дашборд статистик аналитик выгрузк' },
    { id: 'deploy', name: 'Внедрение и настройка', desc: 'установка, онбординг, пилот, миграция', keywords: 'внедр установ настро онбординг пилот миграц развер обновл' },
    { id: 'security', name: 'Безопасность и требования', desc: 'доступы, регуляторы, хранение данных, облако или своя инфраструктура', keywords: 'безопасн доступ регулятор 152 персональн облак контур nda аудит' },
    { id: 'commercial', name: 'Цена и закупка', desc: 'бюджет, лицензия, модель оплаты', keywords: 'цена дорого бюджет стоимост лиценз оплат тариф закуп' },
    { id: 'support', name: 'Поддержка и обучение', desc: 'поддержка, документация, обучение пользователей', keywords: 'поддержк документац обучен инструкц ответ саппорт' },
    { id: 'other', name: 'Прочее', desc: 'не подходит ни под одну категорию', keywords: '' },
  ];

  PR.DEFAULT_GLOSSARY = [];

  PR.defaultSettings = () => ({
    product: 'B2B-продукт (опишите свой продукт в настройках: это контекст для модели)',
    taxonomy: JSON.parse(JSON.stringify(PR.DEFAULT_TAXONOMY)),
    glossary: JSON.parse(JSON.stringify(PR.DEFAULT_GLOSSARY)),
    vendorSpeakers: [],
    internalOrgs: [],
    llm: { tier: 'default', chunkChars: 24000, concurrency: 2, temperature: 0 },
    prices: { inRubPer1M: 0, outRubPer1M: 0 },
    weights: { orgExt: 10, orgInt: 3, blocker: 8, severity: 2, recency: 5 },
  });

  PR.newWorkspace = () => ({
    schema: 3, createdAt: new Date().toISOString(), settings: PR.defaultSettings(),
    docs: [], items: [], themes: [], backlog: [], runs: [], demo: false,
  });

  PR.migrate = (ws) => {
    if (!ws || typeof ws !== 'object') return PR.newWorkspace();
    const base = PR.newWorkspace();
    const out = Object.assign(base, ws);
    out.settings = Object.assign(PR.defaultSettings(), ws.settings || {});
    out.settings.llm = Object.assign(PR.defaultSettings().llm, (ws.settings || {}).llm || {});
    out.settings.weights = Object.assign(PR.defaultSettings().weights, (ws.settings || {}).weights || {});
    ['docs', 'items', 'themes', 'backlog', 'runs'].forEach((k) => (out[k] = Array.isArray(ws[k]) ? ws[k] : []));
    return out;
  };

  /* ───────────────────────── парсеры ───────────────────────── */
  const AUDIO = /\.(mp3|m4a|wav|ogg|oga|opus|webm|mp4|mov|aac|flac)$/i;
  const DATE_RX = /(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d{2})/;
  const MONTHS = { январ: 1, феврал: 2, март: 3, апрел: 4, ма: 5, июн: 6, июл: 7, август: 8, сентябр: 9, октябр: 10, ноябр: 11, декабр: 12 };

  function guessDate(...texts) {
    for (const t of texts) {
      if (!t) continue;
      const m = String(t).match(DATE_RX);
      if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      const w = String(t).toLowerCase().match(/(\d{1,2})\s+(январ|феврал|март|апрел|ма|июн|июл|август|сентябр|октябр|ноябр|декабр)\S*\s+(20\d{2})/);
      if (w) return `${w[3]}-${String(MONTHS[w[2]]).padStart(2, '0')}-${w[1].padStart(2, '0')}`;
      const iso = String(t).match(/(20\d{2})-(\d{2})-(\d{2})/);
      if (iso) return iso[0];
    }
    return '';
  }

  function guessOrg(title, speakers) {
    const t = String(title || '').trim();
    let m = t.match(/\[(?:cust\s*dev|касдев|кастдев)\s+([^\]]+)\]/i) || t.match(/\s(?:с|c|в|для)\s+((?:[А-ЯЁA-Z]{2,}\s)?[А-ЯЁA-Z][\wА-Яа-яЁё.\-]+(?:\s[А-ЯЁA-Z][\wА-Яа-яЁё.\-]+)?)\s*(?:[—–-]|\d|$|["»(])/);
    if (m) {
      const org = m[1].replace(/[.,]\s*Part.*$/i, '').trim();
      if (!/(SMB|\bLE\b|\bUI\b|\bAI\b|сегмент|заказчик)/i.test(org)) return org;
    }
    for (const s of speakers || []) { const p = String(s).match(/\(([^)]+)\)/); if (p) return p[1].trim(); }
    return '';
  }

  function splitParagraphs(text) {
    return String(text).replace(/\r/g, '').split(/\n\s*\n|\n(?=\s*(?:[-*•]|\d+[.)])\s)/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p.length > 1);
  }

  function segmentsFromText(text) {
    const lines = String(text).replace(/\r/g, '').split('\n');
    // Контур.Толк / Teams / Zoom: «00:01:23<TAB>Спикер<TAB>текст»
    const tab = lines.filter((l) => /^\d{1,2}:\d{2}(:\d{2})?\t[^\t]+\t/.test(l));
    if (tab.length >= 3) {
      return tab.map((l) => { const [ts, sp, ...rest] = l.split('\t'); return { ts, speaker: sp.trim(), text: rest.join(' ').trim() }; }).filter((s) => s.text);
    }
    // «[00:01:23] Спикер: текст» или «Спикер (00:01): текст»
    const rx = /^\s*(?:\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*)?([A-ZА-ЯЁ][\wА-Яа-яЁё .()\-]{1,40}?)(?:\s*\((\d{1,2}:\d{2}(?::\d{2})?)\))?\s*:\s+(.+)$/;
    const sp = lines.map((l) => l.match(rx)).filter(Boolean);
    if (sp.length >= 3 && sp.length >= lines.filter((l) => l.trim()).length * 0.5) {
      return sp.map((m) => ({ ts: m[1] || m[3] || '', speaker: m[2].trim(), text: m[4].trim() }));
    }
    return splitParagraphs(text).map((p) => ({ ts: '', speaker: '', text: p }));
  }

  function segmentsFromSubtitles(text) {
    const blocks = String(text).replace(/\r/g, '').split(/\n\s*\n/);
    const out = [];
    for (const b of blocks) {
      const lines = b.split('\n').filter((l) => l.trim() && !/^WEBVTT|^NOTE|^\d+$/.test(l.trim()));
      const tl = lines.findIndex((l) => /-->/.test(l));
      if (tl < 0) continue;
      const ts = lines[tl].split('-->')[0].trim().replace(/[.,]\d+$/, '');
      let body = lines.slice(tl + 1).join(' ');
      let speaker = '';
      const v = body.match(/<v\s+([^>]+)>/); if (v) speaker = v[1];
      body = body.replace(/<[^>]+>/g, '');
      const c = body.match(/^([A-ZА-ЯЁ][\wА-Яа-яЁё .\-]{1,30}):\s+(.+)/); if (c && !speaker) { speaker = c[1]; body = c[2]; }
      const prev = out[out.length - 1];
      if (prev && prev.speaker === speaker && prev.text.length < 400) prev.text += ' ' + body.trim();
      else out.push({ ts, speaker, text: body.trim() });
    }
    return out;
  }

  function parseCSV(text, delim) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (ch !== '\r') cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim()));
  }

  /* Таблица (CSV, XLSX, JSON-массив) → по сегменту на строку: тикеты, фича-реквесты, опросы */
  function segmentsFromTable(rows) {
    if (!rows.length) return { segments: [], meta: {} };
    const header = rows[0].map((h) => String(h || '').trim());
    const body = rows.slice(1);
    const pick = (rx) => header.findIndex((h) => rx.test(h));
    const avgLen = header.map((_, i) => body.reduce((s, r) => s + String(r[i] || '').length, 0) / (body.length || 1));
    let textCol = pick(/^(текст|описани|description|text|comment|комментар|отзыв|body|feedback|суть|запрос|summary|тема|subject)/i);
    if (textCol < 0 || avgLen[textCol] < 15) textCol = avgLen.indexOf(Math.max(...avgLen));
    const orgCol = pick(/(клиент|компани|организац|заказчик|customer|account|company|org)/i);
    const authorCol = pick(/(автор|author|от кого|reporter|user|пользоват|контакт)/i);
    const dateCol = pick(/(дата|date|created|создан)/i);
    const titleCol = pick(/^(заголов|title|subject|тема|summary)/i);
    const segs = body.map((r, i) => {
      const extra = header.map((h, j) => (j !== textCol && r[j] && String(r[j]).length < 120 ? `${h}: ${r[j]}` : '')).filter(Boolean).join(' · ');
      return {
        ts: dateCol >= 0 ? String(r[dateCol] || '') : '#' + (i + 1),
        speaker: authorCol >= 0 ? String(r[authorCol] || '') : '',
        org: orgCol >= 0 ? String(r[orgCol] || '').trim() : '',
        text: [titleCol >= 0 && titleCol !== textCol ? String(r[titleCol] || '') + '.' : '', String(r[textCol] || '')].join(' ').trim(),
        meta: extra,
      };
    }).filter((s) => s.text.length > 2);
    return { segments: segs, meta: { tabular: true, columns: header, textColumn: header[textCol] } };
  }

  async function loadJSZip() {
    if (global.JSZip) return global.JSZip;
    if (PR.env && PR.env.jszipUrl && global.document) {
      await new Promise((res, rej) => { const s = document.createElement('script'); s.src = PR.env.jszipUrl; s.onload = res; s.onerror = () => rej(new Error('Не удалось загрузить JSZip')); document.head.appendChild(s); });
      return global.JSZip;
    }
    throw new Error('Для этого формата нужен JSZip');
  }

  // pdf.js 5 опирается на Map.prototype.getOrInsertComputed — в старых браузерах его нет
  [global.Map, global.WeakMap].forEach((C) => {
    if (!C || C.prototype.getOrInsertComputed) return;
    C.prototype.getOrInsertComputed = function (k, f) { if (!this.has(k)) this.set(k, f(k)); return this.get(k); };
    C.prototype.getOrInsert = function (k, v) { if (!this.has(k)) this.set(k, v); return this.get(k); };
  });
  async function loadPdf() {
    if (global.pdfjsLib) return global.pdfjsLib;
    if (PR.env && PR.env.pdfModuleUrl) {
      // Обработчик pdf.js грузим в основной поток: так полифилл выше действует и на него
      if (!global.pdfjsWorker) await import(PR.env.pdfWorkerUrl);
      const mod = await import(PR.env.pdfModuleUrl);
      mod.GlobalWorkerOptions.workerSrc = PR.env.pdfWorkerUrl;
      return mod;
    }
    throw new Error('Для PDF нужен pdf.js');
  }

  const xmlText = (xml) => xml.replace(/<w:tab\/>/g, ' ').replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

  async function parseDocx(buf) {
    const zip = await (await loadJSZip()).loadAsync(buf);
    const xml = await zip.file('word/document.xml').async('string');
    const paras = xml.split(/<\/w:p>/).map((p) => xmlText(p).replace(/\s+/g, ' ').trim()).filter(Boolean);
    return paras.join('\n\n');
  }

  async function parsePptx(buf) {
    const zip = await (await loadJSZip()).loadAsync(buf);
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
    const out = [];
    for (const f of slides) {
      const xml = await zip.file(f).async('string');
      const t = (xml.match(/<a:t>([^<]*)<\/a:t>/g) || []).map((m) => xmlText(m)).join(' ').trim();
      if (t) out.push({ ts: 'слайд ' + f.match(/\d+/)[0], speaker: '', text: t });
    }
    return out;
  }

  async function parseXlsx(buf) {
    const zip = await (await loadJSZip()).loadAsync(buf);
    const ss = zip.file('xl/sharedStrings.xml') ? await zip.file('xl/sharedStrings.xml').async('string') : '';
    const shared = ss.split(/<\/si>/).slice(0, -1).map((si) => xmlText(si.replace(/<rPh[\s\S]*?<\/rPh>/g, '')));
    const sheetFile = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort()[0];
    const xml = await zip.file(sheetFile).async('string');
    const rows = [];
    for (const r of xml.match(/<row[\s\S]*?<\/row>/g) || []) {
      const row = [];
      for (const c of r.match(/<c [\s\S]*?(?:\/>|<\/c>)/g) || []) {
        const ref = (c.match(/r="([A-Z]+)\d+"/) || [])[1] || 'A';
        const col = ref.split('').reduce((s, ch) => s * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        const is = (c.match(/<is>([\s\S]*?)<\/is>/) || [])[1];
        let val = '';
        if (/t="s"/.test(c) && v != null) val = shared[+v] || '';
        else if (is) val = xmlText(is);
        else if (v != null) val = xmlText(v);
        row[col] = val;
      }
      rows.push(Array.from(row, (x) => x || ''));
    }
    return rows;
  }

  async function parsePdf(buf) {
    const pdfjs = await loadPdf();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
    const segs = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let text = '', lastY = null;
      for (const it of tc.items) {
        const y = it.transform ? it.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 14) text += '\n\n';
        else if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) text += '\n';
        text += it.str + (it.hasEOL ? '\n' : '');
        lastY = y;
      }
      segmentsFromText(text).forEach((s) => segs.push(Object.assign(s, { ts: s.ts || 'стр. ' + p })));
    }
    return segs;
  }

  function parseHtml(text) {
    if (global.DOMParser) {
      const d = new DOMParser().parseFromString(text, 'text/html');
      d.querySelectorAll('script,style,noscript,svg').forEach((n) => n.remove());
      const blocks = [...d.body.querySelectorAll('p,li,h1,h2,h3,h4,td,blockquote,pre')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()).filter((t) => t.length > 1);
      return { title: (d.querySelector('title') || {}).textContent || '', text: blocks.join('\n\n') };
    }
    return { title: '', text: text.replace(/<[^>]+>/g, '\n') };
  }

  function parseEml(text) {
    const [head, ...rest] = String(text).replace(/\r/g, '').split('\n\n');
    const h = (k) => ((head.match(new RegExp('^' + k + ':\\s*(.+)$', 'mi')) || [])[1] || '').trim();
    let body = rest.join('\n\n');
    if (/content-transfer-encoding:\s*base64/i.test(head)) { try { body = decodeURIComponent(escape(atob(body.replace(/\s/g, '')))); } catch (e) { /* оставляем как есть */ } }
    body = body.replace(/<[^>]+>/g, ' ');
    return { title: h('Subject'), date: h('Date'), from: h('From'), text: body };
  }

  /* file: {name, size, lastModified, arrayBuffer(), text()} (File из браузера или обёртка) */
  PR.parseFile = async function parseFile(file, opts = {}) {
    const name = file.name || 'источник';
    const ext = (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
    const doc = {
      id: uid('d'), name, ext, size: file.size || 0, addedAt: new Date().toISOString(),
      title: name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' '), kind: 'документ',
      org: '', segment: '', date: '', segments: [], meta: {}, status: 'parsed', reviewed: false,
    };
    let text = '', segs = null, title = '';
    if (AUDIO.test(name)) {
      if (!opts.transcribe) throw new Error('Аудио и видео распознаются только в локальной версии с моделью распознавания речи');
      const r = await opts.transcribe(file);
      segs = (r.segments && r.segments.length ? r.segments : splitParagraphs(r.text).map((t) => ({ text: t }))).map((s) => ({ ts: fmtTs(s.ts), speaker: s.speaker || '', text: s.text }));
      doc.kind = 'аудио';
    } else if (ext === 'docx') { text = await parseDocx(await file.arrayBuffer()); doc.kind = 'документ Word'; }
    else if (ext === 'pptx') { segs = await parsePptx(await file.arrayBuffer()); doc.kind = 'презентация'; }
    else if (ext === 'xlsx' || ext === 'xlsm') { const t = segmentsFromTable(await parseXlsx(await file.arrayBuffer())); segs = t.segments; doc.meta = t.meta; doc.kind = 'таблица'; }
    else if (ext === 'pdf') { segs = await parsePdf(await file.arrayBuffer()); doc.kind = 'PDF'; }
    else {
      text = await file.text();
      if (ext === 'csv' || ext === 'tsv') {
        const delim = ext === 'tsv' ? '\t' : (text.split('\n')[0].split(';').length > text.split('\n')[0].split(',').length ? ';' : ',');
        const t = segmentsFromTable(parseCSV(text, delim)); segs = t.segments; doc.meta = t.meta; doc.kind = 'таблица';
      } else if (ext === 'json') {
        let data = null; try { data = JSON.parse(text); } catch (e) { /* ниже — как текст */ }
        const arr = Array.isArray(data) ? data : data && (data.items || data.messages || data.tickets || data.data);
        if (Array.isArray(arr) && arr.length && typeof arr[0] === 'object') {
          const keys = [...new Set(arr.flatMap((o) => Object.keys(o)))];
          const t = segmentsFromTable([keys, ...arr.map((o) => keys.map((k) => (typeof o[k] === 'object' ? JSON.stringify(o[k]) : o[k] ?? '')))]);
          segs = t.segments; doc.meta = t.meta; doc.kind = 'таблица';
        }
      } else if (ext === 'vtt' || ext === 'srt') { segs = segmentsFromSubtitles(text); doc.kind = 'субтитры'; }
      else if (ext === 'html' || ext === 'htm') { const h = parseHtml(text); title = h.title; text = h.text; doc.kind = 'веб-страница'; }
      else if (ext === 'eml') { const e = parseEml(text); title = e.title; text = e.text.split('\n').map((l) => l.trim()).filter(Boolean).join('\n\n'); doc.meta.from = e.from; doc.date = guessDate(e.date); doc.kind = 'письмо'; if (!doc.org) doc.org = (e.from.match(/@([\w-]+)\./) || [])[1] || ''; }
      else if (ext === 'md' || ext === 'markdown') { doc.kind = 'конспект'; }
    }
    if (!segs) {
      const first = String(text).split('\n').find((l) => l.trim()) || '';
      const m = first.match(/^Транскрипция записи\s+["«](.+?)["»]\s*(.*)$/);
      if (m) { title = m[1]; doc.date = guessDate(m[2]) || doc.date; text = text.slice(text.indexOf(first) + first.length); doc.kind = 'расшифровка'; }
      const h1 = String(text).match(/^#\s+(.+)$/m);
      if (!title && h1) title = h1[1];
      segs = segmentsFromText(text);
      if (segs.some((s) => s.speaker) && doc.kind === 'документ') doc.kind = 'расшифровка';
    }
    doc.title = (title || doc.title).trim();
    doc.segments = segs.map((s, i) => ({ i, ts: s.ts || '', speaker: (s.speaker || '').trim(), text: s.text, org: s.org || '', meta: s.meta || '', role: '', norm: '' }));
    doc.date = doc.date || guessDate(doc.title, name, (doc.segments[0] || {}).text, (doc.segments[0] || {}).ts) || (file.lastModified ? new Date(file.lastModified).toISOString().slice(0, 10) : '');
    const speakers = [...new Set(doc.segments.map((s) => s.speaker).filter(Boolean))];
    doc.org = doc.org || guessOrg(doc.title, speakers) || guessOrg(name.replace(/[_]+/g, ' ').replace(/\.[^.]+$/, ''), speakers);
    doc.chars = doc.segments.reduce((s, x) => s + x.text.length, 0);
    if (!doc.segments.length) throw new Error('В файле не найден текст');
    return doc;
  };

  /* ───────────────────────── нормализация ───────────────────────── */
  PR.compileGlossary = (glossary) => (glossary || []).map((g) => { try { return { rx: new RegExp(g.from, 'g'), to: g.to, from: g.from }; } catch (e) { return null; } }).filter(Boolean);

  PR.normalizeDoc = function normalizeDoc(doc, settings, allDocs) {
    const gl = PR.compileGlossary(settings.glossary);
    const vendors = new Set((settings.vendorSpeakers || []).map((v) => v.toLowerCase().trim()).filter(Boolean));
    let fixes = 0;
    for (const s of doc.segments) {
      let t = s.text;
      for (const g of gl) { t = t.replace(g.rx, (m) => { fixes++; return g.to; }); }
      s.norm = t !== s.text ? t : '';
      const sp = s.speaker.toLowerCase();
      if (!s.speaker) s.role = doc.meta && doc.meta.tabular ? 'client' : 'unknown';
      else if (vendors.has(sp) || [...vendors].some((v) => v && sp.includes(v))) s.role = 'vendor';
      else s.role = 'client';
    }
    doc.termFixes = fixes;
    if (!doc.org) {
      const cnt = new Map();
      doc.segments.filter((s) => s.role === 'client' && s.speaker && !/^участник/i.test(s.speaker)).forEach((s) => cnt.set(s.speaker, (cnt.get(s.speaker) || 0) + s.text.length));
      const top = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
      doc.orgGuess = top ? top[0] : '';
    }
    if ((settings.internalOrgs || []).some((o) => o && doc.org && doc.org.toLowerCase().includes(o.toLowerCase()))) doc.segment = doc.segment || 'внутренний';
    return doc;
  };

  /* Спикеры, встречающиеся в большинстве источников, почти всегда — наша команда */
  PR.suggestVendors = function suggestVendors(docs) {
    const cnt = new Map();
    const withSpeakers = docs.filter((d) => d.segments.some((s) => s.speaker));
    withSpeakers.forEach((d) => new Set(d.segments.map((s) => s.speaker).filter(Boolean)).forEach((sp) => cnt.set(sp, (cnt.get(sp) || 0) + 1)));
    const n = withSpeakers.length;
    return [...cnt.entries()].filter(([, c]) => n >= 3 && c / n >= 0.4).sort((a, b) => b[1] - a[1]).map(([s, c]) => ({ speaker: s, docs: c }));
  };

  /* ───────────────────────── LLM-адаптеры ───────────────────────── */
  function parseJSONLoose(text) {
    const t = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    try { return JSON.parse(t); } catch (e) { /* дальше */ }
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) { try { return JSON.parse(fence[1]); } catch (e) { /* дальше */ } }
    const a = Math.min(...['{', '['].map((c) => (t.indexOf(c) < 0 ? Infinity : t.indexOf(c))));
    const b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (a < Infinity && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* нет */ } }
    throw Object.assign(new Error('Модель вернула не JSON'), { raw: t.slice(0, 500) });
  }
  PR.parseJSONLoose = parseJSONLoose;

  /* Локальная версия: OpenAI-совместимый endpoint через server.py */
  PR.makeServerLLM = () => ({
    kind: 'server', label: 'OpenAI-совместимая модель',
    async json(prompt, opts = {}) {
      const r = await fetch('api/llm/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'system', content: 'Ты аккуратный аналитик. Отвечай только валидным JSON без пояснений.' }, { role: 'user', content: prompt }], json: true, temperature: opts.temperature ?? 0, max_tokens: opts.maxTokens }),
        signal: opts.signal,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Ошибка LLM');
      return { data: parseJSONLoose(data.text), usage: data.usage, ms: data.ms, model: data.model };
    },
  });

  /* Артефакт на claude.ai: Claude через capability sample (платит смотрящий) */
  PR.makeClaudeLLM = (sample, tier) => ({
    kind: 'claude', label: 'Claude (через claude.ai)',
    async json(prompt, opts = {}) {
      const t0 = Date.now();
      const data = await sample.json(prompt, { modelTier: opts.tier || tier || 'default', signal: opts.signal, onText: opts.onText });
      const outChars = JSON.stringify(data).length;
      return { data, usage: { in: estTokens(prompt.length), out: estTokens(outChars), estimated: true }, ms: Date.now() - t0, model: 'claude:' + (opts.tier || tier || 'default') };
    },
  });

  /* ───────────────────────── промпты ───────────────────────── */
  const TYPES = ['pain', 'request', 'blocker', 'praise', 'question'];
  PR.TYPE_LABEL = { pain: 'Боль', request: 'Запрос', blocker: 'Блокер сделки', praise: 'Похвала', question: 'Вопрос' };

  function taxonomyText(tax) { return tax.map((c) => `- ${c.id}: ${c.name} — ${c.desc}`).join('\n'); }

  PR.extractionPrompt = function (doc, segs, settings, isFirst) {
    const roleRu = { client: 'клиент', vendor: 'вендор', unknown: '?' };
    const lines = segs.map((s) => `[${s.i}] (${roleRu[s.role] || '?'}) ${s.speaker || '—'}${s.ts ? ' ' + s.ts : ''}: ${s.norm || s.text}`).join('\n');
    const gl = (settings.glossary || []).map((g) => g.to).filter((v, i, a) => a.indexOf(v) === i).join(', ');
    return `Ты продуктовый аналитик B2B-продукта: ${settings.product}.
Источник: «${doc.title}» (${doc.kind}${doc.date ? ', ' + fmtDate(doc.date) : ''}${doc.org ? ', организация: ' + doc.org : ''}).
Реплики пронумерованы [n]. Роль «вендор» — сотрудники нашей компании: их слова не являются обратной связью клиента, кроме случаев, когда они дословно пересказывают слова клиента. Расшифровка автоматическая и искажает термины; правильные написания: ${gl}.

Задача: извлеки ВСЕ атомарные единицы обратной связи клиента — боли, запросы, блокеры сделки, похвалу, вопросы о продукте. Одна единица — одна мысль. Не извлекай приветствия, организационные моменты, вежливый интерес без содержания («интересно посмотреть»), питч вендора.

Для каждой единицы:
- seg — номер реплики [n], где она сказана;
- quote — ТОЧНАЯ непрерывная подстрока этой реплики, 4–40 слов, без исправлений и пересказа;
- summary — одна фраза на русском: суть боли или запроса, с правильными терминами, без воды;
- type — одно из: ${TYPES.join(', ')} (blocker — мешает пилоту или покупке);
- category — id из таксономии:
${taxonomyText(settings.taxonomy)}
- severity — 1 (неудобство), 2 (мешает работе), 3 (критично или блокирует);
- confidence — 0..1, насколько уверен, что это обратная связь клиента.
${isFirst ? '\nТакже определи метаданные источника: org — организация клиента (как называют в тексте), segment — LE, SMB или внутренний, если понятно; иначе пустая строка.\n' : ''}
Ответь только JSON вида:
{${isFirst ? '"doc":{"org":"","segment":""},' : ''}"items":[{"seg":12,"quote":"...","summary":"...","type":"pain","category":"ux","severity":2,"confidence":0.9}]}
Если обратной связи нет — {"items":[]}.

Реплики:
${lines}`;
  };

  PR.themePrompt = function (items, existing, settings, catName) {
    const ex = existing.length ? existing.map((t) => `${t.id} | ${t.title} — ${t.statement}`).join('\n') : '(пока нет)';
    const list = items.map((it) => `${it.id} | ${it.summary}`).join('\n');
    return `Ты продуктовый аналитик B2B-продукта: ${settings.product}.
Категория: «${catName}». Ниже единицы обратной связи от разных клиентов. Сгруппируй их в темы: одна тема — одна проблема, которую можно решить одной доработкой. Не объединяй разные проблемы ради краткости; не дроби одну проблему на синонимы.

Существующие темы (используй их, если единица подходит, — таксономия должна быть стабильной между прогонами):
${ex}

Единицы (id | суть):
${list}

Ответь только JSON:
{"assign":[{"item":"<id единицы>","theme":"<id существующей темы или new:ключ>"}],
 "newThemes":[{"key":"ключ","title":"короткое название проблемы, до 7 слов","statement":"одно предложение: у кого и что болит, к чему приводит"}]}
Каждая единица должна получить ровно одну тему.`;
  };

  PR.backlogPrompt = function (themes, settings) {
    const lines = themes.map((t) => `${t.id} | ${t.title} | клиентов: ${t.stats.orgs} (${t.stats.orgNames.slice(0, 5).join(', ')}) | блокеров: ${t.stats.blockers} | ${t.statement}\n   цитаты: ${t.stats.samples.map((q) => '«' + q + '»').join(' / ')}`).join('\n');
    return `Ты продакт-менеджер B2B-продукта: ${settings.product}.
Ниже темы обратной связи клиентов с доказательствами. Преврати их в пункты продуктового бэклога. Один пункт может закрывать несколько тем, если это одна доработка; каждая тема должна попасть хотя бы в один пункт. Не придумывай фактов, которых нет в темах.

Темы (id | название | клиенты | блокеры | формулировка | цитаты):
${lines}

Для каждого пункта:
- title — название задачи в повелительном наклонении, до 10 слов;
- kind — epic, feature, bug или research (research — если проблема понятна, а решение нет);
- problem — 1–2 предложения: что болит и у кого, со ссылкой на масштаб;
- proposal — 1–2 предложения: что сделать;
- acceptance — 2–4 проверяемых критерия приёмки;
- themes — список id тем.

Ответь только JSON: {"backlog":[{"title":"","kind":"feature","problem":"","proposal":"","acceptance":[""],"themes":["T..."]}]}`;
  };

  /* ───────────────────────── ступени конвейера ───────────────────────── */
  function chunkSegments(segs, maxChars) {
    const chunks = []; let cur = [], len = 0;
    for (const s of segs) {
      const l = (s.norm || s.text).length + 40;
      if (cur.length && len + l > maxChars) { chunks.push(cur); cur = []; len = 0; }
      cur.push(s); len += l;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  /* Сверка цитаты с исходником: verified — дословно, approx — по словам, missing — не найдена */
  PR.verifyQuote = function verifyQuote(doc, item) {
    const q = norm(item.quote);
    if (!q) return 'missing';
    const seg = doc.segments[item.seg];
    const hay = seg ? [norm(seg.text), norm(seg.norm)] : [];
    if (hay.some((h) => h && h.includes(q))) return 'verified';
    for (const s of doc.segments) if (norm(s.text).includes(q) || (s.norm && norm(s.norm).includes(q))) { item.seg = s.i; return 'verified'; }
    if (seg && overlap(item.quote, seg.norm || seg.text) >= 0.8) return 'approx';
    let best = -1, bi = -1;
    doc.segments.forEach((s) => { const o = overlap(item.quote, s.norm || s.text); if (o > best) { best = o; bi = s.i; } });
    if (best >= 0.85) { item.seg = bi; return 'approx'; }
    return 'missing';
  };

  function cleanItem(raw, doc, settings, source) {
    const cats = new Set(settings.taxonomy.map((c) => c.id));
    const seg = parseInt(raw.seg, 10);
    const it = {
      id: uid('i'), docId: doc.id, seg: Number.isFinite(seg) && doc.segments[seg] ? seg : 0,
      quote: String(raw.quote || '').trim().slice(0, 600), summary: String(raw.summary || '').trim().slice(0, 300),
      type: TYPES.includes(raw.type) ? raw.type : 'pain', category: cats.has(raw.category) ? raw.category : 'other',
      severity: clamp(parseInt(raw.severity, 10) || 2, 1, 3), confidence: clamp(Number(raw.confidence) || 0.7, 0, 1),
      source, themeId: null, label: null, createdAt: new Date().toISOString(),
    };
    it.blocker = it.type === 'blocker';
    it.speaker = (doc.segments[it.seg] || {}).speaker || '';
    it.quoteStatus = PR.verifyQuote(doc, it);
    it.speaker = (doc.segments[it.seg] || {}).speaker || '';
    if ((doc.segments[it.seg] || {}).role === 'vendor') it.vendorSpeech = true;
    return it;
  }

  /* Бейзлайн: маркеры боли + ключевые слова таксономии. Без модели. */
  const PAIN_MARKERS = /(не хватает|нехватк|хотелось бы|хочется|хотим|нужн[оаы]?|надо бы|проблем|непонятн|неудобн|не работает|не видно|не могу|не можем|долго|медленн|много текста|слишком|ошибк|бесит|мешает|не доверя|дорого|нельзя|не дадим|не готов|жалко|плохо|сложно|тяжело|потеря|теряем|пропуска|ложн|галлюцин|не устраива|не подходит|нет возможност|отсутству|было бы здорово|было бы круто|не хват)/i;
  const PRAISE_MARKERS = /(нравится|удобно|понравил|круто|отлично|хорошо сделан|полезн|экономит)/i;
  PR.baselineExtract = function baselineExtract(doc, settings) {
    const out = [];
    const kws = settings.taxonomy.map((c) => ({ id: c.id, k: (c.keywords || '').split(/\s+/).filter(Boolean).map((w) => w.toLowerCase()) }));
    for (const s of doc.segments) {
      if (s.role === 'vendor') continue;
      const sentences = (s.norm || s.text).split(/(?<=[.!?])\s+/);
      for (const sent of sentences) {
        const isPain = PAIN_MARKERS.test(sent), isPraise = PRAISE_MARKERS.test(sent);
        if ((!isPain && !isPraise) || sent.split(/\s+/).length < 4) continue;
        const low = norm(sent);
        let best = 'other', bestN = 0;
        kws.forEach((c) => { const n = c.k.filter((k) => low.includes(norm(k))).length; if (n > bestN) { bestN = n; best = c.id; } });
        const quote = sent.length > 300 ? sent.slice(0, 300) : sent;
        const it = cleanItem({ seg: s.i, quote, summary: quote, type: isPain ? (/не дадим|не готов|блок/i.test(sent) ? 'blocker' : 'pain') : 'praise', category: best, severity: 2, confidence: 0.5 }, doc, settings, 'baseline');
        out.push(it);
      }
    }
    return out;
  };

  async function pool(list, n, fn) {
    const res = new Array(list.length); let i = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(n, list.length)) }, async () => { while (i < list.length) { const k = i++; res[k] = await fn(list[k], k); } });
    await Promise.all(workers);
    return res;
  }

  function newRun(ws, llm) {
    const run = { id: uid('r'), startedAt: new Date().toISOString(), engine: llm ? llm.label : 'Без модели (эвристика)', model: '', stages: [], ok: false };
    ws.runs.unshift(run); ws.runs = ws.runs.slice(0, 30);
    return run;
  }
  function stage(run, name) {
    const st = { name, startedAt: Date.now(), ms: 0, calls: 0, tokIn: 0, tokOut: 0, estimated: false, count: 0, errors: 0, note: '' };
    run.stages.push(st);
    return st;
  }
  const done = (st) => { st.ms = Date.now() - st.startedAt; delete st.startedAt; };
  const account = (st, r) => { st.calls++; st.tokIn += (r.usage && r.usage.in) || 0; st.tokOut += (r.usage && r.usage.out) || 0; if (r.usage && r.usage.estimated) st.estimated = true; };

  /* Извлечение по одному источнику */
  PR.extractDoc = async function extractDoc(ws, doc, llm, st, hooks = {}) {
    const settings = ws.settings;
    ws.items = ws.items.filter((it) => !(it.docId === doc.id && (it.source === 'llm' || it.source === 'baseline') && !it.label));
    const baseline = PR.baselineExtract(doc, settings);
    ws.items.push(...baseline);
    if (!llm) {
      const heur = baseline.map((b) => Object.assign({}, b, { id: uid('i'), source: 'heuristic' }));
      ws.items.push(...heur);
      doc.status = 'extracted';
      return heur.length;
    }
    const chunks = chunkSegments(doc.segments, settings.llm.chunkChars || 24000);
    let n = 0;
    for (let c = 0; c < chunks.length; c++) {
      if (hooks.signal && hooks.signal.aborted) throw new Error('Остановлено');
      const prompt = PR.extractionPrompt(doc, chunks[c], settings, c === 0);
      hooks.log && hooks.log(`«${doc.title}»: часть ${c + 1} из ${chunks.length}, ${chunks[c].length} реплик`);
      let r;
      try { r = await llm.json(prompt, { signal: hooks.signal }); }
      catch (e) { st.errors++; hooks.log && hooks.log(`Ошибка на «${doc.title}»: ${e.message || e.code}`, 'error'); if (e.code === 'not_granted' || e.code === 'cancelled') throw e; continue; }
      account(st, r);
      const data = r.data || {};
      if (c === 0 && data.doc) {
        if (!doc.org && data.doc.org) doc.org = String(data.doc.org).slice(0, 60);
        if (!doc.segment && data.doc.segment) doc.segment = String(data.doc.segment).slice(0, 20);
      }
      const seen = new Set(ws.items.filter((it) => it.docId === doc.id && it.source === 'llm').map((it) => norm(it.quote)));
      for (const raw of Array.isArray(data.items) ? data.items : []) {
        const it = cleanItem(raw, doc, settings, 'llm');
        if (!it.quote || seen.has(norm(it.quote))) continue;
        seen.add(norm(it.quote));
        ws.items.push(it); n++;
      }
    }
    doc.status = 'extracted';
    doc.extractedAt = new Date().toISOString();
    return n;
  };

  /* Какие единицы участвуют в темах и бэклоге */
  PR.liveItems = (ws) => {
    const hasLLM = ws.items.some((i) => i.source === 'llm');
    return ws.items.filter((it) => (it.source === 'manual' || it.source === (hasLLM ? 'llm' : 'heuristic')) && it.label !== 'wrong' && it.quoteStatus !== 'missing' && !it.vendorSpeech && it.type !== 'praise' && it.type !== 'question');
  };

  /* Офлайн-кластеризация: жадно по косинусу TF-IDF внутри категории */
  function offlineThemes(ws, items, catId, existing) {
    const vecs = tfidf(items.map((i) => i.summary + ' ' + i.quote));
    const exVecs = existing.length ? tfidf(existing.map((t) => t.title + ' ' + t.statement)) : [];
    const groups = [];
    items.forEach((it, k) => {
      let best = -1, bg = null;
      existing.forEach((t, j) => { const c = cosine(vecs[k], exVecs[j]); if (c > best) { best = c; bg = { theme: t }; } });
      groups.forEach((g) => { const c = Math.max(...g.idx.map((x) => cosine(vecs[k], vecs[x]))); if (c > best) { best = c; bg = g; } });
      if (bg && best >= 0.22) { if (bg.theme) it.themeId = bg.theme.id; else bg.idx.push(k); }
      else groups.push({ idx: [k] });
    });
    const cat = ws.settings.taxonomy.find((c) => c.id === catId) || { name: 'Прочее' };
    return groups.map((g) => {
      const its = g.idx.map((x) => items[x]);
      const head = its.slice().sort((a, b) => b.severity - a.severity || a.summary.length - b.summary.length)[0];
      const t = { id: uid('T'), title: head.summary.replace(/[.!?]$/, '').slice(0, 80), statement: `${cat.name}: ${head.summary}`, category: catId, createdBy: 'heuristic', createdAt: new Date().toISOString() };
      its.forEach((i) => (i.themeId = t.id));
      return t;
    });
  }

  PR.themeStats = function themeStats(ws, theme) {
    const items = PR.liveItems(ws).filter((i) => i.themeId === theme.id);
    const docs = new Map(ws.docs.map((d) => [d.id, d]));
    const orgOf = (i) => { const d = docs.get(i.docId) || {}; const seg = (d.segments || [])[i.seg] || {}; return (seg.org || d.org || d.orgGuess || d.title || '—').trim(); };
    const isInt = (i) => /внутр/i.test((docs.get(i.docId) || {}).segment || '');
    const ext = new Set(items.filter((i) => !isInt(i)).map(orgOf));
    const int = new Set(items.filter(isInt).map(orgOf));
    const dates = items.map((i) => (docs.get(i.docId) || {}).date).filter(Boolean).sort();
    return {
      items: items.length, orgs: ext.size, orgsInt: int.size, orgNames: [...ext], orgNamesInt: [...int],
      blockers: new Set(items.filter((i) => i.blocker).map(orgOf)).size,
      severity: items.length ? items.reduce((s, i) => s + i.severity, 0) / items.length : 0,
      first: dates[0] || '', last: dates[dates.length - 1] || '',
      segments: [...new Set(items.map((i) => (docs.get(i.docId) || {}).segment).filter(Boolean))],
      samples: items.slice().sort((a, b) => b.severity - a.severity).slice(0, 3).map((i) => i.quote.slice(0, 160)),
      docs: new Set(items.map((i) => i.docId)).size,
    };
  };

  PR.buildThemes = async function buildThemes(ws, llm, st, hooks = {}, rebuild = false) {
    const items = PR.liveItems(ws);
    if (rebuild) { items.forEach((i) => (i.themeId = null)); ws.themes = []; }
    const known = new Set(ws.themes.map((t) => t.id));
    items.forEach((i) => { if (i.themeId && !known.has(i.themeId)) i.themeId = null; });
    const pending = items.filter((i) => !i.themeId);
    const byCat = new Map();
    pending.forEach((i) => { if (!byCat.has(i.category)) byCat.set(i.category, []); byCat.get(i.category).push(i); });
    for (const [cat, list] of byCat) {
      const catName = (ws.settings.taxonomy.find((c) => c.id === cat) || { name: cat }).name;
      const existing = ws.themes.filter((t) => t.category === cat);
      if (!llm || list.length < 2 && !existing.length) {
        ws.themes.push(...offlineThemes(ws, list, cat, existing));
        continue;
      }
      for (let k = 0; k < list.length; k += 120) {
        const batch = list.slice(k, k + 120);
        hooks.log && hooks.log(`Темы: «${catName}», ${batch.length} единиц`);
        let r;
        try { r = await llm.json(PR.themePrompt(batch, ws.themes.filter((t) => t.category === cat), ws.settings, catName), { signal: hooks.signal }); }
        catch (e) { st.errors++; hooks.log && hooks.log('Темы не собраны моделью, беру эвристику: ' + (e.message || e.code), 'error'); ws.themes.push(...offlineThemes(ws, batch, cat, existing)); continue; }
        account(st, r);
        const data = r.data || {};
        const keyMap = new Map();
        (data.newThemes || []).forEach((nt) => {
          const t = { id: uid('T'), title: String(nt.title || '').slice(0, 90), statement: String(nt.statement || '').slice(0, 300), category: cat, createdBy: 'llm', createdAt: new Date().toISOString() };
          if (t.title) { ws.themes.push(t); keyMap.set('new:' + nt.key, t.id); keyMap.set(String(nt.key), t.id); }
        });
        const ids = new Set(ws.themes.map((t) => t.id));
        const byId = new Map(batch.map((i) => [i.id, i]));
        (data.assign || []).forEach((a) => {
          const it = byId.get(String(a.item)); if (!it) return;
          const tid = keyMap.get(String(a.theme)) || (ids.has(String(a.theme)) ? String(a.theme) : null);
          if (tid) it.themeId = tid;
        });
        const left = batch.filter((i) => !i.themeId);
        if (left.length) ws.themes.push(...offlineThemes(ws, left, cat, ws.themes.filter((t) => t.category === cat)));
      }
    }
    const used = new Set(PR.liveItems(ws).map((i) => i.themeId));
    ws.themes = ws.themes.filter((t) => used.has(t.id));
    ws.themes.forEach((t) => (t.stats = PR.themeStats(ws, t)));
    st.count = ws.themes.length;
  };

  /* Скоринг: прозрачная формула, считается кодом, а не моделью */
  PR.scoreBacklog = function scoreBacklog(ws, b) {
    const w = ws.settings.weights;
    const themes = ws.themes.filter((t) => b.themes.includes(t.id));
    const items = PR.liveItems(ws).filter((i) => b.themes.includes(i.themeId));
    const docs = new Map(ws.docs.map((d) => [d.id, d]));
    const orgOf = (i) => { const d = docs.get(i.docId) || {}; const s = (d.segments || [])[i.seg] || {}; return (s.org || d.org || d.orgGuess || d.title || '—').trim(); };
    const isInt = (i) => /внутр/i.test((docs.get(i.docId) || {}).segment || '');
    const ext = new Set(items.filter((i) => !isInt(i)).map(orgOf));
    const int = new Set(items.filter(isInt).map(orgOf));
    const block = new Set(items.filter((i) => i.blocker).map(orgOf));
    const sev = items.length ? items.reduce((s, i) => s + i.severity, 0) / items.length : 0;
    const allDates = ws.docs.map((d) => d.date).filter(Boolean).sort();
    const latest = allDates[allDates.length - 1];
    const recentShare = latest ? items.filter((i) => { const d = (docs.get(i.docId) || {}).date; return d && (Date.parse(latest) - Date.parse(d)) / 864e5 <= 45; }).length / (items.length || 1) : 0;
    const parts = [
      { k: 'Внешние клиенты', v: ext.size, w: w.orgExt },
      { k: 'Внутренние источники', v: int.size, w: w.orgInt },
      { k: 'Клиенты с блокером сделки', v: block.size, w: w.blocker },
      { k: 'Средняя критичность (1–3)', v: +sev.toFixed(2), w: w.severity },
      { k: 'Доля свежих (45 дней)', v: +recentShare.toFixed(2), w: w.recency },
    ].map((p) => Object.assign(p, { pts: +(p.v * p.w).toFixed(1) }));
    b.score = Math.round(parts.reduce((s, p) => s + p.pts, 0));
    b.scoreParts = parts;
    b.stats = { items: items.length, orgs: ext.size, orgsInt: int.size, orgNames: [...ext], blockers: block.size, docs: new Set(items.map((i) => i.docId)).size };
    return b;
  };

  PR.buildBacklog = async function buildBacklog(ws, llm, st, hooks = {}) {
    const themes = ws.themes.slice().sort((a, b) => b.stats.orgs - a.stats.orgs || b.stats.items - a.stats.items);
    const prev = ws.backlog;
    let out = [];
    if (llm && themes.length) {
      for (let k = 0; k < themes.length; k += 60) {
        const batch = themes.slice(k, k + 60);
        hooks.log && hooks.log(`Бэклог: ${batch.length} тем`);
        try {
          const r = await llm.json(PR.backlogPrompt(batch, ws.settings), { signal: hooks.signal });
          account(st, r);
          const ids = new Set(batch.map((t) => t.id));
          (r.data.backlog || []).forEach((x) => {
            const th = (Array.isArray(x.themes) ? x.themes : []).map(String).filter((id) => ids.has(id));
            if (!th.length || !x.title) return;
            out.push({ id: uid('b'), title: String(x.title).slice(0, 140), kind: ['epic', 'feature', 'bug', 'research'].includes(x.kind) ? x.kind : 'feature', problem: String(x.problem || ''), proposal: String(x.proposal || ''), acceptance: (Array.isArray(x.acceptance) ? x.acceptance : []).map(String).slice(0, 6), themes: [...new Set(th)], createdBy: 'llm' });
          });
        } catch (e) { st.errors++; hooks.log && hooks.log('Бэклог не собран моделью: ' + (e.message || e.code), 'error'); }
      }
    }
    const covered = new Set(out.flatMap((b) => b.themes));
    themes.filter((t) => !covered.has(t.id)).forEach((t) => out.push({
      id: uid('b'), title: t.title, kind: 'feature', problem: t.statement, proposal: 'Сформулировать решение на продуктовом разборе.',
      acceptance: ['Решение согласовано с клиентами из темы', 'Клиенты подтверждают, что боль закрыта'], themes: [t.id], createdBy: llm ? 'fallback' : 'heuristic',
    }));
    // сохраняем статус и заметки пунктов, которые пересобрались из тех же тем
    out.forEach((b) => {
      const twin = prev.find((p) => p.themes.length && p.themes.every((t) => b.themes.includes(t)) && b.themes.every((t) => p.themes.includes(t)));
      if (twin) { b.status = twin.status; b.note = twin.note; b.tracker = twin.tracker; }
      b.status = b.status || 'new';
      PR.scoreBacklog(ws, b);
    });
    out.sort((a, b) => b.score - a.score);
    const n = out.length;
    out.forEach((b, i) => (b.priority = i < Math.ceil(n * 0.2) ? 'P1' : i < Math.ceil(n * 0.6) ? 'P2' : 'P3'));
    ws.backlog = out;
    st.count = out.length;
  };

  /* Весь конвейер. opts: {docs: [id] — что извлекать; rebuildThemes; skipExtract} */
  PR.runPipeline = async function runPipeline(ws, llm, opts = {}, hooks = {}) {
    const run = newRun(ws, llm);
    const log = (msg, level) => { (run.log = run.log || []).push({ t: Date.now(), msg, level: level || 'info' }); hooks.log && hooks.log(msg, level); };
    const h = Object.assign({}, hooks, { log });
    const emit = () => hooks.update && hooks.update(run);
    try {
      let st = stage(run, 'Нормализация');
      const targets = ws.docs.filter((d) => (opts.docs ? opts.docs.includes(d.id) : d.status !== 'extracted'));
      ws.docs.forEach((d) => PR.normalizeDoc(d, ws.settings, ws.docs));
      st.count = ws.docs.reduce((s, d) => s + (d.termFixes || 0), 0); st.note = 'исправлено терминов';
      done(st); emit();

      st = stage(run, 'Извлечение');
      if (!opts.skipExtract) {
        let k = 0;
        await pool(targets, llm ? ws.settings.llm.concurrency || 2 : 1, async (doc) => {
          const n = await PR.extractDoc(ws, doc, llm, st, h);
          st.count += n; k++;
          log(`Извлечено ${n} из «${doc.title}» (${k}/${targets.length})`);
          hooks.progress && hooks.progress(k / Math.max(1, targets.length), doc);
          emit();
        });
      }
      done(st);

      st = stage(run, 'Сверка цитат');
      const live = ws.items.filter((i) => i.source === 'llm' || i.source === 'heuristic');
      live.forEach((it) => { const d = ws.docs.find((x) => x.id === it.docId); if (d) it.quoteStatus = PR.verifyQuote(d, it); });
      st.count = live.filter((i) => i.quoteStatus === 'verified').length;
      st.note = `из ${live.length}; не найдено: ${live.filter((i) => i.quoteStatus === 'missing').length}`;
      done(st); emit();

      st = stage(run, 'Темы');
      await PR.buildThemes(ws, llm, st, h, !!opts.rebuildThemes);
      done(st); emit();

      st = stage(run, 'Бэклог');
      await PR.buildBacklog(ws, llm, st, h);
      done(st);
      run.ok = true;
      log(`Готово: ${ws.backlog.length} пунктов бэклога из ${ws.themes.length} тем`);
    } catch (e) {
      run.error = e.message || e.code || String(e);
      log('Конвейер остановлен: ' + run.error, 'error');
      const open = run.stages.find((s) => s.startedAt); if (open) done(open);
    }
    run.finishedAt = new Date().toISOString();
    run.totals = run.stages.reduce((a, s) => ({ ms: a.ms + s.ms, calls: a.calls + s.calls, tokIn: a.tokIn + s.tokIn, tokOut: a.tokOut + s.tokOut, estimated: a.estimated || s.estimated }), { ms: 0, calls: 0, tokIn: 0, tokOut: 0, estimated: false });
    const p = ws.settings.prices;
    run.totals.costRub = +((run.totals.tokIn * (p.inRubPer1M || 0) + run.totals.tokOut * (p.outRubPer1M || 0)) / 1e6).toFixed(2);
    run.docsProcessed = (opts.docs || []).length || undefined;
    emit();
    return run;
  };

  /* Пересчитать производные без вызова модели: после ручной разметки */
  PR.refresh = function refresh(ws) {
    const ids = new Set(ws.themes.map((t) => t.id));
    ws.themes.forEach((t) => (t.stats = PR.themeStats(ws, t)));
    ws.themes = ws.themes.filter((t) => t.stats.items > 0 || !ids.has(t.id));
    ws.backlog.forEach((b) => { b.themes = b.themes.filter((t) => ws.themes.some((x) => x.id === t)); PR.scoreBacklog(ws, b); });
    ws.backlog = ws.backlog.filter((b) => b.themes.length).sort((a, b) => b.score - a.score);
  };

  /* ───────────────────────── время продакта: инструмент против ручного разбора ───────────────────────── */
  const docChars = (d) => d.segments.reduce((n, s) => n + (s.text || '').length, 0);
  PR.reviewMinutes = (d) => ((d.reviewLog || []).reduce((n, r) => n + r.activeMs, 0) / 60000) || 0;
  PR.timeSavings = function timeSavings(ws) {
    const meetingsYear = (ws.settings && ws.settings.meetingsYear) || 65; // встреч в год, замер Gate 2
    const side = (docs, minutes) => {
      const chars = docs.reduce((n, d) => n + docChars(d), 0);
      const mins = docs.reduce((n, d) => n + minutes(d), 0);
      const sum = (k) => docs.reduce((n, d) => n + (d.reviewLog || []).reduce((m, r) => m + (r[k] || 0), 0), 0) / (docs.length || 1);
      return { n: docs.length, per10k: chars ? (mins / chars) * 10000 : null, ok: sum('ok'), wrong: sum('wrong'), added: sum('added') };
    };
    const tool = side(ws.docs.filter((d) => PR.reviewMinutes(d) > 0), PR.reviewMinutes);
    const manual = side(ws.docs.filter((d) => d.manualMin > 0), (d) => d.manualMin);
    const avgChars = ws.docs.length ? ws.docs.reduce((n, d) => n + docChars(d), 0) / ws.docs.length : 0;
    const ready = tool.n >= 3 && manual.n >= 3; // на одном-двух источниках разница случайна
    return {
      tool, manual, meetingsYear,
      savedPct: ready ? 1 - tool.per10k / manual.per10k : null,
      hoursYear: ready ? ((manual.per10k - tool.per10k) * (avgChars / 10000) * meetingsYear) / 60 : null,
    };
  };

  /* ───────────────────────── качество: прототип против бейзлайна ───────────────────────── */
  PR.evaluate = function evaluate(ws) {
    const reviewed = ws.docs.filter((d) => d.reviewed);
    const rid = new Set(reviewed.map((d) => d.id));
    const inR = ws.items.filter((i) => rid.has(i.docId));
    const gold = [];
    inR.filter((i) => i.label === 'ok' || i.source === 'manual').forEach((i) => {
      if (!gold.some((g) => g.docId === i.docId && (g.seg === i.seg && overlap(g.quote, i.quote) >= 0.5))) gold.push(i);
    });
    const match = (a, b) => a.docId === b.docId && (overlap(a.quote, b.quote) >= 0.5 || (a.seg === b.seg && overlap(a.summary, b.summary) >= 0.4));
    const sys = (source) => {
      const preds = inR.filter((i) => i.source === source);
      const tp = preds.filter((p) => gold.some((g) => match(p, g))).length;
      const found = gold.filter((g) => preds.some((p) => match(p, g))).length;
      const P = preds.length ? tp / preds.length : 0, R = gold.length ? found / gold.length : 0;
      const F = P + R ? (2 * P * R) / (P + R) : 0;
      const labeled = preds.filter((p) => p.label === 'ok');
      const catOk = labeled.filter((p) => !p.labelCategory || p.labelCategory === p.category).length;
      return { source, preds: preds.length, tp, found, precision: P, recall: R, f1: F, catAcc: labeled.length ? catOk / labeled.length : null, catN: labeled.length };
    };
    const llmItems = ws.items.filter((i) => i.source === 'llm');
    const q = { verified: llmItems.filter((i) => i.quoteStatus === 'verified').length, approx: llmItems.filter((i) => i.quoteStatus === 'approx').length, missing: llmItems.filter((i) => i.quoteStatus === 'missing').length, total: llmItems.length };
    const vendorLeak = llmItems.filter((i) => i.vendorSpeech).length;
    return { reviewedDocs: reviewed.length, gold: gold.length, llm: sys('llm'), baseline: sys('baseline'), heuristic: sys('heuristic'), quotes: q, vendorLeak, labeled: inR.filter((i) => i.label).length };
  };

  /* ───────────────────────── экспорт ───────────────────────── */
  PR.lineage = function lineage(ws, b) {
    const docs = new Map(ws.docs.map((d) => [d.id, d]));
    return ws.themes.filter((t) => b.themes.includes(t.id)).map((t) => ({
      theme: t,
      items: PR.liveItems(ws).filter((i) => i.themeId === t.id).map((i) => ({ item: i, doc: docs.get(i.docId), seg: (docs.get(i.docId) || { segments: [] }).segments[i.seg] })),
    }));
  };

  PR.exportMarkdown = function exportMarkdown(ws) {
    const L = [`# Бэклог из обратной связи`, '', `Собрано ${new Date().toLocaleDateString('ru-RU')} · источников: ${ws.docs.length} · единиц обратной связи: ${PR.liveItems(ws).length} · тем: ${ws.themes.length}`, ''];
    ws.backlog.forEach((b, n) => {
      L.push(`## ${n + 1}. ${b.title}`, '', `**${b.priority} · ${b.kind} · скор ${b.score}** · клиентов: ${b.stats.orgs}${b.stats.blockers ? ' · блокер сделки у ' + b.stats.blockers : ''}`, '');
      if (b.problem) L.push(`**Проблема.** ${b.problem}`, '');
      if (b.proposal) L.push(`**Что сделать.** ${b.proposal}`, '');
      if (b.acceptance && b.acceptance.length) { L.push('**Критерии приёмки:**', ''); b.acceptance.forEach((a) => L.push(`- ${a}`)); L.push(''); }
      L.push('**Из чего собрано:**', '');
      PR.lineage(ws, b).forEach(({ theme, items }) => {
        L.push(`- Тема «${theme.title}» — ${theme.stats.orgs} клиент(ов): ${theme.stats.orgNames.join(', ')}`);
        items.forEach(({ item, doc, seg }) => L.push(`  - «${item.quote}» — ${doc ? (doc.org || doc.title) : ''}, ${doc ? fmtDate(doc.date) : ''}${seg && seg.ts ? ', ' + seg.ts : ''} (${doc ? doc.name : ''})`));
      });
      L.push('');
    });
    return L.join('\n');
  };

  PR.exportCSV = function exportCSV(ws) {
    const esc = (s) => '"' + String(s || '').replace(/"/g, '""') + '"';
    const rows = [['Summary', 'Type', 'Priority', 'Score', 'Clients', 'Description'].join(';')];
    ws.backlog.forEach((b) => {
      const ev = PR.lineage(ws, b).flatMap(({ items }) => items.slice(0, 3).map(({ item, doc }) => `«${item.quote}» — ${doc ? doc.org || doc.title : ''}`)).slice(0, 5).join('\n');
      const desc = `${b.problem}\n\n${b.proposal}\n\nКритерии:\n${(b.acceptance || []).map((a) => '- ' + a).join('\n')}\n\nДоказательства:\n${ev}`;
      rows.push([esc(b.title), b.kind, b.priority, b.score, esc(b.stats.orgNames.join(', ')), esc(desc)].join(';'));
    });
    return '﻿' + rows.join('\n');
  };
})(typeof window !== 'undefined' ? window : globalThis);
