/**
 * Busca de endereço pelo CEP no ViaCEP (serviço público e gratuito, sem chave).
 * Envia somente o CEP digitado; nenhum outro dado do cliente sai do sistema.
 */
import type { AddressParts } from '../domain/types';
import { fromViaCep, isValidCep } from '../domain/address';
import { onlyDigits } from '../domain/core';

export async function lookupCep(cep: string): Promise<AddressParts> {
  if (!isValidCep(cep)) throw new Error('CEP deve ter 8 dígitos.');
  let res: Response;
  try {
    res = await fetch(`https://viacep.com.br/ws/${onlyDigits(cep)}/json/`);
  } catch {
    throw new Error('Não foi possível consultar o CEP agora (sem conexão). Preencha o endereço manualmente.');
  }
  if (!res.ok) throw new Error('Serviço de CEP indisponível no momento. Preencha o endereço manualmente.');
  const parts = fromViaCep(await res.json());
  if (!parts) throw new Error('CEP não encontrado. Confira os números ou preencha manualmente.');
  return parts;
}
