// MODELO em JavaScript do algoritmo de router/hotspot-poll.rsc (NÃO é RouterOS).
// Reproduz o protocolo de TEXTO de largura fixa, a validação campo a campo, a
// idempotência por marcador no comentário, o ACK por formulário e a reinicialização.
// Serve para provar o CONTRATO com o backend e a lógica; os comandos RouterOS
// reais só podem ser validados num MikroTik de verdade.
const MAX_GRANT = 2 * 86400;

// Modelo de [:totime "5h0m0s"] (aceita a notação do RouterOS: 1w2d3h4m5s).
export function parseRosTime(text) {
  const m = /^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!m || text === '') return null;
  const [w, d, h, mi, s] = m.slice(1).map((x) => Number(x || 0));
  return (((w * 7 + d) * 24 + h) * 60 + mi) * 60 + s;
}

export class RouterSim {
  constructor(h) {
    this.h = h;
    this.users = new Map();   // name(MAC) -> {limit, uptime, comment}  (sobrevive ao reboot)
    this.online = true;       // sem internet/Starlink: a consulta falha
    this.dropAcks = 0;        // ACKs a perder (queda logo depois de creditar)
    this.failedPolls = 0;
    this.acks = [];
    this.ignoredLines = 0;
    this.busy = false;        // variável global (some no reboot)
    this.expSent = '';        // variável global wifiExpSent (some no reboot)
    this.expReports = [];     // avisos de esgotado enviados (para os testes)
    this.sessions = new Set(); // aparelhos com sessão autenticada no Hotspot agora (somem no reboot)
    this.telPosts = [];        // blocos de telemetria enviados (para os testes)
    this.flags = new Set();   // arquivos hsx-<MAC>.txt na pasta do Hotspot (sobrevivem ao reboot, como arquivos)
    // Modelo do Hotspot para o acesso de viagem: /ip hotspot host (presença) e o comportamento REAL que causou a falha:
    // o login por MAC só é tentado quando o host APARECE. Criar o usuário depois NÃO autentica sozinho.
    this.hostTable = new Map(); // MAC -> { ip }  (autenticado = this.sessions.has(MAC))
    this.loginCmdWorks = true;  // "/ip hotspot active login" aceito pelo RouterOS? (false = cai no plano B: remover o host)
    this.healDone = new Set(); this.healMax = 3;
    this.cmdAcks = [];          // {id, kind, mac, r, status}
    this.dropCmdAcks = 0;
    this.removedHosts = [];     // auditoria: hosts removidos pelo plano B
  }
  // Aparelho conecta ao Wi-Fi: entra em Hosts e o Hotspot tenta o login por MAC UMA vez.
  connect(mac, ip = `192.168.88.${100 + this.hostTable.size}`) {
    this.hostTable.set(mac, { ip });
    if (this.macLoginAllowed(mac)) this.sessions.add(mac);
  }
  disconnect(mac) { this.hostTable.delete(mac); this.sessions.delete(mac); }
  macLoginAllowed(mac) {
    const u = this.users.get(mac);
    return Boolean(u) && !u.disabled && (u.limit === 0 || u.uptime < u.limit);
  }
  heal(mac) {
    if (this.sessions.has(mac)) return 'auth';
    if (!this.hostTable.has(mac)) return 'nohost';
    if (this.loginCmdWorks) { if (this.macLoginAllowed(mac)) this.sessions.add(mac); }
    else { const ip = this.hostTable.get(mac).ip; this.removedHosts.push(mac); this.disconnect(mac); this.connect(mac, ip); } // o aparelho manda o próximo pacote
    return this.sessions.has(mac) ? 'auth' : 'login';
  }
  canBrowseNow(mac) { return this.hostTable.has(mac) && this.sessions.has(mac) && this.macLoginAllowed(mac); }
  reboot() { this.sessions.clear(); this.busy = false; this.failedPolls = 0; this.acks = []; this.expSent = ''; } // usuários e uptime persistem

  // Mesma lógica de fatiamento por posição do script.
  static parseLine(line) {
    if (line.length < 62 || line.length > 90 || line.slice(0, 2) !== 'G ') return null;
    const mac = line.slice(2, 19), oid = line.slice(20, 56);
    if (line[19] !== ' ' || line[56] !== ' ') return null;
    if (![2, 5, 8, 11, 14].every((p) => mac[p] === ':')) return null;
    if (![8, 13, 18, 23].every((p) => oid[p] === '-')) return null;
    const dur = parseRosTime(line.slice(57));
    if (dur === null || dur <= 0 || dur > MAX_GRANT) return null;
    return { mac, oid, dur };
  }

