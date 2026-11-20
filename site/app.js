(() => {
  'use strict';
  const CFG = window.HOTSPOT_CONFIG || {};
  const API = String(CFG.functionsUrl || '').replace(/\/+$/, '');
  const params = new URLSearchParams(location.search);
  const mac = (params.get('mac') || '').trim().toUpperCase();
  const MAC_OK = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac);
  // Dica do próprio Hotspot (login.html repassa $(error)): o login por MAC foi recusado por limite de tempo.
  const LIMIT_HINT = /uptime|limit/i.test(params.get('err') || '');
  const KEY = 'wifi-a-bordo:v2';
  const POLL_MS = 4000;     // acompanhando um Pix
  const WATCH_MS = 30000;   // acompanhando o crédito depois de liberado (portal aberto)
  const $ = (id) => document.getElementById(id);
  const PANELS = ['buy', 'pix', 'paid', 'done', 'ended', 'expired', 'loading', 'invalid'];

  let order = null;          // {order_id, read_token, qr_code, qr_code_base64, deadline, released}
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
  const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');

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
      const n = new Error('Sem conexão com o servidor. Verifique se está no Wifi a Bordo e tente de novo.');
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
  // Liberado: o pedido continua guardado (só o necessário para reconhecer este aparelho depois) e o
  // portal, se continuar aberto, acompanha o crédito para avisar quando o tempo acabar.
  function enterDone() {
    stopTimers(); show('done');
    if (order && !order.released) { order.released = true; saveOrder(); }
    schedule(WATCH_MS);
  }
  function enterLoading() { show('loading'); $('loadingtext').textContent = 'Verificando seu acesso…'; }
  // Tempo esgotado: confirmado pelo MikroTik (via backend) ou pelo próprio Hotspot. Nunca pelo navegador.
  function enterExpired() {
    stopTimers(); show('expired');
    $('buymore').disabled = false; $('buymorelabel').textContent = 'Comprar mais 5 horas';
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
      if (s.internet_ready) {
        if (s.device_credit === 'exhausted') { enterExpired(); return; }
        enterDone(); return;
      }
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
      if (e.status === 404) {                       // pedido não existe mais: trata como aparelho novo
        order = null; saveOrder(); stopTimers();
        if (LIMIT_HINT) enterExpired(); else show('buy');
        return;
      }
      if (!$('loading').hidden) {                   // abrindo o portal e sem falar com o servidor
        if (LIMIT_HINT) { enterExpired(); return; } // o Hotspot já informou que o limite foi atingido
        $('loadingtext').textContent = 'Não consegui verificar seu acesso agora. Tentando de novo…';
      } else if (failures >= 3) {
        const msg = 'Não consegui falar com o servidor. Confira se continua no Wifi a Bordo; vou tentar de novo.';
        if (!$('pix').hidden) setStatus(msg, 'error'); else if ($('done').hidden) feedback(msg);
      }
      schedule(Math.min(POLL_MS * (1 + failures), 20000));
    } finally { checking = false; }
  }

  // fromExpired: o botão "Comprar mais 5 horas" inicia o MESMO fluxo real de Pix (o servidor reaproveita
  // o Pix pendente do aparelho, então não há cobrança duplicada).
  async function createPix(fromExpired) {
    let email = $('email').value.trim();
    if (fromExpired) {
      email = (load(KEY + ':email') || '').trim();
      if (!validEmail(email)) { show('buy'); $('email').focus(); feedback('Informe seu e-mail para gerar o novo Pix.'); return; }
      $('email').value = email;
    }
    if (!validEmail(email)) { feedback('Informe um e-mail válido.'); $('email').focus(); return; }
    store(KEY + ':email', email);
    const btn = fromExpired ? $('buymore') : $('pay');
    const label = fromExpired ? $('buymorelabel') : $('paylabel');
    const idle = fromExpired ? 'Comprar mais 5 horas' : 'Gerar Pix';
    btn.disabled = true; label.textContent = 'Gerando Pix…';
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
    } finally { btn.disabled = false; label.textContent = idle; }
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
  $('pay').addEventListener('click', () => createPix(false));
  $('buymore').addEventListener('click', () => createPix(true));
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
  if (order && order.released) { enterLoading(); schedule(0); }       // já teve crédito: descobre o estado atual
  else if (order) { show('pix'); enterPix(); }                         // Pix em andamento
  else if (LIMIT_HINT) { enterExpired(); }                             // o Hotspot informou limite atingido
  else { show('buy'); }                                                // aparelho novo
})();
