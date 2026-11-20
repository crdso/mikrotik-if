// Evidência de "tempo esgotado" SEM histórico do navegador (iPhone/janela de portal cativo):
// o roteador grava hsx-<MAC>.txt (modelo RouterSim.flags) e o login.html REAL (executado aqui numa sandbox
// com XMLHttpRequest simulado) pergunta ao roteador só pelo MAC do próprio aparelho.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHarness, ROOT, MAC_A, MAC_B } from './helpers/harness.mjs';
import { RouterSim } from './helpers/router-sim.mjs';

const PORTAL = 'https://portal.example.test';
const html = readFileSync(path.join(ROOT, 'router/login.html'), 'utf8').replaceAll('https://SEU-SITE.netlify.app', PORTAL);
const scripts = [...html.matchAll(/<script(?![^>]*type="text\/plain")[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const loginJs = scripts[scripts.length - 1];

// Executa o script da página de login como o Hotspot a serviria (com $(mac)/$(error) preenchidos).
// xhr: 'flag' (usa router.flags), ou um comportamento fixo { status, body } | 'error' | 'timeout' | 'hang' | 'throw'.
function runLogin(mac, { router, xhr = 'flag', error = '' } = {}) {
  const code = loginJs.replaceAll('$(mac)', mac).replaceAll('$(error)', error);
  const timers = []; let finalUrl = null; let requested = null;
  class FakeXHR {
    open(method, url) { this.method = method; this.url = url; requested = url; }
    send() {
      if (xhr === 'throw') throw new Error('sem XHR');
      if (xhr === 'hang') return;
      queueMicrotask(() => {
        if (xhr === 'error') return this.onerror();
        if (xhr === 'timeout') return this.ontimeout();
        if (xhr === 'flag') {
          const m = /^\/hsx-([0-9A-F]{2}(?:-[0-9A-F]{2}){5})\.txt\?_=\d+$/.exec(this.url);
          const name = m ? m[1].replaceAll('-', ':') : null;
          this.status = 200;
          // sem o arquivo, o Hotspot redireciona para o login (HTML)
          this.responseText = name && router.flags.has(name) ? 'EXP' : '<html>login do Hotspot</html>';
        } else { this.status = xhr.status; this.responseText = xhr.body; }
        this.onload();
      });
    }
  }
  const ctx = {
    document: { getElementById: () => ({ textContent: error }) },
    location: { replace: (u) => { finalUrl = u; } },
    XMLHttpRequest: FakeXHR, encodeURIComponent, Date,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  };
  vm.runInNewContext(code, ctx);
  return {
    async settle() { await new Promise((r) => setImmediate(r)); return finalUrl; },
    fireTimeouts() { timers.forEach((t) => t.fn()); return finalUrl; },
    get requested() { return requested; },
  };
}
const finalOf = async (mac, opts) => { const r = runLogin(mac, opts); await r.settle(); return r.fireTimeouts(); };

let h; let router;
before(async () => { h = await createHarness(); await h.useLegacyPlan(); }); // modelo antigo de horas (pedidos históricos)
after(async () => { await h.close(); });
beforeEach(async () => {
  await h.q('delete from public.hotspot_orders');
  await h.q('delete from public.hotspot_device_credit');
  h.mp.reset(); h.state.failRpc = null;
  router = new RouterSim(h);
});

test('iPhone SEM histórico (sem order_id/token): crédito esgotado -> login.html leva ao portal com exp=1', async () => {
  await h.payOrder(MAC_A); await router.poll();
  router.use(MAC_A, 99 * 3600); await router.poll();
  assert.ok(router.flags.has(MAC_A), 'roteador gravou o aviso local');
  const url = await finalOf(MAC_A, { router });
  assert.equal(url, `${PORTAL}/?mac=${encodeURIComponent(MAC_A)}&exp=1`);
});

test('aparelho NOVO (nunca comprou): sem aviso -> sem exp (tela neutra de compra)', async () => {
  const url = await finalOf(MAC_B, { router });
  assert.equal(url, `${PORTAL}/?mac=${encodeURIComponent(MAC_B)}`);
});

test('crédito ATIVO: nunca recebe exp, mesmo consultando várias vezes', async () => {
  await h.payOrder(MAC_A); await router.poll(); router.use(MAC_A, 3600);
  for (let i = 0; i < 3; i++) await router.poll();
  assert.equal(router.flags.size, 0);
  assert.doesNotMatch(await finalOf(MAC_A, { router }), /exp=1/);
});

test('MAC PRIVADO: trocar de MAC = aparelho novo; o aviso é do MAC antigo e não vaza para o novo', async () => {
  await h.payOrder(MAC_A); await router.poll(); router.use(MAC_A, 99 * 3600); await router.poll();
  const novo = 'DE:16:0D:32:AF:F4';
  assert.doesNotMatch(await finalOf(novo, { router }), /exp=1/);
  assert.match(await finalOf(MAC_A, { router }), /exp=1/);
});

test('RETORNO após compra: o aviso some no próximo ciclo e o crédito soma sem duplicar', async () => {
  await h.payOrder(MAC_A); await router.poll(); router.use(MAC_A, 99 * 3600); await router.poll();
  assert.match(await finalOf(MAC_A, { router }), /exp=1/);
  await h.payOrder(MAC_A); await router.poll();
  assert.equal(router.flags.has(MAC_A), false, 'aviso removido ao creditar');
  assert.equal(router.remaining(MAC_A), 5 * 3600, 'só o novo crédito (5 h), sem duplicar');
  assert.doesNotMatch(await finalOf(MAC_A, { router }), /exp=1/);
  router.use(MAC_A, 99 * 3600); await router.poll(); // esgota de novo
  assert.match(await finalOf(MAC_A, { router }), /exp=1/);
});

test('REBOOT do roteador: o aviso (arquivo) persiste e o backend segue consistente', async () => {
  await h.payOrder(MAC_A); await router.poll(); router.use(MAC_A, 99 * 3600); await router.poll();
  router.reboot();
  assert.match(await finalOf(MAC_A, { router }), /exp=1/);
  await router.poll();
  assert.equal(await h.rpc('hotspot_device_credit_state', { p_mac: MAC_A }), 'exhausted');
});

test('limite aumentado pelo administrador (sem compra): o aviso é removido no ciclo seguinte', async () => {
  await h.payOrder(MAC_A); await router.poll(); router.use(MAC_A, 99 * 3600); await router.poll();
  router.users.get(MAC_A).limit += 3600; await router.poll();
  assert.equal(router.flags.has(MAC_A), false);
});

test('falhas do roteador/rede, demora, resposta estranha ou MAC inválido: segue SEM exp e nunca trava', async () => {
  const base = `${PORTAL}/?mac=${encodeURIComponent(MAC_A)}`;
  for (const xhr of ['error', 'timeout', 'throw', { status: 404, body: 'EXP' }, { status: 200, body: '<html>EXP</html>' }, { status: 200, body: 'EXPIRADO' }, { status: 200, body: 'exp' }]) {
    assert.equal(await finalOf(MAC_A, { router, xhr }), base, JSON.stringify(xhr));
  }
  const hang = runLogin(MAC_A, { router, xhr: 'hang' });
  assert.equal(await hang.settle(), null, 'ainda esperando');
  assert.equal(hang.fireTimeouts(), base, 'o temporizador de segurança encerra a espera');
  for (const bad of ['$(mac)', 'xx', ';alert(1);', '../../etc', '']) {
    const r = runLogin(bad, { router });
    assert.equal(r.requested, null, `não consulta arquivo para MAC inválido: ${bad}`);
  }
});

test('login.html: uma única navegação (sem loop) e só o arquivo do próprio MAC, no próprio roteador', async () => {
  await h.payOrder(MAC_A); await router.poll(); router.use(MAC_A, 99 * 3600); await router.poll();
  const r = runLogin(MAC_A, { router });
  assert.match(r.requested, /^\/hsx-[0-9A-F]{2}(-[0-9A-F]{2}){5}\.txt\?_=\d+$/, 'caminho relativo ao roteador, nome fixo por MAC');
  await r.settle(); const first = r.fireTimeouts(); const second = r.fireTimeouts();
  assert.equal(first, second);
});

test('a dica err do Hotspot continua valendo quando existir', async () => {
  const url = await finalOf(MAC_A, { router, xhr: 'error', error: 'your uptime limit is reached' });
  assert.equal(url, `${PORTAL}/?mac=${encodeURIComponent(MAC_A)}&err=${encodeURIComponent('your uptime limit is reached')}`);
});

test('portal: exp=1 (horas antigas esgotadas) só muda o texto da espera; o estado vem do servidor pelo próprio aparelho', () => {
  const js = readFileSync(path.join(ROOT, 'site/app.js'), 'utf8');
  assert.match(js, /params\.get\('exp'\) === '1'/);
  assert.match(js, /else if \(LIMIT_HINT\) msg = /);
  assert.doesNotMatch(js, /payment-status\?mac/, 'o pedido só é lido com id + token');
});
