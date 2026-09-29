import { CONFIG } from './config.js';

// ---------- Date (tutte come stringhe locali YYYY-MM-DD) ----------
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const weekday = (s) => parse(s).getDay();
const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
const today = () => iso(new Date());
const fmt = (s) => parse(s).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtLong = (s) => parse(s).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });

// Se la consegna cade nel weekend, va anticipata al venerdì.
const toWorkday = (s) => { let d = s; while ([0, 6].includes(weekday(d))) d = addDays(d, -1); return d; };

// Ordine di visualizzazione Lun..Dom, mappato sugli indici JS (0 = domenica).
const WEEK = [[1, 'Lun'], [2, 'Mar'], [3, 'Mer'], [4, 'Gio'], [5, 'Ven'], [6, 'Sab'], [0, 'Dom']];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = (arr) => arr.reduce((a, e) => a + e.qty, 0);
const uid = () => crypto.randomUUID();

// ---------- Storage: Supabase se configurato, altrimenti localStorage (demo) ----------
function localStore() {
  const KEY = 'planner-montaggio-v1';
  const load = () => {
    try { const raw = localStorage.getItem(KEY); if (raw) return JSON.parse(raw); } catch {}
    return seed();
  };
  let db = load();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };
  save();
  return {
    mode: 'demo',
    async hasAccess() { return true; },
    async listClients() { return db.clients; },
    async listEvents() { return db.events; },
    async listPublications() { return db.publications || []; },
    async lastSync() { return null; },
    async pubblieConnected() { return false; },
    connectUrl() { return null; },
    async syncNow() { throw new Error('Non disponibile in modalità demo'); },
    async saveClient(c) {
      const i = db.clients.findIndex((x) => x.id === c.id);
      if (i >= 0) db.clients[i] = c; else db.clients.push({ ...c, id: uid() });
      save();
    },
    async patchClient(id, fields) { Object.assign(db.clients.find((c) => c.id === id), fields); save(); },
    async assignChannel(channel, clientId) {
      (db.publications || []).forEach((p) => { if (!p.client_id && p.channel === channel) p.client_id = clientId; });
      save();
    },
    async deleteClient(id) {
      db.clients = db.clients.filter((c) => c.id !== id);
      db.events = db.events.filter((e) => e.client_id !== id);
      save();
    },
    async addEvent(e) { db.events.push({ ...e, id: uid(), created_at: new Date().toISOString() }); save(); },
    async deleteEvent(id) { db.events = db.events.filter((e) => e.id !== id); save(); },
    subscribe() {},
  };
}

function seed() {
  const t = today();
  const start = addDays(t, -14);
  const mk = (name, color, schedule, stock, raw) => ({
    id: uid(), name, color, schedule, lead_days: 2, start_date: start,
    initial_stock: stock, initial_raw: raw, notes: '', hidden: false,
  });
  const clients = [
    mk('Ristorante Da Mario (esempio)', '#f59e0b', [0, 1, 0, 1, 0, 1, 0], 8, 12),
    mk('Palestra FitLab (esempio)', '#22c55e', [0, 1, 1, 1, 1, 1, 0], 12, 24),
    mk('Concessionaria Rossi (esempio)', '#3b82f6', [0, 0, 1, 0, 0, 1, 0], 3, 12),
  ];
  return { clients, events: [] };
}

// La chiave arriva col link (?k=...), viene ricordata dal browser e tolta dalla barra degli indirizzi.
function accessKey() {
  const KEY = 'planner-montaggio-key';
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('k');
  if (fromUrl) {
    try { localStorage.setItem(KEY, fromUrl); } catch {}
    url.searchParams.delete('k');
    history.replaceState(null, '', url);
    return fromUrl;
  }
  try { return localStorage.getItem(KEY); } catch { return null; }
}

async function supabaseStore() {
  const key = accessKey();
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-planner-key': key || '' } },
  });
  const ok = ({ data, error }) => { if (error) throw error; return data; };
  return {
    mode: 'cloud',
    async hasAccess() { return !!key && ok(await sb.rpc('has_planner_key')); },
    async listClients() { return ok(await sb.from('clients').select('*').order('name')); },
    async listEvents() { return ok(await sb.from('events').select('*').order('date', { ascending: false })); },
    async listPublications() { return ok(await sb.from('publications').select('*').order('date')); },
    async pubblieConnected() { return ok(await sb.rpc('pubblie_connected')); },
    // Avvia il login OAuth su Pubblie: la funzione sync-pubblie registra l'app, rimanda a Pubblie e poi qui.
    connectUrl() {
      const back = location.origin + location.pathname;
      return `${CONFIG.SUPABASE_URL}/functions/v1/sync-pubblie?action=connect&k=${encodeURIComponent(key || '')}&return=${encodeURIComponent(back)}`;
    },
    async lastSync() {
      return ok(await sb.from('sync_runs').select('*').not('finished_at', 'is', null).order('started_at', { ascending: false }).limit(1))[0] || null;
    },
    // Lancia la sincronizzazione con Pubblie (Edge Function sync-pubblie), autorizzata dalla stessa chiave del link.
    async syncNow() {
      const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/sync-pubblie`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-planner-key': key || '' },
        body: '{}',
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`);
      return out;
    },
    async saveClient(c) {
      const row = { ...c }; if (!row.id) delete row.id; delete row.created_at;
      ok(await sb.from('clients').upsert(row));
    },
    async patchClient(id, fields) { ok(await sb.from('clients').update(fields).eq('id', id)); },
    async assignChannel(channel, clientId) { ok(await sb.from('publications').update({ client_id: clientId }).eq('channel', channel).is('client_id', null)); },
    async deleteClient(id) { ok(await sb.from('clients').delete().eq('id', id)); },
    async addEvent(e) { ok(await sb.from('events').insert(e)); },
    async deleteEvent(id) { ok(await sb.from('events').delete().eq('id', id)); },
    // Senza login il realtime di Supabase non applica la chiave: aggiorno ogni minuto e quando si torna sulla scheda.
    subscribe(onChange) {
      setInterval(() => { if (!document.hidden && !$modal.open) onChange(); }, 60000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden && !$modal.open) onChange(); });
    },
  };
}

