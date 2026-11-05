/**
 * GET /api/catalogo-foto?c=<link>&i=<id da foto> — foto de um catálogo publicado.
 *
 * Antes, cada visitante buscava cada foto direto no banco (texto base64 de centenas de KB),
 * o que pesava na CPU do banco a cada acesso. Agora a foto passa por aqui e fica guardada no
 * cache da Vercel e do navegador: o banco é consultado no máximo algumas vezes por dia por foto.
 *
 * O banco continua decidindo se a foto pode ser vista (link ativo, dentro da validade e a foto faz
 * parte daquela publicação). O id é o SHA-256 do conteúdo, então a mesma URL é sempre a mesma foto.
 */
import { env, handle, json } from './_lib/http.js';

export const GET = handle(async (request) => {
  const q = new URL(request.url).searchParams;
  const slug = q.get('c') ?? '';
  const id = q.get('i') ?? '';
  if (!/^[a-z0-9]{10,32}$/.test(slug) || !/^[0-9a-f]{64}$/.test(id)) return json({ error: 'Foto não encontrada.' }, 404);
  const url = env('SUPABASE_URL', 'VITE_SUPABASE_URL');
  const anon = env('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY');
  if (!url || !anon) return json({ error: 'Servidor sem configuração do Supabase.' }, 500);

  const res = await fetch(`${url}/rest/v1/rpc/get_public_catalog_image`, {
    method: 'POST',
    headers: { apikey: anon, authorization: `Bearer ${anon}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_slug: slug, p_id: id }),
  });
  if (!res.ok) return json({ error: 'Foto indisponível no momento.' }, 503);
  const dataUrl = (await res.json()) as string | null;
  const m = typeof dataUrl === 'string' ? dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i) : null;
  if (!m) return new Response('Foto não encontrada', { status: 404, headers: { 'cache-control': 'public, max-age=60' } });
  return new Response(Buffer.from(m[2], 'base64'), {
    status: 200,
    headers: {
      'content-type': m[1],
      // Navegador: 1 dia. CDN da Vercel: 6 horas (depois disso confere de novo a validade do link).
      'cache-control': 'public, max-age=86400, s-maxage=21600, stale-while-revalidate=3600',
      'x-content-type-options': 'nosniff',
    },
  });
});