  async poll() {
    if (this.busy) return { ok: false, skipped: true };
    this.busy = true;
    try {
      if (!this.online) { this.failedPolls++; return { ok: false }; }
      // Espelha o X-Hosts do script: só envia a lista quando o teste a define (this.hosts = Set de MACs presentes).
      const hostsHdr = this.hostTable.size
        ? [...this.hostTable].map(([m, x]) => `${m.replaceAll(':', '-')}|${x.ip}|${this.sessions.has(m) ? 'a' : 'n'};`).join('')
        : (this.hosts ? [...this.hosts].map((m) => m + ';').join('') : null);
      const r = await this.h.routerPull(undefined, 'text', hostsHdr);
      if (r.status !== 200) { this.failedPolls++; return { ok: false, status: r.status }; }
      this.failedPolls = 0;
      for (const line of r.text.split('\n')) {
        if (line.startsWith('C ')) { await this.applyCommand(line); continue; }
        if (!line.startsWith('G ')) continue;
        const o = RouterSim.parseLine(line);
        if (!o) { this.ignoredLines++; continue; }
        const tag = 'o:' + o.oid.slice(0, 8);
        const u = this.users.get(o.mac);
        if (u && u.comment.includes('v:')) { // usuário de viagem: pedido antigo de horas não limita nem reativa
        } else if (!u) {
          this.users.set(o.mac, { limit: o.dur, uptime: 0, comment: tag });
        } else if (!u.comment.includes(tag)) {
          let newc = u.comment + ',' + tag;
          if (newc.length > 65) newc = newc.slice(newc.length - 65);
          u.limit += o.dur; u.comment = newc;
        }
        this.flags.delete(o.mac); // crédito novo/somado: o aviso de tempo esgotado deixa de valer (antes do ACK, como no script)
        if (this.dropAcks > 0) { this.dropAcks--; continue; }
        this.acks.push((await this.h.routerAckForm(o.oid, o.mac)).status);
      }
      this.healScan();
      await this.reportExhausted();
      return { ok: true };
    } finally { this.busy = false; }
  }

