(() => {
  'use strict';
  const CFG = window.HOTSPOT_CONFIG || {};
  const API = String(CFG.functionsUrl || '').replace(/\/+$/, '');
  const mac = (new URLSearchParams(location.search).get('mac') || '').trim().toUpperCase();
  const MAC_OK = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac);
  const KEY = 'wifi-a-bordo:v2';
  const POLL_MS = 4000;
  const $ = (id) => document.getElementById(id);
  const PANELS = ['buy', 'pix', 'paid', 'done', 'ended', 'invalid'];

  let order = null;          // {order_id, read_token, qr_code, qr_code_base64, deadline}
  let pollTimer = null;
  let tickTimer = null;
  let checking = false;
  let failures = 0;
  let paidSince = 0;

  // ---- armazenamento (pode falhar em navegadores de portal cativo) ----------
  function store(name, value) {
    try { if (value == null) localStorage.removeItem(name); else localStorage.setItem(name, value); } catch (_) { /* ignora */ }
  }
  function load(name) { try { return localStorage.getItem(name); } catch (_) { return null; } }
  function saveOrder() { store(KEY, order ? JSON.stringify({ mac, ...order }) : null); }
  function recoverOrder() {
    try {
      const o = JSON.parse(load(KEY) || 'null');
      if (o && o.mac === mac && o.order_id && o.read_token) return o;
    } catch (_) { /* ignora */ }
    return null;
  }

  // ---- interface -----------------------------------------------------------
  function show(name) {
    PANELS.forEach((p) => { $(p).hidden = p !== name; });
    $('feedback').hidden = true;
  }
  function feedback(text) { $('feedback').textContent = text; $('feedback').hidden = false; }
  function setStatus(text, kind) {
    const el = $('status');
    el.textContent = text;
    el.className = 'state' + (kind ? ' ' + kind : '');
  }
  function stopTimers() { clearTimeout(pollTimer); clearInterval(tickTimer); pollTimer = tickTimer = null; }
  function fmt(sec) {
    const s = Math.max(0, Math.floor(sec));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function tick() {
    if (!order || !order.deadline) { $('timer').textContent = '--:--'; return; }
    $('timer').textContent = fmt((order.deadline - Date.now()) / 1000);
  }
  function setDeadline(secondsLeft) {
    if (order && typeof secondsLeft === 'number') { order.deadline = Date.now() + secondsLeft * 1000; saveOrder(); }
  }

  // ---- rede ----------------------------------------------------------------
  async function api(path, opts) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(API + '/' + path, { ...(opts || {}), signal: ctl.signal, cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(data.error || 'Falha na conexão.'); e.status = res.status; throw e; }
      return data;
    } catch (e) {
      if (e.status) throw e;
      const n = new Error('Sem conexão com o servidor. Verifique se está no 3TRC_Starlink e tente de novo.');
      n.network = true; throw n;
    } finally { clearTimeout(to); }
  }

  // ---- fluxo ---------------------------------------------------------------
  function enterPix() {
    show('pix');
    $('copytext').textContent = order.qr_code || '';
    $('copy').textContent = 'Copiar código Pix';
    const img = $('qr');
    if (order.qr_code_base64) { img.src = 'data:image/png;base64,' + order.qr_code_base64; img.hidden = false; } else { img.hidden = true; }
    setStatus('Aguardando confirmação do pagamento…');
    tick();
    clearInterval(tickTimer); tickTimer = setInterval(tick, 1000);
    schedule(0);
  }
  function enterPaid() {
    if (!paidSince) paidSince = Date.now();
    show('paid');
    $('paidhint').hidden = Date.now() - paidSince < 90000;
    clearInterval(tickTimer); tickTimer = null;
  }
  function enterDone() {
    stopTimers(); show('done');
    order = null; saveOrder();
  }
  function enterEnded(title, text) {
    stopTimers(); show('ended');
    $('endedtitle').textContent = title; $('endedtext').textContent = text;
    order = null; saveOrder();
  }
  function schedule(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(check, ms); }

  async function check() {
    if (!order || checking) return;
    checking = true;
    try {
      const s = await api(`payment-status?id=${encodeURIComponent(order.order_id)}&token=${encodeURIComponent(order.read_token)}`);
      failures = 0;
      if (s.internet_ready) { enterDone(); return; }
      if (s.status === 'paid') { enterPaid(); }
      else if (s.status === 'pending') {
        if (typeof s.seconds_left === 'number') setDeadline(s.seconds_left);
        if ($('pix').hidden) show('pix');
        setStatus('Aguardando confirmação do pagamento…');
      } else if (s.status === 'expired') { enterEnded('Pix expirado', 'Este código não vale mais. Gere um novo para continuar.'); return; }
      else if (s.status === 'failed') { enterEnded('Pagamento não concluído', 'O Pix não foi gerado ou foi recusado. Tente gerar um novo.'); return; }
      else if (s.status === 'refunded') { enterEnded('Pagamento estornado', 'Este pagamento foi devolvido. Procure o responsável pela internet.'); return; }
      schedule(POLL_MS);
    } catch (e) {
      failures += 1;
      if (e.status === 404) { enterEnded('Pedido não encontrado', 'Gere um novo Pix para continuar.'); return; }
      if (failures >= 3) {
        const msg = 'Não consegui falar com o servidor. Confira se continua no 3TRC_Starlink; vou tentar de novo.';
        if (!$('pix').hidden) setStatus(msg, 'error'); else feedback(msg);
      }
      schedule(Math.min(POLL_MS * (1 + failures), 20000));
    } finally { checking = false; }
  }

  async function createPix() {
    const email = $('email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { feedback('Informe um e-mail válido.'); $('email').focus(); return; }
    store(KEY + ':email', email);
    const btn = $('pay');
    btn.disabled = true; $('paylabel').textContent = 'Gerando Pix…';
    try {
      const r = await api('create-payment', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mac, email }),
      });
      order = { order_id: r.order_id, read_token: r.read_token, qr_code: r.qr_code || '', qr_code_base64: r.qr_code_base64 || '', deadline: 0 };
      if (typeof r.seconds_left === 'number') order.deadline = Date.now() + r.seconds_left * 1000;
      paidSince = 0; failures = 0;
      saveOrder();
      if (r.status === 'paid') { enterPaid(); schedule(0); } else enterPix();
    } catch (e) {
      feedback(e.message);
    } finally { btn.disabled = false; $('paylabel').textContent = 'Gerar Pix'; }
  }

  async function copyCode() {
    const text = order && order.qr_code;
    if (!text) return;
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); $('copy').textContent = 'Código copiado ✓'; return; }
    } catch (_) { /* tenta o método antigo */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'offscreen';
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy'); document.body.removeChild(ta);
      if (ok) { $('copy').textContent = 'Código copiado ✓'; return; }
    } catch (_) { /* cai para seleção manual */ }
    const range = document.createRange(); range.selectNodeContents($('copytext'));
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    $('copy').textContent = 'Código selecionado — toque e segure para copiar';
  }

  // ---- eventos -------------------------------------------------------------
  $('pay').addEventListener('click', createPix);
  $('copy').addEventListener('click', copyCode);
  $('recheck').addEventListener('click', () => { setStatus('Verificando…'); schedule(0); });
  $('again').addEventListener('click', () => { show('buy'); $('email').focus(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && order) schedule(0); });
  window.addEventListener('online', () => { if (order) schedule(0); });
  window.addEventListener('focus', () => { if (order) schedule(0); });

  // ---- início --------------------------------------------------------------
  if (!MAC_OK || !API || API.includes('SEU-PROJETO')) { show('invalid'); return; }
  $('email').value = load(KEY + ':email') || '';
  order = recoverOrder();
  if (order) { show('pix'); enterPix(); } else { show('buy'); }
})();
