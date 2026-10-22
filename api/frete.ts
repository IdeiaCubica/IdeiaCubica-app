/**
 * POST /api/frete — cotação de frete na SuperFrete.
 *
 * Variáveis de ambiente (Vercel → Settings → Environment Variables):
 *   SUPERFRETE_TOKEN     token gerado em web.superfrete.com → Integrações → Desenvolvedores (obrigatório)
 *   SUPERFRETE_BASE_URL  opcional; padrão https://api.superfrete.com (sandbox: https://sandbox.superfrete.com)
 *
 * Corpo: { from: "01001000", to: "20040002", package: { weightKg, lengthCm, widthCm, heightCm }, insuranceValue?, services? }
 * Resposta: { options: [{ id, name, company, price, discount, deliveryMin, deliveryMax, error? }] }
 */
import { HttpError, env, handle, json, requireMember } from './_lib/http.js';

interface QuoteBody {
  from?: string;
  to?: string;
  package?: { weightKg?: number; lengthCm?: number; widthCm?: number; heightCm?: number };
  insuranceValue?: number;
  services?: string;
}

interface SuperFreteOption {
  id: number;
  name: string;
  price?: number | string;
  discount?: number | string;
  delivery_time?: number;
  delivery_range?: { min?: number; max?: number };
  company?: { name?: string };
  error?: string;
  has_error?: boolean;
}

const cep = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const positive = (v: unknown, label: string, max: number) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `Informe ${label}.`);
  if (n > max) throw new HttpError(400, `${label[0].toUpperCase()}${label.slice(1)} acima do limite (${max}).`);
  return n;
};

export const POST = handle(async (request) => {
  await requireMember(request);
  const token = env('SUPERFRETE_TOKEN');
  if (!token) throw new HttpError(503, 'Integração SuperFrete não configurada: cadastre SUPERFRETE_TOKEN nas variáveis de ambiente da Vercel.');

  const body = (await request.json().catch(() => ({}))) as QuoteBody;
  const from = cep(body.from), to = cep(body.to);
  if (from.length !== 8) throw new HttpError(400, 'CEP de origem inválido. Cadastre o endereço da empresa em Parâmetros de Custos → Gerais → Envios.');
  if (to.length !== 8) throw new HttpError(400, 'CEP de destino inválido. Confira o CEP do cliente.');
  const p = body.package ?? {};
  const pkg = {
    weight: positive(p.weightKg, 'o peso do pacote (kg)', 30),
    length: positive(p.lengthCm, 'o comprimento da caixa (cm)', 100),
    width: positive(p.widthCm, 'a largura da caixa (cm)', 100),
    height: positive(p.heightCm, 'a altura da caixa (cm)', 100),
  };
  const insurance = Number(body.insuranceValue ?? 0);
  const services = /^[\d,]+$/.test(body.services ?? '') ? body.services! : '1,2,17';

  const base = (env('SUPERFRETE_BASE_URL') ?? 'https://api.superfrete.com').replace(/\/+$/, '');
  const res = await fetch(`${base}/api/v0/calculator`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'IdeiaCubica-Gestao/1.1 (contato via github.com/IdeiaCubica)',
    },
    body: JSON.stringify({
      from: { postal_code: from },
      to: { postal_code: to },
      services,
      options: { own_hand: false, receipt: false, insurance_value: insurance > 0 ? insurance : 0, use_insurance_value: insurance > 0 },
      package: pkg,
    }),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'A SuperFrete recusou o token. Gere um novo token e atualize SUPERFRETE_TOKEN na Vercel.');
  if (!res.ok) throw new HttpError(502, `A SuperFrete respondeu com erro (${res.status}). ${text.slice(0, 200)}`);

  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new HttpError(502, 'Resposta inesperada da SuperFrete.'); }
  const list = (Array.isArray(data) ? data : []) as SuperFreteOption[];
  const options = list.map((o) => ({
    id: o.id,
    name: o.name,
    company: o.company?.name ?? '',
    price: o.price !== undefined && o.price !== null && o.price !== '' ? String(o.price) : null,
    discount: o.discount !== undefined && o.discount !== null ? String(o.discount) : null,
    deliveryMin: o.delivery_range?.min ?? o.delivery_time ?? null,
    deliveryMax: o.delivery_range?.max ?? o.delivery_time ?? null,
    error: o.has_error || o.error ? (o.error || 'Serviço indisponível para este trecho/pacote.') : undefined,
  }));
  return json({ options, package: pkg, from, to });
});