  // Espelha o bloco de comandos "C <id> <tipo> <MAC>" do script (mesmas posições).
  static parseCmd(line) {
    if (line.length < 58 || line.length > 66 || line.slice(0, 2) !== 'C ') return null;
    const id = line.slice(2, 38), k = line[39], mac = line.slice(41, 58);
    let cap = 0;
    if (k === 'L') { if (line[58] !== ' ' || !/^\d+$/.test(line.slice(59))) return null; cap = Number(line.slice(59)); if (cap <= 0 || cap > 2592000) return null; }
    else if (line.length !== 58) return null;
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) return null;
    if (line[38] !== ' ' || line[40] !== ' ') return null;
    if (![2, 5, 8, 11, 14].every((p) => mac[p] === ':')) return null;
    if (![8, 13, 18, 23].every((p) => id[p] === '-')) return null;
    if (!['G', 'L', 'R', 'K', 'A', 'T'].includes(k)) return null;
    return { id, k, mac, cap };
  }
  async applyCommand(line) {
    const c = RouterSim.parseCmd(line);
    if (!c) { this.ignoredLines++; return; }
    let res = 'err';
    if (c.k === 'G' || c.k === 'L') {
      let u = this.users.get(c.mac);
      if (!u) { u = { limit: 0, uptime: 0, comment: 'v:viagem', disabled: false }; this.users.set(c.mac, u); }
      else Object.assign(u, { limit: 0, comment: 'v:viagem', disabled: false });
      if (c.k === 'L') Object.assign(u, { limit: u.uptime + c.cap, comment: 'v:tempo' }); // teto de USO = restante
      this.flags.delete(c.mac); this.healDone.add(c.mac);
      res = this.heal(c.mac);
    } else if (c.k === 'T') {
      const u = this.users.get(c.mac);
      if (!u) { this.users.set(c.mac, { limit: 120, uptime: 0, comment: 't:pix', disabled: false }); res = this.heal(c.mac); }
      else if (u.comment === 't:pix' && !u.disabled) { u.limit = u.uptime + 120; this.sessions.delete(c.mac); res = this.heal(c.mac); }
      else if (u.disabled) { Object.assign(u, { disabled: false, comment: 't:pix', limit: u.uptime + 120 }); this.sessions.delete(c.mac); res = this.heal(c.mac); }
      else res = this.heal(c.mac);
    } else if (c.k === 'A') {
      const u = this.users.get(c.mac);
      if (u && !u.disabled) { this.healDone.add(c.mac); res = this.heal(c.mac); }
    } else if (c.k === 'R') {
      const u = this.users.get(c.mac); if (u) u.disabled = true;
      this.sessions.delete(c.mac); res = 'ok';
    } else if (c.k === 'K') {
      this.sessions.delete(c.mac); res = 'ok';
    }
    if (this.dropCmdAcks > 0) { this.dropCmdAcks--; return; }
    const a = await this.h.routerCmdAck(c.id, c.mac, res);
    this.cmdAcks.push({ id: c.id, kind: c.k, mac: c.mac, r: res, status: a.status });
  }
  // Espelha a reautenticação automática: hosts não autenticados com usuário ativo do Wifi a Bordo.
  healScan() {
    let n = 0;
    for (const mac of this.hostTable.keys()) {
      if (n >= this.healMax || this.sessions.has(mac) || this.healDone.has(mac)) continue;
      const u = this.users.get(mac);
      if (!u || u.disabled || !/[ov]:/.test(u.comment)) continue;
      if (!(u.limit === 0 || u.uptime < u.limit)) continue;
      this.healDone.add(mac); n++; this.heal(mac);
    }
  }
  healWindow() { this.healDone.clear(); } // passou healEvery (3 min)

  // Espelha o bloco "credito ESGOTADO" do script: avisa quem atingiu o limite, uma vez por esgotamento.
  async reportExhausted() {
    const keep = [], toRep = [];
    for (const [name, u] of this.users) {
      if (!u.comment.includes('o:')) continue;
      if (u.limit > 0 && name.length === 17 && u.uptime + 10 < u.limit) this.flags.delete(name); // voltou a ter crédito
      if (u.limit > 0 && u.uptime + 10 >= u.limit && name.length === 17) { // margem de 10 s (:local expMargin)
        this.flags.add(name); // grava/mantém o aviso local (hsx-<MAC>.txt = EXP), independe de já ter avisado o backend
        if (!this.expSent.includes(name)) { if (toRep.length < 10) toRep.push(name); } else keep.push(name);
      }
    }
    if (toRep.length) {
      const r = await this.h.routerReportExpired(toRep.join(',') + ',');
      this.expReports.push({ macs: toRep, status: r.status });
      if (r.status === 200) keep.push(...toRep); // se falhar, tenta de novo no próximo ciclo
    }
    this.expSent = keep.length ? keep.join(',') + ',' : '';
  }

  // Espelha o bloco de TELEMETRIA do script: "MAC_IP_uso_limite_A" em blocos de até 10, formato de tempo hh:mm:ss.
  async telemetry(ipOf = (i) => `192.168.88.${10 + i}`) {
    const fmt = (t) => `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    const entries = []; let i = 0;
    for (const [name, u] of this.users) {
      if (!/[ov]:/.test(u.comment) || name.length !== 17) continue;
      const act = this.sessions.has(name);
      entries.push(`${name}_${act ? ipOf(i) : ''}_${fmt(u.uptime)}_${fmt(u.limit)}_${act ? 1 : 0}`); i++;
    }
    const blocks = []; for (let k = 0; k < entries.length; k += 10) blocks.push(entries.slice(k, k + 10));
    if (!blocks.length) blocks.push([]);
    for (const b of blocks) {
      const r = await this.h.routerTelemetry(b.join(',') + (b.length ? ',' : ''), this.sessions.size);
      this.telPosts.push({ entries: b.length, status: r.status });
    }
  }

  // O passageiro usa N segundos (o Hotspot corta no limit-uptime).
  use(mac, seconds) {
    const u = this.users.get(mac);
    if (!u) return 0;
    const used = Math.min(Math.max(0, u.limit - u.uptime), seconds);
    u.uptime += used;
    return used;
  }
  canBrowse(mac) { const u = this.users.get(mac); return Boolean(u) && u.uptime < u.limit; }
  remaining(mac) { const u = this.users.get(mac); return u ? u.limit - u.uptime : 0; }
}
