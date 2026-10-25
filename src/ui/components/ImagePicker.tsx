import { useState } from 'react';
import { compressImage } from '../image';
import { Field } from './ui';

/** Foto da peça: escolher, trocar ou remover. A imagem é reduzida antes de salvar. */
export function ImagePicker({ label = 'Foto da peça', value, onChange, hint, disabled }: {
  label?: string; value: string | null | undefined; onChange: (img: string | null) => void; hint?: string; disabled?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file: File) => {
    setError(null); setBusy(true);
    try { onChange(await compressImage(file)); } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível ler a imagem.'); } finally { setBusy(false); }
  };
  return (
    <Field label={label} hint={error ?? hint ?? 'Opcional. A imagem é reduzida automaticamente.'}>
      <div className="image-drop">
        {value ? <img src={value} alt={label} /> : <span className="muted">{busy ? 'Carregando…' : 'Nenhuma foto'}</span>}
        {!disabled && <div className="row">
          <label className="btn secondary">{value ? 'Trocar foto' : 'Escolher foto'}<input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ''; }} /></label>
          {value && <button type="button" className="btn ghost" onClick={() => onChange(null)}>Remover</button>}
        </div>}
      </div>
    </Field>
  );
}
