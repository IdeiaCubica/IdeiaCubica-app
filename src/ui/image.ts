/**
 * Reduz e comprime a imagem no navegador antes de guardar (JPEG, lado maior ≤ 1000 px).
 * Mantém o tamanho compatível com o armazenamento local; no Supabase irá para o Storage.
 */
export async function compressImage(file: File, maxSide = 1000, quality = 0.8): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Selecione um arquivo de imagem (JPG, PNG, WEBP).');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Navegador sem suporte a processamento de imagem.');
    ctx.fillStyle = '#ffffff'; // fundo branco para PNG transparente
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}
