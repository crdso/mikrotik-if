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
  }
  reboot() { this.busy = false; this.failedPolls = 0; this.acks = []; } // usuários e uptime persistem

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
      const r = await this.h.routerPull(undefined, 'text');
      if (r.status !== 200) { this.failedPolls++; return { ok: false, status: r.status }; }
      this.failedPolls = 0;
      for (const line of r.text.split('\n')) {
        if (!line.startsWith('G ')) continue;
        const o = RouterSim.parseLine(line);
        if (!o) { this.ignoredLines++; continue; }
        const tag = 'o:' + o.oid.slice(0, 8);
        const u = this.users.get(o.mac);
        if (!u) {
          this.users.set(o.mac, { limit: o.dur, uptime: 0, comment: tag });
        } else if (!u.comment.includes(tag)) {
          let newc = u.comment + ',' + tag;
          if (newc.length > 65) newc = newc.slice(newc.length - 65);
          u.limit += o.dur; u.comment = newc;
        }
        if (this.dropAcks > 0) { this.dropAcks--; continue; }
        this.acks.push((await this.h.routerAckForm(o.oid, o.mac)).status);
      }
      return { ok: true };
    } finally { this.busy = false; }
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
