/**
 * Endereço com busca automática pelo CEP (ViaCEP). Ao completar os 8 dígitos,
 * preenche rua, bairro, cidade e UF; número e complemento ficam com o usuário.
 * Usado em todos os cadastros de endereço do sistema.
 */
import { useState } from 'react';
import type { AddressParts } from '../../domain/types';
import { fmtCep, isValidCep } from '../../domain/address';
import { onlyDigits } from '../../domain/core';
import { lookupCep } from '../../io/cep';
import { TextField } from './fields';

export function AddressFields({ value, onChange, title = 'Endereço' }: { value: AddressParts; onChange: (v: AddressParts) => void; title?: string }) {
  const [status, setStatus] = useState<{ tone: 'muted' | 'ok' | 'err'; text: string } | null>(null);
  const set = (k: keyof AddressParts) => (v: string) => onChange({ ...value, [k]: v });

  const search = async (cep: string) => {
    setStatus({ tone: 'muted', text: 'Buscando endereço…' });
    try {
      const found = await lookupCep(cep);
      onChange({ ...value, ...found, number: value.number, complement: value.complement });
      setStatus({ tone: 'ok', text: 'Endereço encontrado. Confira e informe o número.' });
    } catch (e) {
      setStatus({ tone: 'err', text: e instanceof Error ? e.message : 'Falha na busca do CEP.' });
    }
  };
  const onCep = (v: string) => {
    const masked = onlyDigits(v).slice(0, 8);
    onChange({ ...value, cep: masked });
    if (masked.length === 8) search(masked); else setStatus(null);
  };

  return (
    <fieldset className="address-fields">
      <p className="section-title">{title}</p>
      <div className="grid g4">
        <TextField label="CEP" value={fmtCep(value.cep)} onChange={onCep} placeholder="00000-000"
          hint={status ? <span className={status.tone === 'err' ? 'err-text' : status.tone === 'ok' ? 'ok-text' : ''}>{status.text}</span> : 'Digite o CEP para preencher o endereço'} />
        <div className="span-2"><TextField label="Rua / logradouro" value={value.street ?? ''} onChange={set('street')} /></div>
        <TextField label="Número" value={value.number ?? ''} onChange={set('number')} />
        <TextField label="Complemento" value={value.complement ?? ''} onChange={set('complement')} placeholder="Apto, bloco, sala…" />
        <TextField label="Bairro" value={value.district ?? ''} onChange={set('district')} />
        <TextField label="Cidade" value={value.city ?? ''} onChange={set('city')} />
        <TextField label="UF" value={value.state ?? ''} onChange={(v) => set('state')(v.toUpperCase().slice(0, 2))} />
      </div>
      {value.cep && !isValidCep(value.cep) && <small className="err-text">CEP incompleto.</small>}
    </fieldset>
  );
}
