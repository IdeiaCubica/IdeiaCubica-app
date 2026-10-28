import type { PieceDimensions } from '../../domain/types';
import { DecField } from './ui';

/**
 * Dimensões aproximadas de 1 peça (altura × largura × profundidade, em cm). Opcional:
 * campos vazios não aparecem para o cliente; todos vazios = sem dimensões.
 */
export function DimensionsFields({ value, onChange, disabled }: { value: PieceDimensions | null | undefined; onChange: (v: PieceDimensions | null) => void; disabled?: boolean }) {
  const d = value ?? { height: null, width: null, depth: null };
  const set = (k: keyof PieceDimensions) => (v: string | number | null) => {
    const next = { ...d, [k]: v === null || v === '' || Number(v) <= 0 ? null : Number(v) };
    onChange(next.height === null && next.width === null && next.depth === null ? null : next);
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <p className="section-title" style={{ margin: 0 }}>Dimensões aproximadas de 1 peça <span className="muted small" style={{ textTransform: 'none', letterSpacing: 0 }}>(opcional — aparecem na proposta para o cliente)</span></p>
      <div className="grid g3">
        <DecField label="Altura" suffix="cm" value={d.height} onChange={set('height')} disabled={disabled} />
        <DecField label="Largura" suffix="cm" value={d.width} onChange={set('width')} disabled={disabled} />
        <DecField label="Profundidade" suffix="cm" value={d.depth} onChange={set('depth')} disabled={disabled} hint="Deixe em branco o que não quiser informar" />
      </div>
    </div>
  );
}