// ---------- Calcolo copertura ----------
// Scorre i giorni dalla start_date consumando un video montato per ogni slot di pubblicazione.
// Il primo slot che non si riesce a coprire è il "buco": la scadenza è lì meno i giorni di anticipo.
function compute(c, events) {
  const t = today();
  const ev = events.filter((e) => e.client_id === c.id);
  const edited = sum(ev.filter((e) => e.kind === 'edited'));
  const raw = sum(ev.filter((e) => e.kind === 'raw'));
  const rawLeft = (c.initial_raw || 0) + raw - edited;
  const perWeek = c.schedule.reduce((a, b) => a + b, 0);
  const base = { c, edited, rawLeft, perWeek };
  if (perWeek === 0 || c.hidden) return { ...base, status: 'paused' };

  // I post già programmati su Pubblie sono video montati e pronti.
  const scheduled = state.publications.filter((p) => p.client_id === c.id && p.status === 'scheduled' && p.date >= c.start_date).length;
  let stock = (c.initial_stock || 0) + edited + scheduled;
  let day = c.start_date;
  let lastCovered = null, gap = null, gapCovered = 0;
  for (let i = 0; i < 3650; i++) {
    const n = c.schedule[weekday(day)];
    if (n > 0) {
      const cov = Math.min(n, stock);
      stock -= cov;
      if (cov === n) lastCovered = day;
      if (cov < n) { gap = day; gapCovered = cov; break; }
    }
    day = addDays(day, 1);
  }

  const deadline = toWorkday(addDays(gap, -(c.lead_days || 0)));
  const daysLeft = diffDays(t, deadline);
  const status = daysLeft < 0 ? 'late' : daysLeft <= 2 ? 'soon' : 'ok';

  // Quanti video servono per coprire le pubblicazioni fino a 14 giorni da oggi (almeno il prossimo buco).
  const horizon = addDays(t, 14 + (c.lead_days || 0));
  let need = 0;
  for (let d = gap; d <= horizon; d = addDays(d, 1)) need += c.schedule[weekday(d)];
  need = Math.max(need - gapCovered, c.schedule[weekday(gap)] - gapCovered);

  return { ...base, lastCovered, gap, gapCovered, deadline, daysLeft, status, need, missedPublications: gap < t };
}

// ---------- Stato app ----------
let store;
let state = { clients: [], events: [], publications: [], lastSync: null, pubblieConnected: false, notice: null, view: 'scadenze', month: today().slice(0, 7), monthClient: '', showHidden: false };
const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const $form = document.getElementById('modal-form');

async function reload() {
  const [clients, events, publications, lastSync, connected] = await Promise.all([
    store.listClients(), store.listEvents(), store.listPublications(), store.lastSync(), store.pubblieConnected(),
  ]);
  state.lastSync = lastSync;
  state.pubblieConnected = connected;
  state.clients = clients.map((c) => ({ ...c, schedule: (c.schedule || []).map(Number) }));
  state.events = events;
  state.publications = publications;
  render();
}

function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  ({ scadenze: viewScadenze, mese: viewMese, calendario: viewCalendario, clienti: viewClienti, registro: viewRegistro })[state.view]();
}

const statusLabel = { late: 'In ritardo', soon: 'Urgente', ok: 'In regola', paused: 'In pausa' };
const dot = (color) => `<span class="dot" style="background:${esc(color)}"></span>`;

