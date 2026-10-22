/**
 * POST /api/tendencias — pesquisa diária de tendências de peças impressas em 3D.
 *
 * Variáveis de ambiente (Vercel):
 *   ANTHROPIC_API_KEY  chave da API da Anthropic (console.anthropic.com) — obrigatória
 *
 * Duas etapas:
 *   1. Pesquisa na internet (ferramenta de busca do Claude) com fontes reais.
 *   2. Estruturação da pesquisa em JSON validado (sem busca). As URLs aceitas são
 *      só as que apareceram nos resultados da etapa 1: o servidor descarta
 *      qualquer link que não veio da busca.
 * Custos/margens NÃO são calculados aqui: o app calcula com os parâmetros reais.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { HttpError, env, handle, json, requireMember } from './_lib/http.js';

const MODEL = 'claude-opus-5-5';
const BETAS = ['server-side-fallback-2026-07-01'];

const IdeaSchema = z.object({
  title: z.string(),
  category: z.string(),
  why: z.string(),
  audience: z.string(),
  priceMin: z.number().nullable(),
  priceMax: z.number().nullable(),
  estWeightG: z.number().nullable(),
  estPrintHours: z.number().nullable(),
  material: z.string(),
  difficulty: z.enum(['baixa', 'media', 'alta']),
  licenseNote: z.string(),
  sourceUrls: z.array(z.string()),
});
const ReportSchema = z.object({ summary: z.string(), ideas: z.array(IdeaSchema) });

const SYSTEM = `Você é analista de mercado de uma pequena empresa brasileira de impressão 3D (Ideia Cúbica).
Equipamento: Bambu Lab A1 (mesa 256 × 256 × 256 mm, um bico, AMS lite opcional para até 4 cores). Materiais: PLA e PETG.
Canais de venda: Instagram, venda direta, Mercado Livre e Shopee.
Objetivo: encontrar peças com demanda atual e bom retorno financeiro (preço de venda alto em relação a peso de filamento e horas de máquina).
Regras: use apenas informações que você encontrou na busca, cite as fontes, diga quando um número é estimativa, em português do Brasil.
Evite produtos que violem marcas registradas/licenças (personagens, logos de times) ou que sejam armas e itens regulados.`;

function researchPrompt(today: string, avoid: string[]) {
  return `Hoje é ${today}. Pesquise na internet as tendências mais recentes (últimas semanas) de produtos impressos em 3D que estão vendendo bem,
priorizando o Brasil (Mercado Livre, Shopee, Instagram/TikTok BR) e usando referências globais (MakerWorld trending, Printables, Etsy) quando ajudarem.

Liste de 8 a 12 ideias de peças viáveis na Bambu Lab A1. Para cada uma informe:
- nome da peça e categoria (decoração, organização, presentes, utilidades, brinquedos articulados, etc.);
- por que está em alta (evidência encontrada);
- público e ocasião;
- faixa de preço praticada no Brasil em R$ (somente se encontrou anúncios; senão diga que não encontrou);
- estimativa de peso de filamento (g) e tempo de impressão na A1 (h) por peça — deixe claro que é estimativa;
- material recomendado e dificuldade de produção;
- observação de licença (modelo próprio, licença comercial no MakerWorld, ou risco de marca);
- links das fontes.
${avoid.length ? `Evite repetir estas ideias de dias anteriores, a menos que haja novidade relevante: ${avoid.join('; ')}.` : ''}`;
}

/** URLs vistas na busca (resultados e citações). */
function collectUrls(content: Anthropic.Beta.BetaContentBlock[]): Map<string, string> {
  const urls = new Map<string, string>();
  for (const block of content) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) if (r.type === 'web_search_result') urls.set(r.url, r.title ?? r.url);
    }
    if (block.type === 'text') {
      for (const c of block.citations ?? []) {
        if ('url' in c && typeof c.url === 'string') urls.set(c.url, ('title' in c && typeof c.title === 'string' && c.title) || c.url);
      }
    }
  }
  return urls;
}

const servedByFallback = (m: Anthropic.Beta.BetaMessage) =>
  (m.usage.iterations ?? []).some((it) => (it as { type?: string }).type === 'fallback_message');

export const POST = handle(async (request) => {
  await requireMember(request);
  const apiKey = env('ANTHROPIC_API_KEY');
  if (!apiKey) throw new HttpError(503, 'Pesquisa de tendências não configurada: cadastre ANTHROPIC_API_KEY nas variáveis de ambiente da Vercel.');
  const body = (await request.json().catch(() => ({}))) as { today?: string; avoid?: unknown };
  const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today ?? '') ? body.today! : new Date().toISOString().slice(0, 10);
  const avoid = Array.isArray(body.avoid) ? body.avoid.filter((x): x is string => typeof x === 'string').slice(0, 30).map((s) => s.slice(0, 80)) : [];

  const client = new Anthropic({ apiKey, maxRetries: 2 });
  let fallbackUsed = false;

  // 1. Pesquisa com busca na web (retoma se o servidor pausar o turno).
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: researchPrompt(today, avoid) }];
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  let research: Anthropic.Beta.BetaMessage | null = null;
  for (let i = 0; i < 4; i++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: BETAS,
      fallbacks: 'default',
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }],
      messages,
    });
    research = await stream.finalMessage();
    content.push(...research.content);
    fallbackUsed ||= servedByFallback(research);
    if (research.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: research.content });
  }
  if (!research) throw new HttpError(502, 'A pesquisa não retornou resultado.');
  if (research.stop_reason === 'refusal') throw new HttpError(502, 'O modelo recusou a pesquisa. Tente novamente mais tarde.');

  const notes = content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
  const urls = collectUrls(content);
  if (!notes) throw new HttpError(502, 'A pesquisa voltou vazia. Tente novamente.');

  // 2. Estruturação em JSON validado, usando somente o texto da pesquisa.
  const structured = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 12000,
    betas: BETAS,
    fallbacks: 'default',
    output_config: { effort: 'low', format: betaZodOutputFormat(ReportSchema) },
    messages: [{
      role: 'user',
      content: `Organize a pesquisa abaixo em JSON. Não acrescente fatos novos. Use null quando um número não foi informado.
"summary": 2 a 3 frases em português com o panorama do dia. Preços em R$ (número), peso em gramas, tempo em horas decimais.
"sourceUrls": apenas URLs desta lista, as que sustentam cada ideia:
${[...urls.keys()].slice(0, 120).join('\n')}

PESQUISA:
${notes}`,
    }],
  });
  fallbackUsed ||= servedByFallback(structured);
  const parsed = structured.parsed_output;
  if (!parsed) throw new HttpError(502, 'Não foi possível organizar a pesquisa. Tente novamente.');

  const ideas = parsed.ideas.slice(0, 15).map(({ sourceUrls, ...idea }) => ({
    ...idea,
    sources: sourceUrls.filter((u) => urls.has(u)).slice(0, 5).map((u) => ({ url: u, title: urls.get(u)! })),
  }));
  return json({
    date: today,
    model: structured.model,
    summary: parsed.summary,
    ideas,
    notice: fallbackUsed ? 'Parte desta pesquisa foi atendida por um modelo alternativo da Anthropic (fallback automático).' : undefined,
  });
});
