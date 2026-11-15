/** v1.27: sinal (% da venda) rateado por peça, recebido no financeiro e no extrato. */
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDB } from './schema';
import { saveAccount } from './catalog';
import { accountBalance } from './finance';
import { cancelSale, receiveSaleDownPayment, registerSale, saleEditBlock, salePaymentSplit, saleStatus } from './sales';
import type { DB } from './types';

let db: DB;
let acc: string;
const aprazo = (installments = 1) => ({ mode: 'aprazo' as const, installments, firstDue: '2026-11-30', intervalDays: 30 });
const sale = (installments = 1, unitPrice = '6.29') =>
  registerSale(db, { date: '2026-11-15', description: 'Chaveiro', qty: 10, unitPrice, discount: '0', freightCharged: '0', freightCost: '0', feesWithheld: true, payment: aprazo(installments) });

beforeEach(() => {
  db = createEmptyDB();
  saveAccount(db, { name: 'Caixa', kind: 'caixa', openingBalance: '100', openingDate: '2026-01-01', active: true });
  acc = db.accounts[0].id;
});

describe('Sinal da venda', () => {
  it('50% de 10 peças: metade de cada peça recebida, metade a receber; entra no extrato', () => {
    const s = sale();
    const r = receiveSaleDownPayment(db, { saleId: s.id, pct: '50', date: '2026-11-16', accountId: acc, method: 'PIX' });
    expect(r.amount.toString()).toBe('31.45'); // 50% de R$ 62,90
    const split = salePaymentSplit(db, s);
    expect([split.received.toString(), split.open.toString(), split.receivedPct.toString()]).toEqual(['31.45', '31.45', '50']);
    expect([split.perPiece.received.toString(), split.perPiece.open.toString()]).toEqual(['3.145', '3.145']);
    expect(saleStatus(db, s, '2026-11-16').status).toBe('a_pagar');
    expect(accountBalance(db, acc).toString()).toBe('131.45');
    const settlement = db.titles.find((t) => t.origin.id === s.id)!.settlements[0];
    expect([settlement.date, settlement.method]).toEqual(['2026-11-16', 'Sinal · PIX']);
  });

  it('não passa do que falta receber; o restante pode ser recebido depois', () => {
    const s = sale();
    receiveSaleDownPayment(db, { saleId: s.id, pct: '50', date: '2026-11-16', accountId: acc });
    expect(() => receiveSaleDownPayment(db, { saleId: s.id, pct: '60', date: '2026-11-17', accountId: acc })).toThrow(/mais do que falta receber/);
    expect(() => receiveSaleDownPayment(db, { saleId: s.id, pct: '0', date: '2026-11-17', accountId: acc })).toThrow(/percentual/);
    receiveSaleDownPayment(db, { saleId: s.id, pct: '50', date: '2026-11-20', accountId: acc });
    expect(saleStatus(db, s, '2026-11-20').status).toBe('pago');
    expect(() => receiveSaleDownPayment(db, { saleId: s.id, pct: '10', date: '2026-11-21', accountId: acc })).toThrow(/totalmente recebida/);
  });

  it('em parcelas: o sinal baixa primeiro a parcela que vence antes', () => {
    const s = sale(2, '10'); // R$ 100 em 2 × R$ 50
    receiveSaleDownPayment(db, { saleId: s.id, pct: '70', date: '2026-11-16', accountId: acc });
    const ts = db.titles.filter((t) => t.origin.id === s.id).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    expect(ts.map((t) => [t.status, t.settlements[0]?.amount])).toEqual([['liquidado', '50'], ['aberto', '20']]);
  });

  it('venda com sinal: não edita nem cancela sem estornar; venda à vista já está paga', () => {
    const s = sale();
    receiveSaleDownPayment(db, { saleId: s.id, pct: '30', date: '2026-11-16', accountId: acc });
    expect(saleEditBlock(db, s)).toMatch(/recebimento/);
    expect(() => cancelSale(db, s.id, 'teste')).toThrow(/Estorne/);
    const v = registerSale(db, { date: '2026-11-15', description: 'Vaso', qty: 1, unitPrice: '20', discount: '0', freightCharged: '0', freightCost: '0', feesWithheld: true,
      payment: { mode: 'avista', accountId: acc, installments: 1, firstDue: '2026-11-15', intervalDays: 30 } });
    expect(() => receiveSaleDownPayment(db, { saleId: v.id, pct: '50', date: '2026-11-16', accountId: acc })).toThrow(/totalmente recebida/);
  });
});
