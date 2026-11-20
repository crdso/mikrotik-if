(() => {
  'use strict';
  // Portal do passageiro. TODO estado vem do servidor (função "passenger" para o aparelho, "payment-status" para o
  // Pix); nada depende de armazenamento no navegador. Fechar a janela do portal cativo para pagar no app do banco, reabrir o portal,
  // trocar de navegador ou recarregar não perde o cadastro, o Pix nem a liberação, e nunca gera segunda cobrança
  // (o servidor devolve o MESMO Pix pendente do aparelho).
  const CFG = window.HOTSPOT_CONFIG || {};
  const API = String(CFG.functionsUrl || '').replace(/\/+$/, '');
  const params = new URLSearchParams(location.search);
  const mac = (params.get('mac') || '').trim().toUpperCase();
  const MAC_OK = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac);
  // Dica do Hotspot (login.html): crédito de HORAS antigo esgotado. Só muda o texto da espera.
  const LIMIT_HINT = /uptime|limit/i.test(params.get('err') || '') || params.get('exp') === '1';
  const $ = (id) => document.getElementById(id);
  const PANELS = ['loading', 'reg', 'wait', 'pix', 'paid', 'done', 'ended', 'invalid'];
  const WAIT_MS = 5000;     // tela de espera: acompanha a liberação manual / Pix
  const FAST_MS = 3000;     // Pix aberto ou liberando
  const DONE_MS = 30000;    // já liberado (portal aberto): acompanha revogação/bloqueio

  let state = null;          // último estado do servidor
  let order = null;          // Pix em memória: {order_id, read_token, qr_code, qr_code_base64, deadline}
  let timer = null; let tick = null; let busy = false; let failures = 0; let provSince = 0;
  let unknownSince = 0;
  let editing = false;
  let price = 'R$ 25,00';
  const TEST_PLAN = /^[0-9a-f-]{36}$/i.test(params.get('plano') || '') ? params.get('plano').toLowerCase() : '';
  let testPlanId = '';

  // ---- interface -----------------------------------------------------------
  function show(name) { PANELS.forEach((p) => { $(p).hidden = p !== name; }); $('feedback').hidden = true; }
  const current = () => PANELS.find((p) => !$(p).hidden);
  function feedback(text) { $('feedback').textContent = text; $('feedback').hidden = false; }
  function setText(id, text, kind) { const el = $(id); el.textContent = text; el.className = 'state' + (kind ? ' ' + kind : ''); }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(refresh, ms); }
  const money = (c) => 'R$ ' + (Number(c) / 100).toFixed(2).replace('.', ',');
  const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '') && (e || '').length <= 254;
  const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim();
  function validName(n) {
    if (n.length < 5 || n.length > 80) return false;
    try { if (!/^\p{L}[\p{L}\p{M}'’.\- ]*$/u.test(n)) return false; } catch (_) { if (/[0-9<>@#$%^&*=+|\\/]/.test(n)) return false; }
    const w = n.split(' ');
    return w.length >= 2 && w[0].length >= 2 && w[w.length - 1].length >= 2;
  }
  function fmt(sec) {
    const s = Math.max(0, Math.floor(sec));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function tickTimer() { $('timer').textContent = order && order.deadline ? fmt((order.deadline - Date.now()) / 1000) : '--:--'; }

  // ---- rede ----------------------------------------------------------------
  async function api(path, opts) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(API + '/' + path, { ...(opts || {}), signal: ctl.signal, cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(data.error || 'Falha na conexão.'); e.status = res.status; e.data = data; throw e; }
      return data;
    } catch (e) {
      if (e.status) throw e;
      const n = new Error('Sem conexão com o servidor. Verifique se está no Wifi a Bordo e tente de novo.');
      n.network = true; throw n;
    } finally { clearTimeout(to); }
  }
  const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // ---- telas ----------------------------------------------------------------
  function enterReg(edit) {
    editing = Boolean(edit);
    show('reg');
    $('regcancel').hidden = !editing;
    $('regsub').textContent = editing ? 'Corrija seu nome completo e e-mail.' : 'Informe seu nome completo e e-mail.';
  }
  function enterWait(s) {
    if (current() !== 'wait') show('wait');
    $('whotext').textContent = s.name_hint ? s.name_hint + ' · ' + (s.email_hint || '') : 'Cadastro recebido';
    let msg = 'Aguardando o organizador conferir seu cadastro…';
    if (s.pix_pending) msg = 'Você tem um Pix gerado e ainda não pago. Toque no botão para ver o mesmo código (não gera outro).';
    else if (LIMIT_HINT) msg = 'Seu tempo de internet anterior acabou. Aguarde a liberação ou use o Pix abaixo.';
    if (!s.router_online) msg += ' (O roteador está sem contato com o servidor agora; a liberação acontece assim que ele voltar.)';
    setText('waitstate', msg);
    $('paylabel').textContent = s.pix_pending ? 'Ver meu Pix pendente' : 'Pagar ' + price + ' com Pix';
    $('pay').disabled = false;
  }
  function enterPix() {
    show('pix');
    $('pixtitle').textContent = 'Seu Pix de ' + price;
    $('copytext').textContent = order.qr_code || '';
    $('copy').textContent = 'Copiar código Pix';
    const img = $('qr');
    if (order.qr_code_base64) { img.src = 'data:image/png;base64,' + order.qr_code_base64; img.hidden = false; } else { img.hidden = true; }
    setText('status', 'Aguardando confirmação do pagamento…');
    tickTimer(); clearInterval(tick); tick = setInterval(tickTimer, 1000);
  }
  function enterProvisioning(s, paidByPix) {
    if (!provSince) provSince = Date.now();
    if (current() !== 'paid') show('paid');
    clearInterval(tick);
    $('paidtitle').textContent = paidByPix ? 'Pagamento confirmado!' : 'Liberando seu acesso…';
    $('paidtext').textContent = s && !s.router_online
      ? 'Seu acesso foi autorizado. O roteador está sem contato com o servidor agora; a internet é ativada assim que ele voltar.'
      : 'Seu acesso foi autorizado. Estamos ativando a internet neste aparelho (até ~30 segundos).';
    $('paidhint').hidden = Date.now() - provSince < 75000 && !(s && s.stuck && Date.now() - provSince > 40000);
  }
  function enterDone() { clearInterval(tick); order = null; show('done'); }
  function enterEnded(title, text) { clearInterval(tick); order = null; show('ended'); $('endedtitle').textContent = title; $('endedtext').textContent = text; }

  // ---- ciclo de estado --------------------------------------------------------
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      // Pix aberto: confere o pedido (o servidor reconcilia com o Mercado Pago se o webhook atrasar).
      if (order && current() === 'pix') {
        try {
          const p = await api('payment-status?id=' + encodeURIComponent(order.order_id) + '&token=' + encodeURIComponent(order.read_token));
          if (typeof p.seconds_left === 'number') order.deadline = Date.now() + p.seconds_left * 1000;
          if (p.status === 'expired' || p.status === 'failed') { order = null; feedback('Este Pix não vale mais. Gere um novo quando quiser.'); }
          else if (p.status === 'refunded') { order = null; }
        } catch (e) { if (e.status === 404) order = null; }
      }
      const s = await api('passenger?mac=' + encodeURIComponent(mac));
      state = s; failures = 0;
      route(s);
    } catch (e) {
      failures += 1;
      if (current() === 'loading') $('loadingtext').textContent = 'Não consegui verificar seu acesso agora. Tentando de novo…';
      else if (failures >= 3 && current() !== 'done') feedback('Não consegui falar com o servidor. Confira se continua no Wifi a Bordo; vou tentar de novo.');
      schedule(Math.min(FAST_MS * (1 + failures), 20000));
    } finally { busy = false; }
  }

  function route(s) {
    if (s.access === 'blocked') { enterEnded('Aparelho bloqueado', 'Este aparelho foi bloqueado pelo organizador da viagem e não pode usar a internet. Fale com o organizador.'); return schedule(DONE_MS); }
    if (s.access === 'revoked') { enterEnded('Acesso encerrado', 'O acesso deste aparelho foi encerrado pelo organizador da viagem. Nenhuma cobrança nova é feita aqui; fale com o organizador.'); return schedule(DONE_MS); }
    if (s.access === 'active' && s.internet) { enterDone(); return schedule(DONE_MS); }
    if (s.access === 'active' || s.access === 'provisioning') { enterProvisioning(s, Boolean(order)); return schedule(FAST_MS); }
    provSince = 0;
    if (!s.known) {
      // O roteador ainda não informou este aparelho (acabou de conectar): espera alguns ciclos antes do cadastro.
      if (!unknownSince) unknownSince = Date.now();
      if (Date.now() - unknownSince < 45000 && current() === 'loading') { $('loadingtext').textContent = 'Identificando seu aparelho na rede…'; return schedule(FAST_MS); }
    }
    if (editing && current() === 'reg') return schedule(WAIT_MS);
    if (!s.registered) { if (current() !== 'reg') enterReg(false); return schedule(WAIT_MS); }
    if (order && current() === 'pix') return schedule(FAST_MS);
    if (s.pix_pending && current() === 'loading') { openPix(true); return undefined; } // reabriu o portal com Pix em aberto
    enterWait(s);
    return schedule(WAIT_MS);
  }

  // ---- ações -------------------------------------------------------------------
  async function saveReg() {
    const name = cleanName($('fullname').value);
    const email = $('regemail').value.trim().toLowerCase();
    if (!validName(name)) { feedback('Informe seu nome completo (nome e sobrenome), só com letras.'); $('fullname').focus(); return; }
    if (!validEmail(email)) { feedback('Informe um e-mail válido.'); $('regemail').focus(); return; }
    $('regsave').disabled = true; $('reglabel').textContent = 'Salvando…';
    try {
      await post('passenger', { mac, name, email });
      editing = false;
      show('loading'); $('loadingtext').textContent = 'Cadastro recebido…';
      await refresh();
    } catch (e) {
      feedback(e.message);
    } finally { $('regsave').disabled = false; $('reglabel').textContent = 'Continuar'; }
  }

  async function openPix(silent) {
    $('pay').disabled = true; $('paylabel').textContent = 'Gerando Pix…';
    try {
      // Link de teste (?plano=<id>): envia SÓ o identificador; preço e produto continuam decididos pelo servidor.
      const r = await post('create-payment', testPlanId ? { mac, plan_id: testPlanId } : { mac });
      if (r.status === 'paid') { order = { order_id: r.order_id, read_token: r.read_token }; enterProvisioning(state, true); schedule(FAST_MS); return; }
      order = { order_id: r.order_id, read_token: r.read_token, qr_code: r.qr_code, qr_code_base64: r.qr_code_base64,
        deadline: typeof r.seconds_left === 'number' ? Date.now() + r.seconds_left * 1000 : null };
      enterPix(); schedule(FAST_MS);
      setText('status', 'Você ganhou 2 minutos de internet (liberados em até ~20 s) para abrir o app do banco e pagar. Se não pagar nesse tempo, a internet volta a ficar bloqueada.');
    } catch (e) {
      if (e.data && e.data.registration_required) { enterReg(false); return; }
      if (e.data && (e.data.already_active || e.data.blocked || e.data.revoked)) { schedule(0); return; }
      if (state) enterWait(state); else show('loading');
      if (!silent) feedback(e.message); // depois de trocar de tela (show() esconde o aviso)
      schedule(e.data && e.data.retry ? FAST_MS : WAIT_MS);
    } finally { $('pay').disabled = false; if (state) $('paylabel').textContent = state.pix_pending ? 'Ver meu Pix pendente' : 'Pagar ' + price + ' com Pix'; }
  }

  async function copyPix() {
    const text = (order && order.qr_code) || '';
    let ok = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; } } catch (_) { ok = false; }
    if (!ok) {
      try {
        const r = document.createRange(); r.selectNodeContents($('copytext'));
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        ok = document.execCommand('copy');
      } catch (_) { ok = false; }
    }
    $('copy').textContent = ok ? 'Código copiado!' : 'Selecione e copie o código abaixo';
  }

  // Todos os planos ativos aparecem para o passageiro escolher. O navegador envia só o identificador do plano
  // escolhido; preço e produto são decididos pelo servidor.
  const planText = (p) => (p.unlimited ? 'toda a viagem' : String(Math.round(p.grant_seconds / 3600)) + ' horas');
  function choosePlan(p) {
    testPlanId = p.id; price = money(p.price_cents);
    $('pricea').textContent = price; $('pricetext').textContent = planText(p);
    [...$('plans').children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === p.id)));
    if (state && current() === 'wait') enterWait(state);
  }
  async function loadPrice() {
    try {
      const r = await api('plans');
      const all = r.plans || [];
      const box = $('plans'); box.textContent = '';
      for (const p of all) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'plan-opt'; b.dataset.id = p.id;
        b.textContent = money(p.price_cents) + ' — ' + p.name;
        b.addEventListener('click', () => choosePlan(p));
        box.appendChild(b);
      }
      box.hidden = all.length < 2;
      const p = (TEST_PLAN && all.find((x) => x.id === TEST_PLAN)) || all.find((x) => x.is_default) || all[0];
      if (p) choosePlan(p);
    } catch (_) { /* mantém o texto padrão */ }
  }

  // ---- início ------------------------------------------------------------------
  $('regsave').addEventListener('click', saveReg);
  $('regemail').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveReg(); });
  $('regcancel').addEventListener('click', () => { editing = false; if (state) route(state); });
  $('editreg').addEventListener('click', () => enterReg(true));
  $('pay').addEventListener('click', () => openPix(false));
  $('copy').addEventListener('click', copyPix);
  $('recheck').addEventListener('click', () => { setText('status', 'Verificando…'); schedule(0); });
  $('backwait').addEventListener('click', () => { clearInterval(tick); if (state) enterWait(state); schedule(WAIT_MS); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(0); }); // voltou do app do banco

  if (!MAC_OK || !API) { show('invalid'); return; }
  show('loading');
  loadPrice();
  refresh();
})();