// ---------- Vista: Scadenze (la task list del montatore) ----------
function viewScadenze() {
  const t = today();
  const rows = state.clients.filter((c) => !c.hidden).map((c) => compute(c, state.events));
  const active = rows.filter((r) => r.status !== 'paused').sort((a, b) => a.deadline.localeCompare(b.deadline));
  const count = (s) => active.filter((r) => r.status === s).length;
  const weekEnd = addDays(t, 7);
  const dueWeek = active.filter((r) => r.deadline <= weekEnd).reduce((a, r) => a + r.need, 0);
  const rawAlerts = active.filter((r) => r.rawLeft < r.need);

  if (!state.clients.length) {
    $app.innerHTML = `<div class="empty">Nessun cliente. Vai su <b>Clienti</b> e aggiungi il primo, con i suoi giorni di pubblicazione.</div>`;
    return;
  }
  if (!active.length) {
    $app.innerHTML = `<div class="empty">Nessun cliente ha ancora i giorni di uscita. Vai su <b>Clienti</b> e compila Lun–Dom: le scadenze compaiono qui appena ne imposti uno.</div>`;
    return;
  }

  // Raggruppa per data di consegna: così si vede subito il carico di ogni giorno.
  const groups = new Map();
  for (const r of active) {
    const key = r.deadline < t ? 'late' : r.deadline;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const groupTitle = (key, list) => {
    const vids = list.reduce((a, r) => a + r.need, 0);
    if (key === 'late') return `In ritardo <span class="muted">· ${list.length} clienti · ${vids} video</span>`;
    const d = diffDays(t, key);
    const rel = d === 0 ? 'Oggi' : d === 1 ? 'Domani' : `Tra ${d} giorni`;
    return `${rel} — ${fmtLong(key)} <span class="muted">· ${list.length} clienti · ${vids} video</span>`;
  };

  const card = (r) => `
    <article class="card status-${r.status}">
      <div class="card-head">
        <div class="card-title">${dot(r.c.color)}${esc(r.c.name)}</div>
        <span class="badge ${r.status}">${statusLabel[r.status]}</span>
      </div>
      <div class="facts">
        <div><span class="k">Coperto fino a</span><span class="v">${r.lastCovered ? fmt(r.lastCovered) : '—'}</span></div>
        <div><span class="k">Prima uscita scoperta</span><span class="v">${fmt(r.gap)}</span></div>
        <div><span class="k">Consegna entro</span><span class="v strong">${fmt(r.deadline)}</span></div>
        <div><span class="k">Da montare (14 gg)</span><span class="v strong">${r.need}</span></div>
        <div><span class="k">Grezzi da montare</span><span class="v ${r.rawLeft < r.need ? 'warn' : ''}">${r.rawLeft}</span></div>
      </div>
      ${r.missedPublications ? `<p class="alert">Uscite già saltate dal ${fmt(r.gap)}. Se in realtà sono state pubblicate, correggi i dati iniziali del cliente.</p>` : ''}
      ${r.rawLeft < r.need ? `<p class="alert">Mancano ${r.need - Math.max(r.rawLeft, 0)} video grezzi: il montatore non può coprire le prossime due settimane.</p>` : ''}
      <div class="actions">
        <button class="primary" data-act="edited" data-id="${r.c.id}">+ Ho montato</button>
        <button data-act="raw" data-id="${r.c.id}">+ Grezzi consegnati</button>
      </div>
    </article>`;

  $app.innerHTML = `
    <section class="summary">
      <div class="stat late"><b>${count('late')}</b><span>in ritardo</span></div>
      <div class="stat soon"><b>${count('soon')}</b><span>urgenti (≤ 2 gg)</span></div>
      <div class="stat ok"><b>${count('ok')}</b><span>in regola</span></div>
      <div class="stat"><b>${dueWeek}</b><span>video da consegnare entro 7 gg</span></div>
      <div class="stat ${rawAlerts.length ? 'late' : ''}"><b>${rawAlerts.length}</b><span>clienti senza girato sufficiente</span></div>
    </section>
    ${[...groups.entries()].map(([k, list]) => `
      <section class="group">
        <h2>${groupTitle(k, list)}</h2>
        <div class="cards">${list.map(card).join('')}</div>
      </section>`).join('')}
    ${rows.some((r) => r.status === 'paused') ? `<p class="muted small">Clienti in pausa (nessun giorno di pubblicazione): ${rows.filter((r) => r.status === 'paused').map((r) => esc(r.c.name)).join(', ')}</p>` : ''}
  `;
  $app.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => openEventModal(b.dataset.id, b.dataset.act));
}

// ---------- Vista: Mese (pubblicazioni reali da Pubblie + uscite pianificate) ----------
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const PUB_LABEL = { published: 'Pubblicato', scheduled: 'Programmato su Pubblie', error: 'Errore di pubblicazione', partial: 'Pubblicato solo su alcuni canali', removed: 'Pubblicato, poi rimosso dai social' };
const PUB_ICON = { published: '✓', scheduled: '⏱', error: '!', partial: '!', removed: '✕' };
const PUBLISHED = ['published', 'partial', 'removed'];

