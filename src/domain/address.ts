/** Endereços brasileiros: CEP, formatação e conversão da resposta do ViaCEP. */
import type { AddressParts } from './types';
import { onlyDigits } from './core';

export const isValidCep = (cep: string | undefined | null) => onlyDigits(cep).length === 8;
export const fmtCep = (cep: string | undefined | null) => {
  const d = onlyDigits(cep);
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : (cep ?? '');
};

/** "Rua A, 10, Apto 2 — Centro — São Paulo/SP — CEP 01001-000" */
export function formatAddress(p: AddressParts | undefined): string {
  if (!p) return '';
  const line1 = [p.street, p.number, p.complement].map((s) => s?.trim()).filter(Boolean).join(', ');
  const city = [p.city?.trim(), p.state?.trim().toUpperCase()].filter(Boolean).join('/');
  return [line1, p.district?.trim(), city, isValidCep(p.cep) ? `CEP ${fmtCep(p.cep)}` : ''].filter(Boolean).join(' — ');
}

export interface ViaCepResponse { cep?: string; logradouro?: string; complemento?: string; bairro?: string; localidade?: string; uf?: string; erro?: boolean | string }

/** Converte a resposta do ViaCEP; null quando o CEP não existe. */
export function fromViaCep(r: ViaCepResponse): AddressParts | null {
  if (!r || r.erro === true || r.erro === 'true') return null;
  return { cep: onlyDigits(r.cep), street: r.logradouro || '', district: r.bairro || '', city: r.localidade || '', state: (r.uf || '').toUpperCase() };
}
