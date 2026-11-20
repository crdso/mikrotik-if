// @ts-nocheck
// Planos ativos para o portal do passageiro (somente leitura, dados públicos do plano).
// O preço mostrado é informativo: quem decide o valor cobrado é o create-payment, a partir do banco.
import { browserAllowed, cors, json, preflight, rpc } from '../_shared/common.ts';

export async function handler(req) {
  const pf = preflight(req); if (pf) return pf;
  const headers = cors(req);
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);
  if (!browserAllowed(req)) return json({ error: 'Forbidden origin' }, 403, headers);
  try {
    const plans = await rpc('hotspot_public_plans');
    return json({ plans: Array.isArray(plans) ? plans : [] }, 200, headers);
  } catch (e) {
    console.error('plans', String(e));
    return json({ error: 'Não foi possível carregar os planos' }, 500, headers);
  }
}

Deno.serve(handler);