function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function viewMese() {
  const t = today();
  const ym = state.month;
  const [y, m] = ym.split('-').map(Number);
  const first = `${ym}-01`;
  const last = iso(new Date(y, m, 0));
  const byId = Object.fromEntries(state.clients.map((c) => [c.id, c]));
  const only = state.monthClient;
  const inMonth = (d) => d >= first && d <= last;

  const hiddenIds = new Set(state.clients.filter((c) => c.hidden).map((c) => c.id));
  const pubs = state.publications.filter((p) => inMonth(p.date) && (only ? p.client_id === only : !hiddenIds.has(p.client_id)));
  const coverage = Object.fromEntries(state.clients.filter((c) => !c.hidden).map((c) => [c.id, compute(c, state.events)]));

  // Uscite pianificate da oggi in poi: pronta se coperta, da montare se no.
  const planned = (d) => {
    if (d < t) return [];
    return state.clients.filter((c) => !c.hidden && c.schedule[weekday(d)] > 0 && (!only || c.id === only))
      .filter((c) => !pubs.some((p) => p.client_id === c.id && p.date === d))
      .map((c) => {
        const r = coverage[c.id];
        const ok = r.status !== 'paused' && (d < r.gap || (d === r.gap && r.gapCovered > 0));
        return { c, ok };
      });
  };

  const chip = (label, color, cls, title) =>
    `<span class="chip ${cls}" title="${esc(title)}"><i style="background:${esc(color)}"></i><span class="chip-name">${esc(label)}</span></span>`;

  const dayCell = (d) => {
    const dayPubs = pubs.filter((p) => p.date === d);
    const chips = [
      ...dayPubs.map((p) => {
        const c = byId[p.client_id];
        return chip(c ? c.name : p.channel, c ? c.color : '#8b90a0', `pub ${p.status}${c ? '' : ' unmapped'}`,
          `${c ? c.name : p.channel + ' (non collegato a un cliente)'} · ${PUB_LABEL[p.status]}${p.has_video ? '' : ' · foto, non video'}\n${p.excerpt || ''}`);
      }),
      ...planned(d).map(({ c, ok }) => chip(c.name, c.color, ok ? 'plan ready' : 'plan missing',
        `${c.name} · uscita prevista · ${ok ? 'video pronto' : 'video da montare'}`)),
    ];
    const n = +d.slice(8);
    return `<div class="day-cell ${d === t ? 'today' : ''} ${d < t ? 'past' : ''}">
      <div class="day-num"><span class="dow">${parse(d).toLocaleDateString('it-IT', { weekday: 'short' })}</span>${n}</div>
      <div class="chips">${chips.join('')}</div>
    </div>`;
  };

  const lead = (weekday(first) + 6) % 7;
  const days = [];
  for (let d = first; d <= last; d = addDays(d, 1)) days.push(d);

  // Riepilogo del mese per cliente: pubblicati contro contratto.
  const rows = new Map();
  for (const p of pubs) {
    const key = p.client_id || `ch:${p.channel}`;
    if (!rows.has(key)) rows.set(key, { c: byId[p.client_id], channel: p.channel, pub: 0, video: 0, sched: 0 });
    const r = rows.get(key);
    if (PUBLISHED.includes(p.status)) { r.pub++; if (p.has_video) r.video++; }
    if (p.status === 'scheduled') r.sched++;
  }
  for (const c of state.clients) {
    if (c.videos_per_month && !c.hidden && !rows.has(c.id) && (!only || c.id === only)) rows.set(c.id, { c, pub: 0, video: 0, sched: 0 });
  }
  const summary = [...rows.values()].sort((a, b) => (b.c?.videos_per_month || 0) - (a.c?.videos_per_month || 0) || (a.c?.name || a.channel).localeCompare(b.c?.name || b.channel));
  const hasData = state.publications.some((p) => inMonth(p.date));

  $app.innerHTML = `
    <div class="month-bar">
      <button id="m-prev" aria-label="Mese precedente">‹</button>
      <h2>${MONTHS[m - 1]} ${y}</h2>
      <button id="m-next" aria-label="Mese successivo">›</button>
      ${ym !== t.slice(0, 7) ? '<button id="m-today">Oggi</button>' : ''}
      <span class="sync-info small muted" id="sync-info">${syncLabel()}</span>
      ${store.mode === 'demo' ? '' : state.pubblieConnected
        ? '<button id="m-sync">Aggiorna da Pubblie</button>'
        : `<a class="btn primary" href="${esc(store.connectUrl())}">Collega Pubblie</a>`}
      <select id="m-client" aria-label="Filtra cliente">
        <option value="">Tutti i clienti</option>
        ${[...state.clients].filter((c) => !c.hidden).sort((a, b) => a.name.localeCompare(b.name)).map((c) => `<option value="${c.id}" ${c.id === only ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
    </div>
    <div class="legend">
      <span><b class="lg-i">✓</b>Pubblicato</span>
      <span><b class="lg-i">⏱</b>Programmato su Pubblie</span>
      <span><b class="lg-i warn">!</b>Errore o solo alcuni canali</span>
      <span><i class="lg ready"></i>Uscita prevista, video pronto</span>
      <span><i class="lg missing"></i>Uscita prevista, video da montare</span>
    </div>
    ${state.notice ? `<p class="notice ${state.notice.ok ? 'ok' : 'warn'}">${esc(state.notice.text)}</p>` : ''}
    ${!hasData && last < t ? '<p class="muted small">Nessuna pubblicazione importata da Pubblie per questo mese.</p>' : ''}
    <div class="month-grid">
      ${['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'].map((d) => `<div class="dow-head">${d}</div>`).join('')}
      ${'<div class="day-cell blank"></div>'.repeat(lead)}
      ${days.map(dayCell).join('')}
    </div>
    ${summary.length ? `
    <h3 class="section-title">Riepilogo di ${MONTHS[m - 1]}</h3>
    <table class="list month-summary">
      <thead><tr><th>Cliente</th><th class="num">Pubblicati</th><th class="num">Programmati</th><th class="num">Contratto</th><th>Esito</th></tr></thead>
      <tbody>${summary.map((r) => {
        const target = r.c?.videos_per_month;
        const done = r.pub + r.sched;
        const verdict = !target ? '<span class="muted">nessun contratto nel CRM</span>'
          : done >= target ? '<span class="st ok">in linea</span>'
          : `<span class="st warn">mancano ${target - done}</span>`;
        return `<tr>
          <td>${r.c ? dot(r.c.color) + esc(r.c.name) : `<span class="muted">${esc(r.channel)} · non collegato</span>`}</td>
          <td class="num">${r.pub}${r.video < r.pub ? ` <span class="muted small">(${r.pub - r.video} foto)</span>` : ''}</td>
          <td class="num">${r.sched || ''}</td>
          <td class="num">${target || '—'}</td>
          <td>${verdict}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>` : ''}`;

  document.getElementById('m-prev').onclick = () => { state.month = shiftMonth(ym, -1); render(); };
  document.getElementById('m-next').onclick = () => { state.month = shiftMonth(ym, 1); render(); };
  document.getElementById('m-today')?.addEventListener('click', () => { state.month = t.slice(0, 7); render(); });
  document.getElementById('m-client').onchange = (e) => { state.monthClient = e.target.value; render(); };
  document.getElementById('m-sync')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Aggiorno…';
    try {
      await store.syncNow();
      await reload();
    } catch (err) {
      document.getElementById('sync-info').innerHTML = `<span class="st warn">Aggiornamento fallito: ${esc(err.message)}</span>`;
      btn.disabled = false;
      btn.textContent = 'Aggiorna da Pubblie';
    }
  });
}

