// Painel administrativo do Wifi a Bordo. Interface 100% por DOM (textContent), sem HTML interpretado: nomes de planos e
// qualquer dado vindo do banco nunca são interpretados como HTML. Toda autorização é do servidor (admin-api);
// aqui só se esconde o que o perfil não pode usar, por clareza.
(() => {
  'use strict';
  const CFG = window.HOTSPOT_CONFIG || {};
  const FN = String(CFG.functionsUrl || '').replace(/\/+$/, '');
  const BASE = FN.replace(/\/functions\/v1$/, '');
  const PKEY = String(window.ADMIN_PUBLISHABLE_KEY || '');
  const TZ = 'America/Fortaleza';
  const SKEY = 'wab-admin-session';
  const PKEY_PERIOD = 'wab-admin-period';
  const root = document.getElementById('app');

  // ---- utilidades DOM -------------------------------------------------------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') el[k] = Boolean(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) { if (kid == null || kid === false) continue; el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
    return el;
  }
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    for (const kid of kids.flat()) if (kid) el.append(kid);
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  // ---- formatação -------------------------------------------------------------
  const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const money = (c) => (c == null ? '—' : brl.format(Number(c) / 100));
  const moneyShort = (c) => (c % 100 === 0 ? 'R$ ' + (c / 100) : brl.format(c / 100));
  const dtf = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const dtfFull = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const tmf = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtDT = (iso) => (iso ? dtf.format(new Date(iso)).replace(',', '') : '—');
  const fmtDTFull = (iso) => (iso ? dtfFull.format(new Date(iso)).replace(',', '') : '—');
  function dur(sec) {
    if (sec == null) return '—';
    const t = Math.max(0, Math.round(Number(sec)));
    if (t < 60) return t + 's';
    const hh = Math.floor(t / 3600); const mm = Math.floor((t % 3600) / 60);
    return hh ? hh + 'h' + String(mm).padStart(2, '0') + 'min' : mm + 'min';
  }
  // duração de plano: "1 hora", "5 horas", "30 min", "1h30min"
  function planDur(sec) {
    const t = Math.round(Number(sec) || 0);
    if (t < 3600) return Math.max(1, Math.round(t / 60)) + ' min';
    return t % 3600 === 0 ? (t / 3600) + (t === 3600 ? ' hora' : ' horas') : dur(t);
  }
  function ago(sec) {
    if (sec == null) return '—';
    const t = Math.max(0, Math.round(Number(sec)));
    if (t < 60) return 'há ' + t + ' s';
    if (t < 3600) return 'há ' + Math.floor(t / 60) + ' min';
    if (t < 86400) return 'há ' + Math.floor(t / 3600) + ' h';
    return 'há ' + Math.floor(t / 86400) + ' d';
  }
  const pct = (v) => (v == null ? null : (v > 0 ? '+' : '') + String(v).replace('.', ',') + '%');

  // ---- sessão e API ------------------------------------------------------------
  let session = null; let me = null;
  const cleanups = [];
  function loadSession() { try { session = JSON.parse(sessionStorage.getItem(SKEY) || 'null'); } catch (_) { session = null; } }
  function saveSession(v) {
    session = v;
    try { if (v) sessionStorage.setItem(SKEY, JSON.stringify(v)); else sessionStorage.removeItem(SKEY); } catch (_) { /* sem armazenamento: só vale nesta aba */ }
  }
  async function authCall(grant, body) {
    let res;
    try {
      res = await fetch(`${BASE}/auth/v1/token?grant_type=${grant}`, {
        method: 'POST', headers: { apikey: PKEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (_) { throw new Error('Sem conexão. Verifique a internet e tente de novo.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(res.status === 400 || res.status === 401 || res.status === 422 ? 'E-mail ou senha incorretos.' : 'Não foi possível entrar agora. Tente de novo.');
    }
    return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  }
  async function refreshSession() {
    if (!session || !session.refresh_token) throw new Error('Sessão expirada.');
    saveSession(await authCall('refresh_token', { refresh_token: session.refresh_token }));
  }
  function logout() { saveSession(null); me = null; runCleanups(); renderLogin(); }
  async function api(action, input) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!session) throw new Error('Sessão expirada.');
      if (Date.now() > session.expires_at - 30000) {
        try { await refreshSession(); } catch (_) { logout(); throw new Error('Sessão expirada. Entre novamente.'); }
      }
      let res;
      try {
        res = await fetch(`${FN}/admin-api`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ action, ...(input || {}) }),
        });
      } catch (_) { throw new Error('Sem conexão com o servidor.'); }
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && attempt === 0) {
        try { await refreshSession(); continue; } catch (_) { logout(); throw new Error('Sessão expirada. Entre novamente.'); }
      }
      if (!res.ok) { const e = new Error(data.error || 'Não foi possível consultar agora.'); e.status = res.status; throw e; }
      return data;
    }
    throw new Error('Não foi possível consultar agora.');
  }
  function runCleanups() { while (cleanups.length) { try { cleanups.pop()(); } catch (_) { /* ignora */ } } }
  function every(fn, ms) {
    const id = setInterval(() => { if (!document.hidden) fn(); }, ms);
    cleanups.push(() => clearInterval(id));
  }
  function download(filename, text) {
    const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: filename }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---- componentes ----------------------------------------------------------------
  const icons = {
    dashboard: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
    pay: 'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7zm0 3h18M7 15h4',
    devices: 'M5 4h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm3 14h8',
    plans: 'M4 7l8-4 8 4-8 4-8-4zm0 5l8 4 8-4M4 17l8 4 8-4',
    report: 'M5 20V10m7 10V4m7 16v-7',
    config: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8-3l-2 .6a6 6 0 0 1-.6 1.4l1 1.8-1.4 1.4-1.8-1a6 6 0 0 1-1.4.6L12 20l-2-.6a6 6 0 0 1-1.4-.6l-1.8 1-1.4-1.4 1-1.8a6 6 0 0 1-.6-1.4L4 12l.6-2a6 6 0 0 1 .6-1.4l-1-1.8 1.4-1.4 1.8 1A6 6 0 0 1 9 6l1-2h4l.6 2a6 6 0 0 1 1.4.6l1.8-1 1.4 1.4-1 1.8c.3.4.5.9.6 1.4l2 .8z',
    refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
    logout: 'M10 4H5v16h5M15 8l4 4-4 4M19 12H9',
  };
  const icon = (name) => s('svg', { viewBox: '0 0 24 24', width: 22, height: 22, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, s('path', { d: icons[name] }));
  const badge = (text, kind) => h('span', { class: 'badge ' + (kind || 'gray'), text });
  function note(kind, text) { return h('div', { class: 'note ' + kind, role: kind === 'error' ? 'alert' : 'status', text }); }
  function skeleton(rows) { return h('div', { class: 'skel' }, Array.from({ length: rows || 3 }, () => h('div', { class: 'skel-row' }))); }
  function empty(text) { return h('div', { class: 'empty', text }); }
  function card(title, body, extra) {
    return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: title }), extra || null), body);
  }
  function table(headers, rows, opts) {
    const o = opts || {};
    const head = h('tr', null, headers.map((t) => h('th', { text: t })));
    const body = rows.map((r) => {
      const tr = h('tr', { class: o.onRow ? 'click' : null, tabindex: o.onRow ? '0' : null }, r.cells.map((c, i) => h('td', { 'data-label': headers[i] }, c)));
      if (o.onRow) { tr.addEventListener('click', () => o.onRow(r)); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') o.onRow(r); }); }
      return tr;
    });
    return h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' }, h('thead', null, head), h('tbody', null, body)));
  }

  // estados de pagamento (não confunde pagamento aprovado com internet liberada)
  const PAY = {
    pending: ['Pix pendente', 'amber', '—'], approved_waiting: ['Pix aprovado', 'green', 'Aguardando provisionamento'],
    provisioned: ['Pix aprovado', 'green', 'Crédito provisionado'], expired: ['Pix expirado', 'gray', '—'],
    failed: ['Pix recusado', 'red', '—'], cancelled: ['Pix cancelado', 'gray', '—'], refunded: ['Estornado', 'red', '—'],
  };
  const payBadge = (st, test) => h('span', null, badge((PAY[st] || [st, 'gray'])[0], (PAY[st] || [0, 'gray'])[1]), test ? [' ', badge('teste', 'violet')] : null);
  const provBadge = (st) => { const t = (PAY[st] || [0, 0, '—'])[2]; return t === 'Crédito provisionado' ? badge(t, 'blue') : t === 'Aguardando provisionamento' ? badge(t, 'amber') : h('span', { class: 'muted', text: t }); };

  // ---- gráfico (SVG próprio, sem biblioteca) -----------------------------------------
  function niceMax(v) {
    if (v <= 0) return 400; // 4 divisões de R$ 1,00 quando ainda não há vendas
    const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : n <= 8 ? 8 : 10) * p; // máximos que dividem bem por 4
  }
  function salesChart(points, bucket) {
    const W = 760; const H = 300; const L = 62; const R = 44; const T = 16; const B = 38;
    const iw = W - L - R; const ih = H - T - B; const n = Math.max(points.length, 1);
    const maxRev = niceMax(Math.max(0, ...points.map((p) => p.revenue_cents)));
    const maxSales = Math.max(4, Math.ceil(Math.max(0, ...points.map((p) => p.sales)) / 4) * 4);
    const x = (i) => L + (iw / n) * (i + 0.5);
    const yR = (v) => T + ih - (v / maxRev) * ih; const yS = (v) => T + ih - (v / maxSales) * ih;
    const bw = Math.max(4, Math.min(48, (iw / n) * 0.6));
    const wrap = h('div', { class: 'chart' }); const tip = h('div', { class: 'tip', hidden: true });
    const svgEl = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Receita e vendas por ${bucket === 'hour' ? 'hora' : 'dia'}`, class: 'chart-svg' });
    for (let g = 0; g <= 4; g++) {
      const gy = T + (ih / 4) * g;
      svgEl.append(s('line', { x1: L, x2: W - R, y1: gy, y2: gy, class: 'grid' }));
      const t1 = s('text', { x: L - 8, y: gy + 4, 'text-anchor': 'end', class: 'axis' }); t1.textContent = moneyShort(Math.round(maxRev * (1 - g / 4)));
      const t2 = s('text', { x: W - R + 8, y: gy + 4, class: 'axis axis-r' }); t2.textContent = String(Math.round(maxSales * (1 - g / 4)));
      svgEl.append(t1, t2);
    }
    const step = Math.ceil(n / 8);
    points.forEach((p, i) => {
      const bh = ih - (yR(p.revenue_cents) - T);
      svgEl.append(s('rect', { x: x(i) - bw / 2, y: yR(p.revenue_cents), width: bw, height: Math.max(0, bh), rx: 3, class: 'bar' }));
      if (i % step === 0) {
        const tx = s('text', { x: x(i), y: H - 12, 'text-anchor': 'middle', class: 'axis' });
        tx.textContent = bucket === 'hour' ? p.label.slice(11, 13) + 'h' : p.label.slice(8, 10) + '/' + p.label.slice(5, 7);
        svgEl.append(tx);
      }
    });
    if (points.length > 1) svgEl.append(s('polyline', { points: points.map((p, i) => `${x(i)},${yS(p.sales)}`).join(' '), class: 'line', fill: 'none' }));
    points.forEach((p, i) => svgEl.append(s('circle', { cx: x(i), cy: yS(p.sales), r: points.length > 40 ? 2 : 3.5, class: 'dot' })));
    points.forEach((p, i) => {
      const hit = s('rect', { x: L + (iw / n) * i, y: T, width: iw / n, height: ih, class: 'hit', tabindex: '0',
        'aria-label': `${bucket === 'hour' ? p.label.slice(11, 16) : p.label.slice(8, 10) + '/' + p.label.slice(5, 7)}: ${money(p.revenue_cents)}, ${p.sales} venda(s)` });
      const showTip = () => {
        tip.hidden = false;
        tip.textContent = `${bucket === 'hour' ? p.label.slice(11, 16) : p.label.slice(8, 10) + '/' + p.label.slice(5, 7)} — ${money(p.revenue_cents)} · ${p.sales} venda${p.sales === 1 ? '' : 's'}`;
        tip.style.left = Math.min(Math.max(((x(i) / W) * 100), 12), 88) + '%';
      };
      hit.addEventListener('pointerenter', showTip); hit.addEventListener('focus', showTip);
      hit.addEventListener('pointerleave', () => { tip.hidden = true; }); hit.addEventListener('blur', () => { tip.hidden = true; });
      svgEl.append(hit);
    });
    wrap.append(svgEl, tip);
    const total = points.reduce((a, p) => a + p.sales, 0);
    if (!total) wrap.append(h('div', { class: 'chart-empty', text: 'Sem vendas no período' }));
    return h('div', null, wrap, h('div', { class: 'legend' }, h('span', { class: 'lg bar-lg' }, 'Receita (R$)'), h('span', { class: 'lg line-lg' }, 'Vendas (quantidade)')));
  }

  // ---- período -------------------------------------------------------------------------
  const PRESETS = [['today', 'Hoje'], ['yesterday', 'Ontem'], ['last7', 'Últimos 7 dias'], ['last30', 'Últimos 30 dias'], ['month', 'Mês atual'], ['custom', 'Período personalizado']];
  function loadPeriod() { try { return JSON.parse(sessionStorage.getItem(PKEY_PERIOD) || 'null') || { preset: 'today' }; } catch (_) { return { preset: 'today' }; } }
  function savePeriod(p) { try { sessionStorage.setItem(PKEY_PERIOD, JSON.stringify(p)); } catch (_) { /* ok */ } }
  function periodControls(state, onChange, opts) {
    const o = opts || {};
    const sel = h('select', { 'aria-label': 'Período', class: 'sel' }, (o.all ? [['all', 'Todo o período']] : []).concat(PRESETS).map(([v, t]) => h('option', { value: v, text: t, selected: state.preset === v })));
    const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    const from = h('input', { type: 'date', class: 'inp', value: state.start || today, 'aria-label': 'Data inicial', max: today });
    const to = h('input', { type: 'date', class: 'inp', value: state.end || today, 'aria-label': 'Data final', max: today });
    const custom = h('span', { class: 'custom', hidden: state.preset !== 'custom' }, from, h('span', { class: 'muted', text: 'até' }), to);
    const apply = () => {
      state.preset = sel.value; state.start = from.value; state.end = to.value; custom.hidden = sel.value !== 'custom';
      if (sel.value === 'custom' && !(from.value && to.value && from.value <= to.value)) return;
      onChange();
    };
    sel.addEventListener('change', apply); from.addEventListener('change', apply); to.addEventListener('change', apply);
    return h('div', { class: 'filters' }, sel, custom);
  }
  const periodArgs = (st) => (st.preset === 'custom' ? { preset: 'custom', start: st.start, end: st.end } : { preset: st.preset });

  // ---- layout --------------------------------------------------------------------------
  const NAV = [['/admin', 'Ao vivo', 'devices', 'Ao vivo'], ['/admin/resumo', 'Resumo', 'dashboard', 'Resumo'], ['/admin/monitor', 'Monitor do MikroTik', 'report', 'Roteador'], ['/admin/pagamentos', 'Pagamentos', 'pay', 'Pix'],
    ['/admin/planos', 'Planos', 'plans', 'Planos'], ['/admin/relatorios', 'Relatórios', 'report', 'Relatórios'], ['/admin/config', 'Configurações', 'config', 'Ajustes']];
  function currentPath() { return location.pathname.replace(/\/+$/, '') || '/admin'; }
  function go(path) { history.pushState({}, '', path); route(); }
  function navLink(path, label, ic, active, shortLabel) {
    const a = h('a', { href: path, class: 'nav-link' + (active ? ' on' : ''), 'aria-current': active ? 'page' : null, 'aria-label': label }, icon(ic), h('span', { class: 'full', text: label }), h('span', { class: 'short', text: shortLabel || label }));
    a.addEventListener('click', (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); go(path); });
    return a;
  }
  function shell(title, content, actions) {
    const cur = currentPath();
    const nav = h('nav', { class: 'nav', 'aria-label': 'Navegação' }, NAV.map(([p, l, i, sl]) => navLink(p, l, i, p === cur, sl)));
    const brand = h('div', { class: 'brand' }, s('svg', { viewBox: '0 0 64 52', width: 26, height: 22, fill: 'none', stroke: '#fff', 'stroke-width': 7, 'stroke-linecap': 'round', 'aria-hidden': 'true' },
      s('path', { d: 'M6 18a36 36 0 0 1 52 0' }), s('path', { d: 'M16 29a22 22 0 0 1 32 0' }), s('circle', { cx: 32, cy: 43, r: 3.2, fill: '#fff', stroke: 'none' })), h('span', { text: 'Wifi a Bordo' }));
    const side = h('aside', { class: 'side' }, brand, nav, h('div', { class: 'side-foot' }, h('div', { class: 'who', text: me ? me.email : '' }), me ? badge(me.role === 'admin' ? 'Administrador' : 'Operador (leitura)', me.role === 'admin' ? 'blue' : 'gray') : null,
      h('button', { class: 'btn ghost sm', type: 'button', onclick: logout }, icon('logout'), 'Sair')));
    const top = h('header', { class: 'top' }, h('h1', { text: title }), h('div', { class: 'top-actions' }, actions || null, h('button', { class: 'btn ghost sm mob', type: 'button', 'aria-label': 'Sair', onclick: logout }, icon('logout'), 'Sair')));
    const main = h('main', { class: 'main', id: 'main' }, top, content);
    clear(root).append(h('div', { class: 'shell' }, side, main));
    return main;
  }
  const lazyView = (title, build) => {
    const slot = h('div', { class: 'view' }, skeleton(4));
    const main = shell(title, slot);
    build(slot, main);
  };

  // ---- login -----------------------------------------------------------------------------
  function renderLogin(message) {
    runCleanups();
    document.title = 'Entrar • Wifi a Bordo';
    const err = h('div', { class: 'note error', role: 'alert', hidden: !message, text: message || '' });
    const email = h('input', { type: 'email', class: 'inp', required: true, autocomplete: 'username', placeholder: 'seu@email.com', id: 'em' });
    const pass = h('input', { type: 'password', class: 'inp', required: true, autocomplete: 'current-password', placeholder: 'Senha', id: 'pw' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Entrar');
    const form = h('form', { class: 'login-card', novalidate: true }, h('div', { class: 'login-brand' }, h('h1', { text: 'Wifi a Bordo' }), h('p', { text: 'Painel administrativo' })),
      h('label', { for: 'em', class: 'lbl', text: 'E-mail' }), email, h('label', { for: 'pw', class: 'lbl', text: 'Senha' }), pass, err, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!email.value.trim() || !pass.value) { err.hidden = false; err.textContent = 'Informe e-mail e senha.'; return; }
      btn.disabled = true; btn.textContent = 'Entrando…'; err.hidden = true;
      try {
        saveSession(await authCall('password', { email: email.value.trim(), password: pass.value }));
        pass.value = '';
        await start();
      } catch (ex) { err.hidden = false; err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Entrar'; }
    });
    clear(root).append(h('div', { class: 'login' }, form));
    email.focus();
  }

  // ---- Dashboard ---------------------------------------------------------------------------
  function statCard(label, value, sub, kind) {
    return h('div', { class: 'stat ' + (kind || '') }, h('div', { class: 'stat-label', text: label }), h('div', { class: 'stat-value', text: value }), sub ? h('div', { class: 'stat-sub' }, sub) : null);
  }
  function alertsBox(alerts) {
    if (!alerts || !alerts.length) return null;
    return h('div', { class: 'alerts' }, alerts.map((a) => h('div', { class: 'alert ' + a.severity, role: 'alert' },
      h('strong', { text: a.message }), h('span', { class: 'alert-meta', text: (a.since ? `Desde ${fmtDTFull(a.since)}` : '') + (a.count > 1 ? ` · ${a.count} ocorrências` : '') }))));
  }
  function integrationText(r) {
    return { never: 'Aguardando o primeiro contato', offline: 'Sem comunicação', no_telemetry: 'Comunicando (telemetria de sessões ainda não recebida)', telemetry_stale: 'Comunicando (dados de sessões desatualizados)', ok: 'Integração em dia' }[r.integration] || r.integration;
  }
  function dashboardView(slot, state) {
    let busy = false;
    const stamp = h('span', { class: 'muted stamp', text: '' });
    const refreshBtn = h('button', { class: 'btn ghost', type: 'button', 'aria-label': 'Atualizar agora' }, icon('refresh'), 'Atualizar');
    const content = h('div', { class: 'dash' });
    async function load(silent) {
      if (busy) return; busy = true; refreshBtn.disabled = true;
      if (!silent) clear(content).append(skeleton(5));
      try {
        const d = await api('dashboard', periodArgs(state));
        clear(content).append(...renderDashboard(d));
        stamp.textContent = 'Atualizado às ' + tmf.format(new Date());
      } catch (e) {
        if (!silent || !content.firstChild) clear(content).append(note('error', e.message));
        else stamp.textContent = 'Falha ao atualizar (' + e.message + ')';
      } finally { busy = false; refreshBtn.disabled = false; }
    }
    function renderDashboard(d) {
      const o = d.overview; const live = d.live; const r = live.router;
      const stale = !r.online || !r.telemetry_fresh;
      const rev = o.revenue_change_pct;
      const cards = h('div', { class: 'stats' },
        statCard('Vendas aprovadas', String(o.sales_count), o.sales_change_pct != null ? [h('span', { class: 'delta ' + (o.sales_change_pct >= 0 ? 'up' : 'down'), text: pct(o.sales_change_pct) }), ' vs. período anterior'] : 'Sem base de comparação'),
        statCard('Receita', money(o.revenue_cents), rev != null ? [h('span', { class: 'delta ' + (rev >= 0 ? 'up' : 'down'), text: pct(rev) }), ' vs. período anterior'] : 'Sem base de comparação', 'accent'),
        statCard('Ticket médio', o.avg_ticket_cents == null ? '—' : money(o.avg_ticket_cents), o.sales_count ? `${o.sales_count} venda${o.sales_count === 1 ? '' : 's'}` : 'Sem vendas no período'),
        statCard('Passes ativos', String(live.active_passes), 'Aparelhos com crédito disponível'),
        statCard('Dispositivos online', live.sessions_online == null ? 'Indisponível' : String(live.sessions_online),
          live.sessions_online == null ? (r.last_telemetry_at ? `Última informação: ${live.sessions_last_known ?? '—'} às ${fmtDT(r.last_telemetry_at)}` : 'Aguardando telemetria do MikroTik') : 'Sessões autenticadas agora', live.sessions_online == null ? 'warn' : ''),
        statCard('Equipamentos online', `${live.routers_online} de ${live.routers_total}`, `${live.routers_total === 1 ? 'equipamento online' : 'equipamentos online'}`, live.routers_online < live.routers_total ? 'bad' : ''));
      const extras = h('div', { class: 'chips' },
        h('span', { class: 'chip' }, 'Pix pendentes: ', h('strong', { text: `${o.pending_count} (${money(o.pending_cents)})` })),
        h('span', { class: 'chip' }, 'Estornos no período: ', h('strong', { text: `${o.refunds_count} (${money(o.refunds_cents)})` })),
        h('span', { class: 'chip' }, 'Horas vendidas: ', h('strong', { text: dur(o.seconds_sold) })),
        h('span', { class: 'chip' }, 'Aparelhos atendidos: ', h('strong', { text: String(o.devices_served) })),
        o.net_estimated_cents != null ? h('span', { class: 'chip' }, 'Líquido estimado: ', h('strong', { text: money(o.net_estimated_cents) })) : h('span', { class: 'chip muted', text: 'Líquido estimado: taxas ainda não informadas' }),
        o.test_orders_excluded ? h('span', { class: 'chip violet', text: `${o.test_orders_excluded} registro(s) de teste fora do financeiro` }) : null);
      const staleNote = stale ? note('warn', !r.online ? 'O MikroTik está sem comunicação: os dados de sessões abaixo estão desatualizados e não representam o momento atual.' : 'Os dados de sessões do MikroTik estão desatualizados ou ainda não foram recebidos.') : null;

      const chart = card(`Vendas — ${d.period.bucket === 'hour' ? 'por hora' : 'por dia'}`, salesChart(d.series.points, d.series.bucket), h('span', { class: 'muted', text: 'Fuso: Fortaleza' }));
      const plansCard = card('Vendas por plano', o.by_plan.length ? table(['Plano', 'Vendas', 'Receita', 'Horas', 'Participação'], o.by_plan.map((p) => ({ cells: [p.name, String(p.sales), money(p.revenue_cents), dur(p.seconds_sold),
        h('div', { class: 'share' }, h('div', { class: 'share-bar' }, h('span', { class: 'share-fill', style: null, 'data-w': p.share_pct })), h('span', { text: String(p.share_pct).replace('.', ',') + '%' }))] }))) : empty('Nenhuma venda aprovada no período.'));
      const eqCard = card('Situação dos equipamentos', table(['Equipamento', 'Local', 'Situação', 'Último contato', 'Integração'], [{ cells: [r.name, r.site || '—',
        badge(r.online ? 'Online' : 'Offline', r.online ? 'green' : 'red'), r.last_seen_at ? `${fmtDTFull(r.last_seen_at)} (${ago(r.seconds_since_contact)})` : 'Nunca', integrationText(r)] }]),
      h('span', { class: 'muted', text: `Offline após ${dur(live.offline_after_seconds)} sem contato` }));
      const salesCard = card('Últimas vendas', d.recent.length ? table(['Horário', 'Plano', 'Valor', 'Pagamento', 'Liberação', 'Dispositivo'], d.recent.map((v) => ({ cells: [fmtDT(v.created_at), v.plan_name, money(v.amount_cents), payBadge(v.state, v.is_test), provBadge(v.state), h('code', { text: v.device_mac })] })))
        : empty('Ainda não há vendas registradas.'), h('a', { href: '/admin/pagamentos', class: 'link', onclick: (e) => { e.preventDefault(); go('/admin/pagamentos'); } }, 'Ver todas'));
      const nodes = [alertsBox(live.alerts), staleNote, cards, extras, chart, h('div', { class: 'two' }, plansCard, eqCard), salesCard].filter(Boolean);
      requestAnimationFrame(() => content.querySelectorAll('.share-fill').forEach((el) => { el.style.width = el.getAttribute('data-w') + '%'; }));
      return nodes;
    }
    refreshBtn.addEventListener('click', () => load(false));
    const controls = periodControls(state, () => { savePeriod(state); load(false); });
    slot.replaceChildren(h('div', { class: 'toolbar' }, controls, h('div', { class: 'toolbar-r' }, stamp, refreshBtn)), content);
    load(false); every(() => load(true), 45000);
  }

  // ---- Pagamentos ------------------------------------------------------------------------------
  const STATE_OPTS = [['', 'Todas as situações'], ['pending', 'Pix pendente'], ['approved_waiting', 'Aprovado aguardando provisionamento'], ['provisioned', 'Crédito provisionado'], ['expired', 'Pix expirado'], ['failed', 'Pix recusado'], ['cancelled', 'Pix cancelado'], ['refunded', 'Estornado']];
  function paymentsView(slot) {
    const st = { preset: 'all', status: '', q: '', offset: 0, limit: 20 };
    const out = h('div', { class: 'view-body' });
    const status = h('select', { class: 'sel', 'aria-label': 'Situação' }, STATE_OPTS.map(([v, t]) => h('option', { value: v, text: t })));
    const q = h('input', { type: 'search', class: 'inp', placeholder: 'Buscar por ID do pagamento, MAC ou pedido', 'aria-label': 'Buscar' });
    const csvBtn = h('button', { class: 'btn ghost', type: 'button' }, 'Exportar CSV');
    let timer = null;
    async function load() {
      clear(out).append(skeleton(5));
      try {
        const r = await api('orders', { ...periodArgs(st), status: st.status, q: st.q, offset: st.offset, limit: st.limit });
        const rows = r.rows.map((o) => ({ cells: [fmtDTFull(o.created_at), o.plan_name, money(o.amount_cents), payBadge(o.state, o.is_test), provBadge(o.state), h('code', { text: o.device_mac }), h('code', { class: 'muted', text: o.payment_id || '—' })] }));
        const from = r.total ? r.offset + 1 : 0; const to = Math.min(r.offset + r.limit, r.total);
        const pager = h('div', { class: 'pager' }, h('span', { class: 'muted', text: `${from}–${to} de ${r.total}` }),
          h('button', { class: 'btn ghost sm', type: 'button', disabled: r.offset === 0, onclick: () => { st.offset = Math.max(0, st.offset - st.limit); load(); } }, 'Anterior'),
          h('button', { class: 'btn ghost sm', type: 'button', disabled: to >= r.total, onclick: () => { st.offset += st.limit; load(); } }, 'Próxima'));
        clear(out).append(rows.length ? table(['Criado em', 'Plano', 'Valor', 'Pagamento', 'Liberação', 'Dispositivo', 'ID do pagamento'], rows) : empty('Nenhum pagamento encontrado com estes filtros.'), pager);
      } catch (e) { clear(out).append(note('error', e.message)); }
    }
    status.addEventListener('change', () => { st.status = status.value; st.offset = 0; load(); });
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { st.q = q.value.trim(); st.offset = 0; load(); }, 350); });
    csvBtn.addEventListener('click', async () => {
      csvBtn.disabled = true;
      try { const r = await api('orders_csv', { ...periodArgs(st), status: st.status, q: st.q }); download(r.filename, r.csv); } catch (e) { alert(e.message); } finally { csvBtn.disabled = false; }
    });
    slot.replaceChildren(h('div', { class: 'toolbar' }, periodControls(st, () => { st.offset = 0; load(); }, { all: true }), status, q, h('div', { class: 'toolbar-r' }, csvBtn)), out);
    load();
  }

  // ---- Dispositivos ------------------------------------------------------------------------------
  function deviceStatus(d) {
    if (d.online) return badge('Online', 'green');
    if (!d.reported_at) return badge('Sem telemetria', 'gray');
    if (!d.telemetry_fresh) return badge('Desatualizado', 'amber');
    return badge('Offline', 'gray');
  }
  function remainingCell(d) {
    if (d.remaining_seconds == null) return h('span', { class: 'muted', text: 'Não disponível' });
    return d.telemetry_fresh ? h('strong', { text: dur(d.remaining_seconds) })
      : h('span', null, h('strong', { text: dur(d.remaining_seconds) }), h('div', { class: 'muted small', text: 'última informação ' + fmtDT(d.reported_at) }));
  }
  const CREDIT = { active: ['Com crédito', 'green'], exhausted: ['Esgotado', 'red'], none: ['Sem crédito', 'gray'] };
  function devicesView(slot) {
    const st = { q: '', offset: 0, limit: 25 };
    const out = h('div', { class: 'view-body' }); const detail = h('div', { class: 'detail' });
    const q = h('input', { type: 'search', class: 'inp', placeholder: 'Buscar por MAC', 'aria-label': 'Buscar por MAC' }); let timer = null;
    async function openDevice(mac) {
      clear(detail).append(skeleton(3)); detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      try {
        const r = await api('device', { mac }); const t = r.telemetry;
        clear(detail).append(card('Aparelho ' + r.mac, h('div', null,
          h('div', { class: 'kv' },
            h('div', null, h('span', { class: 'k', text: 'Crédito' }), badge(CREDIT[r.credit_state][0], CREDIT[r.credit_state][1])),
            h('div', null, h('span', { class: 'k', text: 'IP' }), t && t.ip ? t.ip : '—'),
            h('div', null, h('span', { class: 'k', text: 'Sessão (último relatório)' }), t ? (t.session_active ? 'Ativa' : 'Inativa') : 'Sem telemetria'),
            h('div', null, h('span', { class: 'k', text: 'Tempo usado' }), t ? dur(t.uptime_seconds) : '—'),
            h('div', null, h('span', { class: 'k', text: 'Limite no MikroTik' }), t && t.limit_seconds != null ? dur(t.limit_seconds) : '—'),
            h('div', null, h('span', { class: 'k', text: 'Restante' }), t && t.limit_seconds != null ? dur(Math.max(0, t.limit_seconds - t.uptime_seconds)) : 'Não disponível'),
            h('div', null, h('span', { class: 'k', text: 'Relatório do roteador' }), t ? fmtDTFull(t.reported_at) : '—')),
          h('h3', { text: 'Histórico de compras' }),
          r.orders.length ? table(['Data', 'Plano', 'Valor', 'Pagamento', 'Liberação'], r.orders.map((o) => ({ cells: [fmtDTFull(o.created_at), o.plan_name, money(o.amount_cents), payBadge(o.state, o.is_test), provBadge(o.state)] }))) : empty('Sem compras.')),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: () => clear(detail) }, 'Fechar')));
      } catch (e) { clear(detail).append(note('error', e.message)); }
    }
    async function load() {
      clear(out).append(skeleton(5));
      try {
        const r = await api('devices', { q: st.q, offset: st.offset, limit: st.limit });
        const rows = r.rows.map((d) => ({ mac: d.mac, cells: [h('code', { text: d.mac }), d.ip || '—', deviceStatus(d), dur(d.granted_seconds), d.used_seconds == null ? '—' : dur(d.used_seconds), remainingCell(d),
          String(d.purchases), money(d.total_paid_cents), fmtDT(d.last_seen), badge(CREDIT[d.credit_state][0], CREDIT[d.credit_state][1])] }));
        const from = r.total ? r.offset + 1 : 0; const to = Math.min(r.offset + r.limit, r.total);
        clear(out).append(rows.length ? table(['MAC', 'IP', 'Sessão', 'Concedido', 'Usado', 'Restante', 'Compras', 'Total pago', 'Última atividade', 'Crédito'], rows, { onRow: (r2) => openDevice(r2.mac) }) : empty('Nenhum aparelho com crédito registrado ainda.'),
          h('div', { class: 'pager' }, h('span', { class: 'muted', text: `${from}–${to} de ${r.total}` }),
            h('button', { class: 'btn ghost sm', type: 'button', disabled: r.offset === 0, onclick: () => { st.offset = Math.max(0, st.offset - st.limit); load(); } }, 'Anterior'),
            h('button', { class: 'btn ghost sm', type: 'button', disabled: to >= r.total, onclick: () => { st.offset += st.limit; load(); } }, 'Próxima')),
          h('p', { class: 'muted small', text: 'Tempo restante = limite do MikroTik − tempo usado, conforme o último relatório do roteador. Quando o relatório está antigo, aparece "última informação" com o horário.' }));
      } catch (e) { clear(out).append(note('error', e.message)); }
    }
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { st.q = q.value.trim(); st.offset = 0; load(); }, 350); });
    slot.replaceChildren(h('div', { class: 'toolbar' }, q, h('div', { class: 'toolbar-r' }, h('button', { class: 'btn ghost', type: 'button', onclick: load }, icon('refresh'), 'Atualizar'))), out, detail);
    load(); every(load, 60000);
  }

  // ---- Planos ------------------------------------------------------------------------------------------
  function parseMoney(text) {
    const t = String(text).trim().replace(/^R\$\s*/, '').replace(/\./g, (m, off, all) => (all.includes(',') ? '' : m)).replace(',', '.');
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(t)) return null;
    return Math.round(Number(t) * 100);
  }
  function planForm(plan, onSaved) {
    const isNew = !plan;
    const p = plan || { name: '', description: '', price_cents: 500, grant_seconds: 18000, active: false, highlight: false, is_default: false, sort_order: 0 };
    const inHours = p.grant_seconds % 3600 === 0;
    const f = {
      name: h('input', { class: 'inp', value: p.name, maxlength: '60', id: 'pn', required: true }),
      desc: h('input', { class: 'inp', value: p.description || '', maxlength: '200', id: 'pd', placeholder: 'Opcional' }),
      price: h('input', { class: 'inp', value: (p.price_cents / 100).toFixed(2).replace('.', ','), inputmode: 'decimal', id: 'pp' }),
      amount: h('input', { class: 'inp', type: 'number', min: '1', step: '1', value: String(inHours ? p.grant_seconds / 3600 : Math.round(p.grant_seconds / 60)), id: 'pa' }),
      unit: h('select', { class: 'sel', 'aria-label': 'Unidade' }, h('option', { value: '86400', text: 'dias' }), h('option', { value: '3600', text: 'horas', selected: inHours }), h('option', { value: '60', text: 'minutos', selected: !inHours })),
      sort: h('input', { class: 'inp', type: 'number', step: '1', value: String(p.sort_order), id: 'po' }),
      unl: h('input', { type: 'checkbox', checked: p.unlimited === true, id: 'pun' }),
      wall: h('input', { type: 'checkbox', checked: isNew || p.wall_clock === true, id: 'pwc' }),
      active: h('input', { type: 'checkbox', checked: p.active, id: 'pac' }), high: h('input', { type: 'checkbox', checked: p.highlight, id: 'phi' }), def: h('input', { type: 'checkbox', checked: p.is_default, id: 'pde' }),
    };
    const err = h('div', { class: 'note error', role: 'alert', hidden: true });
    const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, isNew ? 'Criar plano' : 'Salvar alterações');
    const overlay = h('div', { class: 'modal-bg' });
    const close = () => overlay.remove();
    const form = h('form', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': isNew ? 'Novo plano' : 'Editar plano', novalidate: true },
      h('h2', { text: isNew ? 'Novo plano' : 'Editar plano — ' + p.name }),
      isNew ? null : h('p', { class: 'muted', text: `Valor atual: ${money(p.price_cents)} · ${p.unlimited ? "Ilimitado" : planDur(p.grant_seconds)}` }),
      h('div', { class: 'note info', text: 'Alterações de preço ou duração valem só para compras futuras. Pagamentos e Pix pendentes já criados mantêm o valor e a duração originais.' }),
      h('label', { for: 'pn', class: 'lbl', text: 'Nome do plano' }), f.name,
      h('label', { for: 'pd', class: 'lbl', text: 'Descrição (opcional)' }), f.desc,
      h('div', { class: 'row2' }, h('div', null, h('label', { for: 'pp', class: 'lbl', text: 'Valor (R$)' }), f.price),
        h('div', null, h('label', { for: 'pa', class: 'lbl', text: 'Duração' }), h('div', { class: 'inline' }, f.amount, f.unit))),
      h('label', { class: 'chk' }, f.unl, ' Ilimitado (toda a viagem — sem limite de tempo; a duração é ignorada)'),
      h('label', { class: 'chk' }, f.wall, ' Tempo corrido (conta sempre a partir do pagamento, usando ou não)'),
      h('label', { for: 'po', class: 'lbl', text: 'Ordem de exibição (menor aparece primeiro)' }), f.sort,
      h('label', { class: 'chk' }, f.active, ' Ativo (aparece para os passageiros)'),
      h('label', { class: 'chk' }, f.high, ' Destacar como "Mais popular"'),
      h('label', { class: 'chk' }, f.def, ' Plano padrão'),
      err,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Cancelar'), saveBtn));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cents = parseMoney(f.price.value); const secs = Math.round(Number(f.amount.value) * Number(f.unit.value));
      const fail = (m) => { err.hidden = false; err.textContent = m; };
      if (!f.name.value.trim()) return fail('Informe o nome do plano.');
      if (cents == null || cents < 100 || cents > 50000) return fail('O valor deve estar entre R$ 1,00 e R$ 500,00.');
      if (!f.unl.checked && (!Number.isInteger(secs) || secs < 60 || secs > 2592000)) return fail('A duração deve estar entre 1 minuto e 30 dias.');
      if (f.def.checked && !f.active.checked) return fail('O plano padrão precisa estar ativo.');
      saveBtn.disabled = true; saveBtn.textContent = 'Salvando…'; err.hidden = true;
      try {
        await api('plan_save', { plan: { id: isNew ? null : p.id, name: f.name.value.trim(), description: f.desc.value.trim() || null, price_cents: cents, grant_seconds: f.unl.checked ? 172800 : secs, unlimited: f.unl.checked, wall_clock: f.wall.checked,
          active: f.active.checked, highlight: f.high.checked, is_default: f.def.checked, sort_order: Number.parseInt(f.sort.value, 10) || 0 } });
        close(); onSaved();
      } catch (ex) { fail(ex.message); saveBtn.disabled = false; saveBtn.textContent = isNew ? 'Criar plano' : 'Salvar alterações'; }
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    overlay.append(form); document.body.append(overlay); f.name.focus();
  }
  function plansView(slot) {
    const out = h('div', { class: 'view-body' }); const canEdit = me && me.role === 'admin';
    async function load() {
      clear(out).append(skeleton(4));
      try {
        const r = await api('plans');
        const rows = r.plans.map((p) => ({ cells: [h('div', null, h('strong', { text: p.name }), p.description ? h('div', { class: 'muted small', text: p.description }) : null), money(p.price_cents), p.unlimited ? "Ilimitado" : planDur(p.grant_seconds) + (p.wall_clock ? " corridas" : " de uso"),
          h('span', { class: 'badges' }, badge(p.active ? 'Ativo' : 'Inativo', p.active ? 'green' : 'gray'), p.is_default ? badge('Padrão', 'blue') : null, p.highlight ? badge('Mais popular', 'amber') : null),
          String(p.sales), money(p.revenue_cents), p.last_sale_at ? fmtDT(p.last_sale_at) : '—', String(p.sort_order),
          canEdit ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => planForm(p, load) }, 'Editar') : null] }));
        clear(out).append(table(['Plano', 'Preço', 'Duração', 'Situação', 'Vendas', 'Receita', 'Última venda', 'Ordem', canEdit ? 'Ações' : ''], rows),
          h('p', { class: 'muted small', text: 'Vendas e receita contam só pagamentos aprovados (sem estornos e sem registros de teste), com o valor efetivamente pago na época.' }));
      } catch (e) { clear(out).append(note('error', e.message)); }
    }
    slot.replaceChildren(h('div', { class: 'toolbar' }, canEdit ? h('button', { class: 'btn primary', type: 'button', onclick: () => planForm(null, load) }, '+ Novo plano') : badge('Somente leitura', 'gray'),
      h('div', { class: 'toolbar-r' }, h('button', { class: 'btn ghost', type: 'button', onclick: load }, icon('refresh'), 'Atualizar'))), out);
    load();
  }

  // ---- Relatórios ----------------------------------------------------------------------------------------------
  function reportsView(slot) {
    const st = { preset: 'last30', group: 'day' };
    const out = h('div', { class: 'view-body' });
    const group = h('select', { class: 'sel', 'aria-label': 'Agrupar por' }, [['day', 'Faturamento diário'], ['week', 'Faturamento semanal'], ['month', 'Faturamento mensal']].map(([v, t]) => h('option', { value: v, text: t })));
    const csvBtn = h('button', { class: 'btn ghost', type: 'button' }, 'Exportar CSV');
    async function load() {
      clear(out).append(skeleton(4));
      try {
        const r = await api('report', { ...periodArgs(st), group: st.group }); const t = r.totals;
        const label = (p) => { const [y, m, d] = p.split('-'); return st.group === 'month' ? `${m}/${y}` : st.group === 'week' ? `Semana de ${d}/${m}` : `${d}/${m}/${y}`; };
        clear(out).append(h('div', { class: 'stats' }, statCard('Receita', money(t.revenue_cents), null, 'accent'), statCard('Vendas', String(t.sales)), statCard('Ticket médio', t.avg_ticket_cents == null ? '—' : money(t.avg_ticket_cents)),
          statCard('Horas vendidas', dur(t.seconds_sold)), statCard('Aparelhos atendidos', String(t.devices)), statCard('Estornos', money(r.refunds_cents), 'No período')),
        r.rows.length ? table(['Período', 'Vendas', 'Receita', 'Ticket médio', 'Horas vendidas', 'Aparelhos'], r.rows.map((x) => ({ cells: [label(x.period), String(x.sales), money(x.revenue_cents), money(x.avg_ticket_cents), dur(x.seconds_sold), String(x.devices)] }))) : empty('Sem vendas no período.'),
        h('p', { class: 'muted small', text: 'Receita bruta de pagamentos aprovados no banco do sistema. Não é o saldo disponível na conta do Mercado Pago (taxas, prazos de liberação e retiradas não entram aqui).' }));
      } catch (e) { clear(out).append(note('error', e.message)); }
    }
    group.addEventListener('change', () => { st.group = group.value; load(); });
    csvBtn.addEventListener('click', async () => {
      csvBtn.disabled = true;
      try { const r = await api('report_csv', { ...periodArgs(st), group: st.group }); download(r.filename, r.csv); } catch (e) { alert(e.message); } finally { csvBtn.disabled = false; }
    });
    slot.replaceChildren(h('div', { class: 'toolbar' }, periodControls(st, load), group, h('div', { class: 'toolbar-r' }, csvBtn)), out);
    load();
  }

  // ---- Configurações e auditoria -----------------------------------------------------------------------------------
  function configView(slot) {
    const out = h('div', { class: 'view-body' }); const canEdit = me && me.role === 'admin';
    async function load() {
      clear(out).append(skeleton(4));
      try {
        const { settings } = await api('settings');
        const field = (key, label, hint, isText) => {
          const input = h('input', { class: 'inp', value: settings[key] || '', type: isText ? 'text' : 'number', min: isText ? null : '30', max: isText ? null : '86400', disabled: !canEdit, id: 'cfg-' + key });
          const msg = h('span', { class: 'muted small', text: hint });
          const btn = h('button', { class: 'btn ghost sm', type: 'button', disabled: !canEdit, onclick: async () => {
            btn.disabled = true; msg.textContent = 'Salvando…';
            try { await api('setting_set', { key, value: input.value }); msg.textContent = 'Salvo.'; } catch (e) { msg.textContent = e.message; } finally { btn.disabled = false; }
          } }, 'Salvar');
          return h('div', { class: 'cfg' }, h('label', { for: 'cfg-' + key, class: 'lbl', text: label }), h('div', { class: 'inline' }, input, canEdit ? btn : null), msg);
        };
        const body = [h('div', { class: 'cfg-grid' },
          field('router_offline_seconds', 'Considerar o MikroTik offline após (segundos)', 'Sem consulta do wifi-poll por mais que isso = offline (30 a 86400).', false),
          field('telemetry_stale_seconds', 'Dados de sessões desatualizados após (segundos)', 'Relatório de sessões mais antigo que isso não é mostrado como atual.', false),
          field('paid_wait_alert_seconds', 'Alertar pagamento aprovado sem liberação após (segundos)', 'Tempo máximo esperado entre o pagamento e a liberação pelo roteador.', false),
          field('router_name', 'Nome do equipamento', 'Aparece em "Situação dos equipamentos".', true),
          field('site_name', 'Local', 'Nome do local/ônibus.', true))];
        if (!canEdit) body.unshift(note('info', 'Seu perfil é somente leitura: as configurações só podem ser alteradas por administradores.'));
        clear(out).append(card('Limites e nomes', h('div', null, body)));
        if (canEdit) {
          const audit = await api('audit', { limit: 50 });
          out.append(card('Histórico de alterações', audit.entries.length ? table(['Quando', 'Quem', 'Ação', 'Item', 'Antes → Depois'], audit.entries.map((e) => ({ cells: [fmtDTFull(e.at), e.actor_email || '—',
            { plan_create: 'Plano criado', plan_update: 'Plano alterado', setting_update: 'Configuração alterada' }[e.action] || e.action,
            e.entity === 'plan' ? (e.after_data && e.after_data.name) || e.entity_id : e.entity_id, changeText(e)] }))) : empty('Nenhuma alteração registrada.')));
        }
      } catch (e) { clear(out).append(note('error', e.message)); }
    }
    function changeText(e) {
      const b = e.before_data || {}; const a = e.after_data || {};
      if (e.entity === 'setting') return `${b.value ?? '—'} → ${a.value ?? '—'}`;
      const parts = [];
      if (!e.before_data) return `Novo: ${money(a.price_cents)} · ${planDur(a.grant_seconds)}`;
      if (b.price_cents !== a.price_cents) parts.push(`preço ${money(b.price_cents)} → ${money(a.price_cents)}`);
      if (b.grant_seconds !== a.grant_seconds) parts.push(`duração ${planDur(b.grant_seconds)} → ${planDur(a.grant_seconds)}`);
      if (b.active !== a.active) parts.push(a.active ? 'ativado' : 'desativado');
      if (b.name !== a.name) parts.push(`nome “${b.name}” → “${a.name}”`);
      if (b.is_default !== a.is_default || b.highlight !== a.highlight || b.sort_order !== a.sort_order) parts.push('destaque/padrão/ordem');
      return parts.join('; ') || 'sem mudança de valores';
    }
    slot.replaceChildren(out); load();
  }

  // ---- Ao vivo: TODOS os aparelhos vistos pelo MikroTik + cadastro + direito de acesso + ações -----------------------------
  const LIVE_STATUS = {
    not_identified: ['Não identificado', 'gray'], waiting: ['Aguardando liberação', 'amber'], pix_pending: ['Pix pendente', 'amber'],
    provisioning: ['Liberando no roteador…', 'blue'], internet_active: ['Internet ativa', 'green'],
    authorized_not_authenticated: ['Autorizado, sem sessão', 'red'], authorized_offline: ['Autorizado · desconectado', 'gray'],
    auth_error: ['Erro ao aplicar', 'red'], revoked: ['Revogado', 'gray'], blocked: ['Bloqueado', 'red'],
    legacy_active: ['Crédito de horas (antigo)', 'violet'], legacy_exhausted: ['Horas antigas esgotadas', 'gray'],
  };
  const SOURCE = { manual_prepaid_20: 'Pré-pago R$ 20 (manual)', pix: 'Pix R$ 25', transfer: 'Transferido' };
  const LIVE_FILTERS = [['all', 'Todos'], ['online', 'Na rede agora'], ['waiting', 'Aguardando'], ['unidentified', 'Não identificados'],
    ['active', 'Com acesso'], ['problem', 'Pagou/liberado sem internet'], ['manual', 'Pré-pagos (manual)'], ['pix', 'Pix R$ 25'],
    ['pix_pending', 'Pix pendente'], ['blocked', 'Bloqueados'], ['revoked', 'Revogados'], ['offline', 'Fora da rede']];
  const ACTION_TEXT = {
    grant: (p) => `LIBERAR ACESSO para ${p.full_name || 'aparelho não identificado'} (${p.mac})?\n\nConfirme que esta pessoa está na sua lista de quem já pagou R$ 20. A internet fica liberada sem limite de horas durante a viagem, sem gerar Pix.`,
    kick: (p) => `DESCONECTAR a sessão de ${p.full_name || p.mac} agora?\n\nÉ temporário: como o acesso continua válido, o aparelho entra de novo sozinho na próxima conexão. Para impedir o acesso use Revogar ou Bloquear.`,
    revoke: (p) => `REVOGAR o acesso de ${p.full_name || p.mac}?\n\nO direito é cancelado, a sessão cai e o aparelho NÃO volta sozinho (nem por pagamento antigo). O registro do pagamento é mantido.`,
    block: (p) => `BLOQUEAR o aparelho ${p.mac} (${p.full_name || 'não identificado'})?\n\nNenhum acesso nem Pix para este MAC até desbloquear. Atenção: um iPhone pode trocar de MAC privado e aparecer como outro aparelho.`,
    unblock: (p) => `DESBLOQUEAR ${p.mac}?\n\n${p.access_state === 'active' ? 'O acesso que ele já tinha volta a valer.' : 'Ele NÃO ganha internet: continua aguardando liberação ou Pix.'}`,
    reauth: (p) => `REAUTENTICAR ${p.full_name || p.mac}?\n\nO roteador reaplica o acesso e pede um novo login só deste aparelho. Não cria crédito nem cobrança.`,
  };
  const DONE_TEXT = {
    granted: 'Liberação registrada. Comando enviado ao roteador — aguardando aplicação (até ~20 s).', already: 'Este aparelho já tinha acesso ativo (nada duplicado).',
    queued: 'Comando enviado ao roteador — aguardando aplicação.', revoked: 'Acesso revogado. Comando enviado ao roteador.', blocked: 'Aparelho bloqueado. Comando enviado ao roteador.',
    unblocked_restored: 'Desbloqueado: o acesso anterior volta a valer (comando enviado).', unblocked_no_access: 'Desbloqueado. Sem acesso ativo: continua sem internet até liberar ou pagar.',
  };
  function liveView(slot) {
    let busy = false; let filter = 'all'; let q = ''; let last = null; let sentAt = 0;
    const canEdit = me && me.role === 'admin';
    const status = h('div', { class: 'live-status' });
    const msg = h('div', { class: 'live-msg', role: 'status' });
    const stats = h('div', { class: 'stats' });
    const alertSlot = h('div');
    const list = h('div');
    const search = h('input', { class: 'inp', type: 'search', placeholder: 'Buscar nome, e-mail, MAC ou IP', 'aria-label': 'Buscar' });
    const sel = h('select', { class: 'sel', 'aria-label': 'Filtro' }, LIVE_FILTERS.map(([v, l]) => h('option', { value: v, text: l })));
    const refreshBtn = h('button', { class: 'btn ghost', type: 'button' }, icon('refresh'), 'Atualizar');
    const endBtn = canEdit ? h('button', { class: 'btn ghost danger', type: 'button', text: 'Encerrar viagem' }) : null;
    let tq = null;
    search.addEventListener('input', () => { clearTimeout(tq); tq = setTimeout(() => { q = search.value.trim(); load(); }, 300); });
    sel.addEventListener('change', () => { filter = sel.value; load(); });
    refreshBtn.addEventListener('click', () => load());
    function flash(kind, text) { msg.className = 'live-msg ' + kind; msg.textContent = text; }

    async function doAction(p, op_) {
      if (!window.confirm(ACTION_TEXT[op_](p))) return;
      let note = null;
      if (op_ === 'grant' || op_ === 'block' || op_ === 'revoke') {
        note = window.prompt('Observação (opcional, ex.: "lista de pré-pagos conferida"):', '');
        if (note === null) return;
      }
      try {
        const r = await api('device_action', { mac: p.mac, op: op_, note: note || undefined });
        flash('ok', DONE_TEXT[r.result] || 'Feito.'); sentAt = Date.now();
      } catch (e) { flash('error', e.message); }
      load();
    }
    async function doTransfer(p) {
      const to = (window.prompt(`TRANSFERIR o acesso de ${p.full_name || p.mac} (${p.mac}) para outro MAC (iPhone com MAC privado trocado).\n\nConfira a identidade pessoalmente. O MAC antigo perde o acesso.\n\nNovo MAC (ex.: AA:BB:CC:DD:EE:FF):`, '') || '').trim().toUpperCase().replace(/-/g, ':');
      if (!to) return;
      if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(to)) { flash('error', 'MAC inválido.'); return; }
      try { await api('transfer', { from: p.mac, to }); flash('ok', `Acesso transferido para ${to}. Comandos enviados ao roteador.`); sentAt = Date.now(); } catch (e) { flash('error', e.message); }
      load();
    }
    async function doReset(p) {
      if (!window.confirm(`EXCLUIR o aparelho ${p.mac} (${p.full_name || 'não identificado'})?

• Some da lista e perde cadastro (nome/e-mail), acesso, bloqueio e cortesias.
• O roteador derruba a sessão; Pix pendente é encerrado e, se pago depois, NÃO libera acesso.
• Pagamentos aprovados continuam na aba Pagamentos.
• Se voltar, começa do zero (cadastro → aguardando → liberação ou Pix).`)) return;
      try {
        const r = await api('device_reset', { mac: p.mac });
        flash('ok', `Aparelho excluído.${r.payments_kept ? ` ${r.payments_kept} pagamento(s) preservado(s) na aba Pagamentos.` : ''}${r.pix_pending_closed ? ' Pix pendente encerrado.' : ''}`);
      } catch (e) { flash('error', e.message); }
      load();
    }
    if (endBtn) endBtn.addEventListener('click', async () => {
      const c = window.prompt('ENCERRAR A VIAGEM: todos os acessos liberados (pré-pagos, Pix e transferidos) serão revogados agora. O histórico e os pagamentos ficam guardados.\n\nPara confirmar, digite ENCERRAR:', '');
      if (c === null) return;
      try { const r = await api('end_trip', { confirm: c.trim() }); flash('ok', `Viagem encerrada: ${r.revoked} acesso(s) revogado(s).`); } catch (e) { flash('error', e.message); }
      load();
    });

    function actionsFor(p) {
      if (!canEdit) return h('span', { class: 'muted', text: '—' });
      const b = (op_, label, kind) => h('button', { class: 'btn sm ' + (kind || 'ghost'), type: 'button', text: label, onclick: () => doAction(p, op_) });
      const out = [];
      if (p.blocked) out.push(b('unblock', 'Desbloquear'));
      else {
        if (p.access_state !== 'active') out.push(b('grant', 'Liberar acesso', 'primary'));
        if (p.access_state === 'active') {
          if (['authorized_not_authenticated', 'auth_error', 'provisioning'].includes(p.status)) out.push(b('reauth', 'Reautenticar', 'primary'));
          if (p.host_authorized) out.push(b('kick', 'Desconectar'));
          out.push(b('revoke', 'Revogar'));
          out.push(h('button', { class: 'btn sm ghost', type: 'button', text: 'Transferir', onclick: () => doTransfer(p) }));
        }
        out.push(b('block', 'Bloquear', 'danger'));
      }
      out.push(h('button', { class: 'btn sm ghost danger', type: 'button', text: 'Excluir', onclick: () => doReset(p) }));
      return h('div', { class: 'row-actions' }, out);
    }
    const ageS = (iso, now) => (iso ? Math.max(0, Math.round((now - Date.parse(iso)) / 1000)) : null);
    function render(d) {
      const sm = d.summary; const now = Date.parse(sm.at) || Date.now();
      const rAge = ageS(sm.router_seen_at, now); const fAge = ageS(sm.feed_at, now);
      clear(status).append(
        badge(sm.router_online ? 'MikroTik online' : 'MikroTik sem contato', sm.router_online ? 'green' : 'red'), ' ',
        h('span', { class: 'muted', text: `Último contato do roteador: ${ago(rAge)} · presença: ${ago(fAge)}${sm.feed_fresh ? '' : ' (desatualizada)'} · painel atualizado às ${tmf.format(new Date())}` }),
        sm.commands_open ? h('span', null, ' ', badge(`${sm.commands_open} comando(s) aguardando o roteador`, 'amber')) : '',
        sm.trip_ended_at ? h('span', null, ' ', badge('Viagem encerrada em ' + fmtDT(sm.trip_ended_at), 'gray')) : '');
      clear(stats).append(
        statCard('Na rede agora', String(sm.present), 'vistos pelo MikroTik (≈ últimos 90 s)', 'accent'),
        statCard('Navegando', String(sm.internet), 'sessão autenticada confirmada'),
        statCard('Aguardando', String(sm.waiting), `cadastrados sem acesso${sm.pix_pending ? ` · ${sm.pix_pending} com Pix pendente` : ''}`, sm.waiting ? 'warn' : ''),
        statCard('Não identificados', String(sm.present_unidentified), 'na rede, sem nome/e-mail'),
        statCard('Pré-pagos liberados', String(sm.manual), 'R$ 20 pagos fora do sistema'),
        statCard('Pix R$ 25', String(sm.pix), `receita no Mercado Pago: ${money(sm.revenue_total_cents)}`),
        statCard('Liberados sem internet', String(sm.problems), 'use Reautenticar', sm.problems ? 'bad' : ''),
        statCard('Bloqueados', String(sm.blocked), sm.transferred ? `${sm.transferred} transferido(s)` : null),
        statCard('Cadastrados', String(sm.registered), 'total com nome e e-mail'));
      clear(alertSlot).append(sm.problems ? h('div', { class: 'alerts' }, h('div', { class: 'alert critical', role: 'alert' },
        h('strong', { text: `${sm.problems} aparelho(s) com acesso liberado mas sem internet.` }),
        h('span', { class: 'alert-meta', text: 'O roteador tenta reautenticar sozinho; se persistir, filtre "Pagou/liberado sem internet" e use Reautenticar, ou peça para desligar e ligar o Wi-Fi.' }))) : '');
      const rows = d.list.rows.map((p) => {
        const st = LIVE_STATUS[p.status] || [p.status, 'gray'];
        const seen = ageS(p.last_contact, now);
        const cmd = p.cmd_status === 'queued' || p.cmd_status === 'sent' ? 'Comando aguardando o roteador' : p.cmd_status === 'failed' ? 'Comando falhou' : null;
        return { cells: [
          h('div', null, h('strong', { text: p.full_name || 'Não identificado' }), h('div', { class: 'muted small', text: p.email || 'Não informado' })),
          h('div', null, h('code', { text: p.mac }), h('div', { class: 'muted small', text: p.ip || '—' })),
          h('div', null, badge(p.online ? 'Na rede' : 'Sem sinal', p.online ? 'green' : 'gray'), h('div', { class: 'muted small', text: seen == null ? 'nunca visto' : 'visto ' + ago(seen) })),
          h('div', null, badge(st[0], st[1]), cmd ? h('div', { class: 'muted small', text: cmd }) : null, p.pix_pending && p.status !== 'pix_pending' ? h('div', { class: 'muted small', text: 'Pix pendente' }) : null),
          h('div', null, h('span', { text: p.access_source ? SOURCE[p.access_source] || p.access_source : (p.paid_count ? `${p.paid_count} pagamento(s) antigo(s)` : '—') }),
            p.access_granted_at ? h('div', { class: 'muted small', text: `${p.access_state === 'active' ? 'liberado' : 'revogado'} ${fmtDT(p.access_state === 'active' ? p.access_granted_at : p.revoked_at)}${p.access_granted_by && p.access_state === 'active' ? ' · ' + p.access_granted_by : ''}` }) : null),
          actionsFor(p)] };
      });
      clear(list).append(rows.length
        ? table(['Passageiro', 'MAC / IP', 'Presença', 'Situação', 'Origem do acesso', 'Ações'], rows)
        : empty(filter === 'all' && !q ? 'Nenhum aparelho visto ainda. Assim que alguém conectar ao Wi-Fi, aparece aqui.' : 'Nada com este filtro.'),
      h('p', { class: 'muted small', text: `${d.list.total} aparelho(s). A presença vem do MikroTik a cada ~20 s; "Na rede" = visto nos últimos 90 s (o Hotspot pode manter registros de quem acabou de sair).` }));
    }
    async function load() {
      if (busy) return; busy = true; refreshBtn.disabled = true;
      try {
        const d = await api('live', { filter, q });
        last = d; render(d);
        if (sentAt && Date.now() - sentAt > 120000) { sentAt = 0; msg.textContent = ''; msg.className = 'live-msg'; }
      } catch (e) {
        if (!last) clear(list).append(note('error', e.message)); else flash('error', 'Falha ao atualizar: ' + e.message + ' (tentando de novo)');
      } finally { busy = false; refreshBtn.disabled = false; }
    }
    slot.replaceChildren(h('div', { class: 'live' }, status,
      h('div', { class: 'toolbar' }, h('div', { class: 'filters' }, sel, search), h('div', { class: 'toolbar-r' }, refreshBtn, endBtn)),
      msg, alertSlot, stats, card('Passageiros e aparelhos', list)));
    load();
    every(load, 4000);
  }

  // ---- Monitor do MikroTik (dados reais enviados pelo wifi-poll; nada é estimado) ---------------------------------------
  function lineChart(points, series, unit, maxHint) {
    const W = 640, H = 200, L = 40, R = 10, T = 12, B = 26;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': series.map((x) => x.label).join(' e ') });
    const vals = points.flatMap((p) => series.map((x) => p[x.key])).filter((v) => v != null).map(Number);
    if (!points.length || !vals.length) { svg.append(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'axis' }, document.createTextNode('Sem amostras no período'))); return svg; }
    const max = Math.max(maxHint || 0, ...vals) || 1;
    const t0 = Date.parse(points[0].at), t1 = Date.parse(points[points.length - 1].at) || t0 + 1;
    const X = (t) => L + ((Date.parse(t) - t0) / Math.max(1, t1 - t0)) * (W - L - R);
    const Y = (v) => T + (1 - Number(v) / max) * (H - T - B);
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4; const y = Y(v);
      svg.append(s('line', { x1: L, x2: W - R, y1: y, y2: y, class: 'grid' }), s('text', { x: L - 6, y: y + 4, 'text-anchor': 'end', class: 'axis' }, document.createTextNode((v >= 10 ? Math.round(v) : v.toFixed(1)) + unit)));
    }
    svg.append(s('text', { x: L, y: H - 6, class: 'axis' }, document.createTextNode(tmf.format(new Date(t0)).slice(0, 5))),
      s('text', { x: W - R, y: H - 6, 'text-anchor': 'end', class: 'axis' }, document.createTextNode(tmf.format(new Date(t1)).slice(0, 5))));
    for (const x of series) {
      let d = ''; let pen = false;
      for (const p of points) { if (p[x.key] == null) { pen = false; continue; } d += (pen ? 'L' : 'M') + X(p.at).toFixed(1) + ' ' + Y(p[x.key]).toFixed(1) + ' '; pen = true; }
      svg.append(s('path', { d, class: 'ln ' + x.cls, fill: 'none' }));
    }
    return svg;
  }
  const legend = (series) => h('div', { class: 'legend' }, series.map((x) => h('span', { class: 'lg ' + x.cls, text: x.label })));
  const fmtMbps = (v) => (v == null ? '—' : Number(v) >= 10 ? Math.round(Number(v)) + ' Mbps' : Number(v).toFixed(2).replace('.', ',') + ' Mbps');
  const mib = (b) => (b == null ? '—' : Math.round(Number(b) / 1048576) + ' MiB');
  function upFmt(sec) { if (sec == null) return '—'; const d = Math.floor(sec / 86400); const hh = Math.floor((sec % 86400) / 3600); const mm = Math.floor((sec % 3600) / 60); return (d ? d + 'd ' : '') + hh + 'h' + String(mm).padStart(2, '0'); }

  function monitorView(slot) {
    let busy = false; let minutes = 60;
    const out = h('div', { class: 'live' });
    const sel = h('select', { class: 'sel', 'aria-label': 'Período' }, [[60, 'Última hora'], [180, 'Últimas 3 h'], [720, 'Últimas 12 h'], [2880, 'Últimas 48 h']].map(([v, l]) => h('option', { value: String(v), text: l })));
    sel.addEventListener('change', () => { minutes = Number(sel.value); load(); });
    const refreshBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => load() }, icon('refresh'), 'Atualizar');
    function render(d) {
      const now = Date.parse(d.now) || Date.now();
      const m = d.last; const mAge = m ? Math.round((now - Date.parse(m.at)) / 1000) : null;
      const rAge = d.router_seen_at ? Math.round((now - Date.parse(d.router_seen_at)) / 1000) : null;
      const stale = Boolean(m) && mAge > 180; const online = rAge != null && rAge < 60;
      const memPct = m && m.mem_total ? Math.round(((m.mem_total - m.mem_free) * 100) / m.mem_total) : null;
      const ago2 = (x) => (x == null ? '—' : ago(x));
      const alerts = [];
      if (!online) alerts.push(['critical', `MikroTik sem comunicação com o servidor (último contato ${ago2(rAge)}).`]);
      if (!m) alerts.push(['warning', 'Métricas do equipamento aguardando atualização do script RouterOS. Sessões e presença abaixo já são dados reais.']);
      else if (stale) alerts.push(['warning', `Métricas do equipamento desatualizadas (última amostra ${ago2(mAge)}).`]);
      if (m && !stale && m.cpu != null && m.cpu >= 90) alerts.push(['critical', `CPU do MikroTik em ${m.cpu}% (medido). CPU no limite pode reduzir a vazão — hipótese a confirmar comparando com o tráfego.`]);
      if (m && !stale && memPct != null && memPct >= 90) alerts.push(['critical', `Memória do MikroTik quase cheia: ${memPct}% usada (medido).`]);
      for (const p of (m && !stale ? m.ports : null) || []) if (p.running && p.rate && /^10Mbps/.test(p.rate)) alerts.push(['warning', `Porta ${p.name} negociou só ${p.rate} (medido). Verifique cabo/porta.`]);
      if (d.commands_failed_1h > 0) alerts.push(['warning', `${d.commands_failed_1h} comando(s) para o roteador falharam na última hora.`]);
      const wait = 'aguardando script';
      out.replaceChildren(
        h('div', { class: 'live-status' }, badge(online ? 'MikroTik online' : 'MikroTik sem contato', online ? 'green' : 'red'), ' ',
          h('span', { class: 'muted', text: `Último contato: ${ago2(rAge)} · métricas do equipamento: ${m ? ago2(mAge) : 'nunca recebidas'} · painel atualizado às ${tmf.format(new Date())}` })),
        alerts.length ? h('div', { class: 'alerts' }, alerts.map(([sev, t]) => h('div', { class: 'alert ' + sev, role: 'alert' }, h('strong', { text: t })))) : '',
        h('div', { class: 'stats' },
          statCard('CPU', m && m.cpu != null ? m.cpu + '%' : '—', m ? `${m.board || ''} · RouterOS ${m.version || ''}` : wait, m && m.cpu >= 90 ? 'bad' : 'accent'),
          statCard('Memória', memPct != null ? memPct + '% usada' : '—', m ? `${mib(m.mem_total - m.mem_free)} de ${mib(m.mem_total)}` : wait, memPct >= 90 ? 'bad' : ''),
          statCard('Download WAN (Starlink)', m ? fmtMbps(m.wan_rx_mbps) : '—', m ? `tráfego ATUAL na ${m.wan_if || 'WAN'} — não é a capacidade da Starlink` : wait),
          statCard('Upload WAN', m ? fmtMbps(m.wan_tx_mbps) : '—', m ? `porta ${m.wan_if || '?'}` : wait),
          statCard('Para o Link1One', m ? fmtMbps(m.lan_tx_mbps) : '—', m ? `saindo pela ${m.lan_if || 'LAN'} · recebido ${fmtMbps(m.lan_rx_mbps)}` : wait),
          statCard('Sessões autenticadas', String(d.sessions_online ?? (m ? m.active : '—')), `${d.hosts_fresh} aparelho(s) vistos agora`),
          statCard('Uptime', m ? upFmt(Number(m.uptime_s)) : '—', 'desde a última inicialização'),
          statCard('Conexões', m && m.conns != null ? String(m.conns) : '—', `comandos pendentes: ${d.commands_open}`)),
        card('CPU e memória', h('div', null, lineChart(d.series, [{ key: 'cpu', label: 'CPU %', cls: 'a' }, { key: 'mem_used_pct', label: 'Memória usada %', cls: 'b' }], '%', 100),
          legend([{ label: 'CPU %', cls: 'a' }, { label: 'Memória usada %', cls: 'b' }]))),
        card('Starlink (WAN) e Link1One (LAN)', h('div', null, lineChart(d.series, [{ key: 'wan_rx', label: 'Download WAN', cls: 'a' }, { key: 'wan_tx', label: 'Upload WAN', cls: 'b' }, { key: 'lan_tx', label: 'Para o Link1One', cls: 'c' }], ''),
          legend([{ label: 'Download WAN (Mbps)', cls: 'a' }, { label: 'Upload WAN (Mbps)', cls: 'b' }, { label: 'Para o Link1One (Mbps)', cls: 'c' }]))),
        card('Diagnóstico da lentidão', h('div', null,
          table(['Medição', 'Valor', 'Fonte'], [
            ['CPU atual', m && m.cpu != null ? m.cpu + '%' : '—', m ? 'MikroTik (medido)' : wait],
            ['RAM disponível', m ? mib(m.mem_free) : '—', m ? 'MikroTik (medido)' : wait],
            ['Tráfego WAN agora', m ? `${fmtMbps(m.wan_rx_mbps)} ↓ / ${fmtMbps(m.wan_tx_mbps)} ↑` : '—', m ? `contadores da ${m.wan_if}` : wait],
            ['Tráfego LAN (Link1One)', m ? `${fmtMbps(m.lan_tx_mbps)} ↓ / ${fmtMbps(m.lan_rx_mbps)} ↑` : '—', m ? `contadores da ${m.lan_if}` : wait],
            ['Sessões / aparelhos', `${d.sessions_online ?? '—'} / ${d.hosts_fresh}`, 'Hotspot (medido)'],
            ['Portas', m ? (m.ports || []).map((p) => `${p.name}: ${p.running ? p.rate || 'ligada' : 'desligada'}`).join(' · ') : '—', m ? 'MikroTik (medido)' : wait],
            ['Limite de velocidade por usuário', 'nenhum (perfil sem rate-limit)', 'configuração verificada na instalação'],
          ].map((c) => ({ cells: c }))),
          h('p', { class: 'muted small', text: 'Como ler: tráfego WAN muito abaixo do que a Starlink entrega + CPU perto de 100% sugere o MikroTik como gargalo (hipótese). Tráfego WAN baixo com CPU folgada aponta para o Wi-Fi/Access Point ou para a Starlink (hipótese). Dados do Link1One (uso do rádio, interferência, CPU) não aparecem aqui: não há integração com esse equipamento.' })))
      );
    }
    async function load() {
      if (busy) return; busy = true; refreshBtn.disabled = true;
      try { render(await api('router_monitor', { minutes })); } catch (e) { out.replaceChildren(note('error', e.message)); } finally { busy = false; refreshBtn.disabled = false; }
    }
    slot.replaceChildren(h('div', { class: 'toolbar' }, h('div', { class: 'filters' }, sel), h('div', { class: 'toolbar-r' }, refreshBtn)), out);
    load(); every(load, 15000);
  }

  // ---- rotas ------------------------------------------------------------------------------------------------------------------
  function route() {
    runCleanups();
    if (!session || !me) { renderLogin(); return; }
    const path = currentPath();
    const titles = { '/admin': 'Ao vivo', '/admin/resumo': 'Resumo', '/admin/monitor': 'Monitor do MikroTik', '/admin/pagamentos': 'Pagamentos', '/admin/dispositivos': 'Créditos de horas (antigos)', '/admin/planos': 'Planos e preços', '/admin/relatorios': 'Relatórios', '/admin/config': 'Configurações' };
    const title = titles[path] || 'Ao vivo';
    document.title = title + ' • Wifi a Bordo';
    const views = { '/admin': liveView, '/admin/resumo': dashboardView, '/admin/monitor': monitorView, '/admin/pagamentos': paymentsView, '/admin/dispositivos': devicesView, '/admin/planos': plansView, '/admin/relatorios': reportsView, '/admin/config': configView };
    const view = views[path] || liveView;
    const state = loadPeriod();
    lazyView(title, (slot) => view(slot, state));
    window.scrollTo(0, 0);
  }
  async function start() {
    try {
      me = await api('whoami');
    } catch (e) {
      const denied = e.status === 403;
      saveSession(null); me = null;
      renderLogin(denied ? 'Este usuário não tem acesso ao painel.' : e.message);
      return;
    }
    route();
  }
  window.addEventListener('popstate', route);
  loadSession();
  if (!PKEY || !FN) { clear(root).append(h('p', { class: 'boot-text', text: 'Painel não configurado.' })); return; }
  root.className = '';
  if (session) start(); else renderLogin();
})();