// Ritorno dal login su Pubblie: ?pubblie=collegato oppure ?pubblie=errore: ...
async function handlePubblieReturn() {
  const url = new URL(location.href);
  const result = url.searchParams.get('pubblie');
  if (!result) return;
  url.searchParams.delete('pubblie');
  history.replaceState(null, '', url);
  state.view = 'mese';
  if (result !== 'collegato') {
    state.notice = { ok: false, text: `Collegamento a Pubblie non riuscito: ${result.replace(/^errore:\s*/, '')}` };
    render();
    return;
  }
  state.notice = { ok: true, text: 'Pubblie collegato. Sto scaricando i post…' };
  render();
  try {
    const out = await store.syncNow();
    state.notice = { ok: true, text: `Pubblie collegato: ${out.posts} post sincronizzati. Da ora si aggiorna da solo ogni 2 ore.` };
  } catch (err) {
    state.notice = { ok: false, text: `Pubblie collegato, ma la prima sincronizzazione è fallita: ${err.message}` };
  }
  await reload();
}

function syncLabel() {
  const r = state.lastSync;
  if (!r) return store.mode === 'demo' ? '' : 'Pubblie: mai sincronizzato';
  const when = new Date(r.finished_at).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  if (!r.ok) return `<span class="st warn" title="${esc(r.error)}">Pubblie: errore ${when}</span>`;
  return `Pubblie aggiornato ${when}${r.unmapped?.length ? ` · <span title="${esc(r.unmapped.join(', '))}">${r.unmapped.length} canali non collegati</span>` : ''}`;
}

// ---------- Vista: Calendario (clienti × prossimi giorni) ----------
function viewCalendario() {
  const t = today();
  const DAYS = 28;
  const days = Array.from({ length: DAYS }, (_, i) => addDays(t, i));
  const rows = state.clients.filter((c) => !c.hidden).map((c) => compute(c, state.events))
    .sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));

  const cell = (r, d) => {
    const n = r.c.schedule[weekday(d)];
    const isDeadline = r.deadline === d || (d === t && r.status === 'late');
    let cls = '', label = '';
    if (n > 0 && r.status !== 'paused') {
      if (d < r.gap) { cls = 'covered'; label = n; }
      else if (d === r.gap && r.gapCovered > 0) { cls = 'partial'; label = `${r.gapCovered}/${n}`; }
      else { cls = 'missing'; label = n; }
    }
    return `<td class="${cls} ${isDeadline ? 'deadline' : ''} ${[0, 6].includes(weekday(d)) ? 'we' : ''}" title="${esc(r.c.name)} · ${fmt(d)}${n ? ` · ${n} uscit${n > 1 ? 'e' : 'a'}` : ''}${isDeadline ? ' · CONSEGNA' : ''}">${label}</td>`;
  };

  $app.innerHTML = `
    <div class="legend">
      <span><i class="lg covered"></i>Uscita coperta</span>
      <span><i class="lg partial"></i>Parzialmente coperta</span>
      <span><i class="lg missing"></i>Uscita scoperta</span>
      <span><i class="lg deadline"></i>Giorno di consegna</span>
    </div>
    <div class="cal-wrap">
      <table class="cal">
        <thead><tr><th class="sticky">Cliente</th>${days.map((d) => `<th class="${d === t ? 'today' : ''} ${[0, 6].includes(weekday(d)) ? 'we' : ''}"><small>${parse(d).toLocaleDateString('it-IT', { weekday: 'narrow' })}</small><br>${parse(d).getDate()}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr><th class="sticky">${dot(r.c.color)}${esc(r.c.name)}</th>${days.map((d) => cell(r, d)).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>`;
}

// ---------- Vista: Clienti (modificabile direttamente in tabella) ----------
const perWeek = (schedule) => schedule.reduce((a, b) => a + b, 0);
// Il contratto è "N video al mese": va bene se le uscite settimanali distano meno di 1 dal ritmo del contratto.
const contractCheck = (c) => {
  const w = perWeek(c.schedule);
  if (!w) return { cls: 'todo', text: 'Da impostare' };
  if (!c.videos_per_month) return { cls: '', text: `${w} a settimana` };
  const target = c.videos_per_month * 12 / 52;
  const ok = Math.abs(w - target) < 1;
  return { cls: ok ? 'ok' : 'warn', text: `${w} a settimana`, hint: `contratto ${c.videos_per_month}/mese ≈ ${Math.round(target)} a settimana` };
};
const DAY_LETTERS = { 1: 'L', 2: 'M', 3: 'M', 4: 'G', 5: 'V', 6: 'S', 0: 'D' };

function viewClienti() {
  const hiddenCount = state.clients.filter((c) => c.hidden).length;
  const rows = state.clients.filter((c) => state.showHidden || !c.hidden).sort((a, b) =>
    a.hidden - b.hidden || (perWeek(a.schedule) === 0) - (perWeek(b.schedule) === 0) || a.name.localeCompare(b.name));
  const unset = rows.filter((c) => !c.hidden && !perWeek(c.schedule)).length;
  const status = (c) => {
    const k = contractCheck(c);
    return `<span class="st ${k.cls}">${k.text}</span>${k.hint ? `<span class="hint">${k.hint}</span>` : ''}`;
  };
  $app.innerHTML = `
    <div class="toolbar">
      <p class="muted small grow">${unset ? `<b>${unset} clienti da impostare.</b> Clicca i giorni in cui escono i video: finché non ne scegli almeno uno il cliente non compare nelle scadenze.` : 'Clicca i giorni per accenderli o spegnerli.'} Si salva da solo.</p>
      <span class="small muted" id="save-state"></span>
      ${hiddenCount ? `<button id="toggle-hidden">${state.showHidden ? 'Solo visibili' : `Mostra nascosti (${hiddenCount})`}</button>` : ''}
      <button class="primary" id="add-client">+ Nuovo cliente</button>
    </div>
    ${unmappedPanel()}
    <div class="table-wrap">
      <table class="list list-edit">
        <thead><tr><th>Cliente</th><th>Giorni di uscita</th><th title="Giorni di anticipo della consegna rispetto all'uscita">Anticipo</th><th>Ritmo</th><th></th></tr></thead>
        <tbody>${rows.map((c) => `
          <tr class="${c.hidden ? 'hidden' : ''} ${perWeek(c.schedule) ? '' : 'unset'}" data-id="${c.id}">
            <td class="name-cell"><div>
              <input type="color" data-f="color" value="${esc(c.color)}" aria-label="Colore">
              <input type="text" data-f="name" value="${esc(c.name)}" aria-label="Nome">
              ${c.hidden ? '<span class="badge">nascosto</span>' : ''}
            </div></td>
            <td><div class="days">${WEEK.map(([i, l]) => `<button type="button" class="day ${c.schedule[i] ? 'on' : ''}" data-day="${i}" title="${l}${c.schedule[i] > 1 ? ` · ${c.schedule[i]} video` : ''}" aria-pressed="${!!c.schedule[i]}">${DAY_LETTERS[i]}${c.schedule[i] > 1 ? `<sup>${c.schedule[i]}</sup>` : ''}</button>`).join('')}</div></td>
            <td><div class="lead"><input type="number" min="0" max="30" data-f="lead_days" value="${c.lead_days}" aria-label="Anticipo"><span class="muted small">gg</span></div></td>
            <td class="status" data-status>${status(c)}</td>
            <td class="right row-actions">
              <button data-hide="${c.id}" title="${c.hidden ? 'Fallo tornare in scadenze e calendari' : 'Toglilo da scadenze e calendari, senza cancellare niente'}">${c.hidden ? 'Mostra' : 'Nascondi'}</button>
              <button data-edit="${c.id}">Dettagli</button>
            </td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;

  const $state = document.getElementById('save-state');
  let timer;
  const save = (c, fields) => {
    Object.assign(c, fields);
    $state.textContent = 'Salvataggio…';
    clearTimeout(timer);
    store.patchClient(c.id, fields)
      .then(() => { $state.textContent = 'Salvato'; timer = setTimeout(() => { $state.textContent = ''; }, 1500); })
      .catch((e) => { $state.textContent = `Errore: ${e.message}`; });
  };
  const clientOf = (el) => state.clients.find((x) => x.id === el.closest('tr').dataset.id);

  $app.querySelectorAll('.day').forEach((btn) => btn.addEventListener('click', () => {
    const c = clientOf(btn);
    const i = Number(btn.dataset.day);
    const schedule = [...c.schedule];
    schedule[i] = schedule[i] ? 0 : 1;
    btn.classList.toggle('on', !!schedule[i]);
    btn.setAttribute('aria-pressed', String(!!schedule[i]));
    btn.innerHTML = DAY_LETTERS[i];
    const tr = btn.closest('tr');
    save(c, { schedule });
    tr.classList.toggle('unset', !perWeek(schedule));
    tr.querySelector('[data-status]').innerHTML = status(c);
  }));

  $app.querySelectorAll('.list-edit input').forEach((inp) => inp.addEventListener('change', () => {
    const c = clientOf(inp);
    const f = inp.dataset.f;
    if (f === 'lead_days') return save(c, { lead_days: Math.max(0, Number(inp.value) || 0) });
    if (f === 'name') {
      if (!inp.value.trim()) { inp.value = c.name; return; }
      return save(c, { name: inp.value.trim() });
    }
    save(c, { [f]: inp.value });
  }));
  $app.querySelectorAll('[data-assign]').forEach((sel) => sel.onchange = async () => {
    if (!sel.value) return;
    const c = state.clients.find((x) => x.id === sel.value);
    const channel = sel.dataset.assign;
    sel.disabled = true;
    await store.patchClient(c.id, { pubblie_accounts: [...new Set([...(c.pubblie_accounts || []), channel])] });
    await store.assignChannel(channel, c.id);
    await reload();
  });
  $app.querySelectorAll('[data-hide]').forEach((btn) => btn.onclick = () => {
    const c = state.clients.find((x) => x.id === btn.dataset.hide);
    save(c, { hidden: !c.hidden });
    viewClienti();
  });
  document.getElementById('toggle-hidden')?.addEventListener('click', () => { state.showHidden = !state.showHidden; viewClienti(); });
  document.getElementById('add-client').onclick = () => openClientModal();
  $app.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openClientModal(state.clients.find((c) => c.id === b.dataset.edit)));
}

// Canali Pubblie con post ma senza cliente: si collegano da qui, senza passare dal database.
function unmappedPanel() {
  const counts = new Map();
  for (const p of state.publications) if (!p.client_id) counts.set(p.channel, (counts.get(p.channel) || 0) + 1);
  if (!counts.size) return '';
  const options = [...state.clients].sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  return `<section class="unmapped">
    <h3>Canali Pubblie non collegati</h3>
    <p class="muted small">Hanno post ma nessun cliente. Scegli a chi appartengono: i post passano al cliente e le prossime sincronizzazioni lo riconoscono da sole.</p>
    ${[...counts].map(([ch, n]) => `<div class="unmapped-row">
      <span><b>${esc(ch)}</b> <span class="muted small">· ${n} post</span></span>
      <select data-assign="${esc(ch)}"><option value="">Collega a…</option>${options}</select>
    </div>`).join('')}
  </section>`;
}

// ---------- Vista: Registro ----------
function viewRegistro() {
  const byId = Object.fromEntries(state.clients.map((c) => [c.id, c]));
  const ev = [...state.events].sort((a, b) => (b.date + (b.created_at || '')).localeCompare(a.date + (a.created_at || ''))).slice(0, 200);
  $app.innerHTML = ev.length ? `
    <table class="list">
      <thead><tr><th>Data</th><th>Cliente</th><th>Tipo</th><th>Qtà</th><th>Nota</th><th></th></tr></thead>
      <tbody>${ev.map((e) => `
        <tr>
          <td>${fmt(e.date)}</td>
          <td>${byId[e.client_id] ? dot(byId[e.client_id].color) + esc(byId[e.client_id].name) : '—'}</td>
          <td>${e.kind === 'edited' ? 'Montati' : 'Grezzi ricevuti'}</td>
          <td>${e.qty}</td>
          <td class="muted">${esc(e.note)}${e.created_by ? ` <small>· ${esc(e.created_by)}</small>` : ''}</td>
          <td class="right"><button class="danger" data-del="${e.id}">Elimina</button></td>
        </tr>`).join('')}</tbody>
    </table>` : `<div class="empty">Ancora nessuna registrazione.</div>`;
  $app.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('Eliminare questa registrazione?')) return;
    await store.deleteEvent(b.dataset.del); reload();
  });
}

// ---------- Modali ----------
function openEventModal(clientId, kind) {
  const c = state.clients.find((x) => x.id === clientId);
  $form.innerHTML = `
    <h3>${kind === 'edited' ? 'Video montati' : 'Grezzi consegnati'} — ${esc(c.name)}</h3>
    <label>Quantità<input name="qty" type="number" min="1" value="1" required autofocus></label>
    <label>Data<input name="date" type="date" value="${today()}" required></label>
    <label>Nota (facoltativa)<input name="note" type="text" placeholder="${kind === 'edited' ? 'es. reel promo autunno' : 'es. blocco da 12 di ottobre'}"></label>
    <div class="actions right">
      <button value="cancel" formnovalidate>Annulla</button>
      <button value="ok" class="primary">Salva</button>
    </div>`;
  $modal.showModal();
  $modal.onclose = async () => {
    if ($modal.returnValue !== 'ok') return;
    const f = new FormData($form);
    await store.addEvent({
      client_id: clientId, kind, qty: Number(f.get('qty')), date: f.get('date'),
      note: f.get('note') || null,
    });
    reload();
  };
}

function openClientModal(c) {
  const isNew = !c;
  c = c || { name: '', color: '#f59e0b', schedule: [0, 1, 0, 1, 0, 1, 0], lead_days: 2, start_date: today(), initial_stock: 0, initial_raw: 0, notes: '', hidden: false };
  $form.innerHTML = `
    <h3>${isNew ? 'Nuovo cliente' : 'Modifica cliente'}</h3>
    <div class="row">
      <label class="grow">Nome<input name="name" value="${esc(c.name)}" required></label>
      <label>Colore<input name="color" type="color" value="${esc(c.color)}"></label>
    </div>
    <fieldset>
      <legend>Video pubblicati per giorno</legend>
      <div class="week">${WEEK.map(([i, l]) => `<label>${l}<input name="d${i}" type="number" min="0" max="9" value="${c.schedule[i] || 0}"></label>`).join('')}</div>
    </fieldset>
    <div class="row">
      <label>Anticipo consegna (giorni)<input name="lead_days" type="number" min="0" max="30" value="${c.lead_days}"></label>
      <label>Conta dal<input name="start_date" type="date" value="${c.start_date}" required></label>
    </div>
    <div class="row">
      <label>Video già pronti a quella data<input name="initial_stock" type="number" min="0" value="${c.initial_stock}"></label>
      <label>Grezzi già in mano al montatore<input name="initial_raw" type="number" min="0" value="${c.initial_raw}"></label>
    </div>
    <div class="row">
      <label>Video al mese da contratto<input name="videos_per_month" type="number" min="0" max="200" value="${c.videos_per_month ?? ''}" placeholder="nessun contratto"></label>
    </div>
    <label>Account Pubblie collegati (uno per riga, nome esatto come su Pubblie)<textarea name="pubblie_accounts" rows="3" placeholder="es. Angelocar">${esc((c.pubblie_accounts || []).join('\n'))}</textarea></label>
    <label>Note<textarea name="notes" rows="2">${esc(c.notes)}</textarea></label>
    <label class="check"><input name="hidden" type="checkbox" ${c.hidden ? 'checked' : ''}> Nascosto (non compare in scadenze e calendari, i dati restano)</label>
    <div class="actions right">
      ${isNew ? '' : '<button value="delete" class="danger" formnovalidate>Elimina</button>'}
      <button value="cancel" formnovalidate>Annulla</button>
      <button value="ok" class="primary">Salva</button>
    </div>`;
  $modal.showModal();
  $modal.onclose = async () => {
    const v = $modal.returnValue;
    if (v === 'delete') {
      if (confirm(`Eliminare ${c.name} e tutto il suo storico?`)) { await store.deleteClient(c.id); reload(); }
      return;
    }
    if (v !== 'ok') return;
    const f = new FormData($form);
    const schedule = [0, 1, 2, 3, 4, 5, 6].map((i) => Number(f.get(`d${i}`)) || 0);
    await store.saveClient({
      ...(isNew ? {} : { id: c.id }),
      name: f.get('name').trim(), color: f.get('color'), schedule,
      lead_days: Number(f.get('lead_days')) || 0, start_date: f.get('start_date'),
      initial_stock: Number(f.get('initial_stock')) || 0, initial_raw: Number(f.get('initial_raw')) || 0,
      notes: f.get('notes') || null, hidden: f.get('hidden') === 'on',
      videos_per_month: f.get('videos_per_month') === '' ? null : Number(f.get('videos_per_month')),
      pubblie_accounts: [...new Set(String(f.get('pubblie_accounts') || '').split('\n').map((x) => x.trim()).filter(Boolean))],
    });
    reload();
  };
}

async function start() {
  if (!(await store.hasAccess())) {
    document.getElementById('tabs').hidden = true;
    $app.innerHTML = `<div class="empty">Per aprire il planner serve il link completo. Chiedilo a Ferdinando.</div>`;
    return;
  }
  document.getElementById('user').innerHTML = store.mode === 'demo'
    ? `<span class="badge soon" title="I dati restano solo in questo browser">Demo locale</span>` : '';
  store.subscribe(() => { if (!document.activeElement?.closest('.list-edit')) reload(); });
  await reload();
  await handlePubblieReturn();
}

document.querySelectorAll('#tabs button').forEach((b) => b.onclick = () => { state.view = b.dataset.view; render(); });

(async () => {
  try {
    store = CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY ? await supabaseStore() : localStore();
    await start();
  } catch (e) {
    $app.innerHTML = `<p class="alert">Errore di caricamento: ${esc(e.message)}. Controlla la connessione e ricarica la pagina.</p>`;
  }
})();
