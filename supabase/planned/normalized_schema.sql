-- ============================================================================
-- Ideia Cúbica — esquema PLANEJADO para migração ao Supabase (PostgreSQL).
-- Status: rascunho de referência, ainda NÃO aplicado. Espelha src/domain/types.ts.
--
-- Convenções:
--   numeric(14,2)  valores monetários totais
--   numeric(18,8)  custos unitários (R$/g) e quantidades
--   Saldos de estoque e de títulos são DERIVADOS (views), nunca colunas editáveis.
--   Nada é apagado: cancelamentos/estornos usam colunas de status + motivo.
--   Operações integradas (compra, venda, conclusão de OP) devem virar funções
--   PL/pgSQL transacionais chamadas via RPC.
-- ============================================================================

create extension if not exists "pgcrypto";

create table company_settings (
  id                        int primary key default 1 check (id = 1),
  company_name              text not null default 'Ideia Cúbica',
  energy_tariff             numeric(18,8),              -- R$/kWh; null = não configurado
  labor_hour_cost           numeric(14,2),
  productive_hours_month    numeric(10,2) check (productive_hours_month > 0),
  default_target_margin_pct numeric(6,3) check (default_target_margin_pct >= 0 and default_target_margin_pct < 100),
  default_rounding          text not null default 'nenhum'
);

create table categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  is_filament boolean not null default false,
  active      boolean not null default true
);

create table parties (
  id       uuid primary key default gen_random_uuid(),
  kind     text not null check (kind in ('fornecedor','cliente')),
  name     text not null,
  document text,
  contact  text,
  notes    text
);

create table materials (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  name           text not null,
  category_id    uuid not null references categories(id),
  unit           text not null check (unit in ('g','kg','un','m','cm','ml','l','pacote','rolo')),
  active         boolean not null default true,
  -- dados de filamento (nulos para insumos gerais)
  manufacturer   text, brand text, material_type text, color text, color_hex text,
  net_weight_g   numeric(18,8), gross_weight_g numeric(18,8), spool_weight_g numeric(18,8), diameter_mm numeric(6,3),
  min_stock      numeric(18,8) check (min_stock >= 0),
  safety_stock   numeric(18,8) check (safety_stock >= 0),
  lead_time_days int check (lead_time_days >= 0),
  location       text,
  notes          text,
  created_at     timestamptz not null default now()
);

create table accounts (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  kind            text not null check (kind in ('caixa','banco','carteira_digital')),
  opening_balance numeric(14,2) not null,
  opening_date    date not null,
  active          boolean not null default true
);

create table fin_categories (
  id        uuid primary key default gen_random_uuid(),
  name      text not null unique,
  direction text not null check (direction in ('in','out')),
  nature    text not null check (nature in ('receita_venda','receita_outra','custo_variavel','despesa_fixa','estoque','investimento','aporte','retirada','outros')),
  system    boolean not null default false
);

create table purchases (
  id            uuid primary key default gen_random_uuid(),
  number        text not null unique,
  date          date not null,
  supplier_id   uuid references parties(id),
  freight       numeric(14,2) not null default 0 check (freight >= 0),
  other_costs   numeric(14,2) not null default 0 check (other_costs >= 0),
  total         numeric(14,2) not null check (total > 0),
  payment       jsonb not null,               -- condições: modo, conta, parcelas, vencimentos
  status        text not null default 'ativa' check (status in ('ativa','cancelada')),
  cancel_reason text,
  notes         text,
  created_at    timestamptz not null default now()
);

create table lots (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  material_id   uuid not null references materials(id),
  origin        text not null check (origin in ('compra','estoque_inicial')),
  purchase_id   uuid references purchases(id),
  supplier_id   uuid references parties(id),
  date          date not null,
  batch_number  text,
  initial_qty   numeric(18,8) not null check (initial_qty > 0),
  unit_cost     numeric(18,8) not null check (unit_cost >= 0),   -- imutável
  cost_goods    numeric(14,2) not null, cost_freight numeric(14,2) not null, cost_other numeric(14,2) not null,
  notes         text,
  check ((origin = 'compra') = (purchase_id is not null))
);
create index on lots(material_id);

create table purchase_items (
  purchase_id  uuid not null references purchases(id),
  lot_id       uuid not null unique references lots(id),
  material_id  uuid not null references materials(id),
  qty          numeric(18,8) not null check (qty > 0),
  price        numeric(14,2) not null check (price >= 0),
  batch_number text,
  primary key (purchase_id, lot_id)
);

create table stock_movements (
  id          uuid primary key default gen_random_uuid(),
  date        date not null,
  lot_id      uuid not null references lots(id),
  material_id uuid not null references materials(id),
  type        text not null check (type in ('entrada','consumo','perda','ajuste_pos','ajuste_neg','devolucao','reserva','liberacao')),
  qty         numeric(18,8) not null check (qty > 0),
  ref_kind    text not null,
  ref_id      uuid,
  idem_key    text not null unique,            -- impede baixa duplicada
  reason      text,
  created_at  timestamptz not null default now()
);
create index on stock_movements(lot_id);
create index on stock_movements(ref_id);

create view lot_balances as
select l.id as lot_id,
  coalesce(sum(case when m.type in ('entrada','ajuste_pos') then m.qty when m.type in ('consumo','perda','ajuste_neg','devolucao') then -m.qty end), 0) as physical,
  coalesce(sum(case when m.type = 'reserva' then m.qty when m.type = 'liberacao' then -m.qty end), 0) as reserved
from lots l left join stock_movements m on m.lot_id = l.id
group by l.id;

create table printers (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  manufacturer           text, model text,
  acquisition_value      numeric(14,2) check (acquisition_value >= 0),
  residual_value         numeric(14,2) check (residual_value >= 0),
  useful_life_hours      numeric(12,2) check (useful_life_hours > 0),
  initial_hours          numeric(12,2) not null default 0,
  energy_mode            text not null check (energy_mode in ('medido','estimado')),
  kwh_per_hour           numeric(18,8),
  maintenance_per_hour   numeric(18,8),
  available_hours_month  numeric(10,2),
  active                 boolean not null default true,
  notes                  text,
  check (residual_value is null or acquisition_value is null or residual_value <= acquisition_value)
);

create table printer_maintenance (
  id             uuid primary key default gen_random_uuid(),
  printer_id     uuid not null references printers(id),
  date           date not null,
  kind           text not null check (kind in ('preventiva','corretiva','falha')),
  description    text not null,
  cost           numeric(14,2) not null default 0,
  downtime_hours numeric(10,2)
);

create table sales_channels (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  tax_pct             numeric(6,3) not null, commission_pct numeric(6,3) not null,
  payment_fee_pct     numeric(6,3) not null, other_pct numeric(6,3) not null,
  fixed_fee_per_order numeric(14,2) not null,
  active              boolean not null default true,
  check (tax_pct + commission_pct + payment_fee_pct + other_pct < 100)
);

create table overheads (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  monthly_amount  numeric(14,2) not null check (monthly_amount >= 0),
  include_in_cost boolean not null default true,
  notes           text
);

create table projects (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null unique,
  name                 text not null,
  source_url           text, creator text, license text,
  commercial_use       text not null check (commercial_use in ('autorizado','nao_autorizado','verificar','proprio')),
  recommended_material text, colors text, print_profile text,
  printer_id           uuid references printers(id),
  notes                text,
  created_at           timestamptz not null default now()
);

create table project_files (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  version    text not null,
  file_name  text not null,
  storage_path text,                          -- Supabase Storage (futuro)
  date       date not null,
  notes      text,
  unique (project_id, version)
);

create table quotes (
  id          uuid primary key default gen_random_uuid(),
  number      text not null unique,
  name        text not null,
  project_id  uuid references projects(id),
  customer_id uuid references parties(id),
  status      text not null check (status in ('rascunho','enviado','aprovado','recusado','convertido')),
  created_at  timestamptz not null default now()
);

-- Versões imutáveis: entrada + snapshot completo dos parâmetros usados.
create table quote_versions (
  quote_id    uuid not null references quotes(id),
  version     int not null,
  created_at  timestamptz not null default now(),
  input       jsonb not null,
  params      jsonb not null,
  total_cost  numeric(14,2), unit_cost numeric(18,8), unit_price numeric(14,2), margin_pct numeric(10,6),
  complete    boolean not null,
  note        text,
  primary key (quote_id, version)
);

create table production_orders (
  id                uuid primary key default gen_random_uuid(),
  number            text not null unique,
  project_id        uuid references projects(id),
  quote_id          uuid, quote_version int,
  description       text not null,
  printer_id        uuid references printers(id),
  qty_planned       int not null check (qty_planned > 0),
  planned_materials jsonb not null,
  planned_hours     numeric(10,4),
  status            text not null check (status in ('planejada','aguardando_material','pronta','em_producao','aguardando_acabamento','em_inspecao','concluida','cancelada')),
  responsible       text,
  started_at        timestamptz, finished_at timestamptz,
  actual            jsonb,                      -- consumo real, horas, aprovadas, rejeitadas, falhas
  cancel_reason     text, notes text,
  created_at        timestamptz not null default now(),
  foreign key (quote_id, quote_version) references quote_versions(quote_id, version)
);

create table sales (
  id              uuid primary key default gen_random_uuid(),
  number          text not null unique,
  date            date not null,
  customer_id     uuid references parties(id),
  project_id      uuid references projects(id),
  quote_id        uuid references quotes(id),
  order_id        uuid references production_orders(id),
  description     text not null,
  qty             int not null check (qty > 0),
  unit_price      numeric(14,2) not null check (unit_price > 0),
  discount        numeric(14,2) not null default 0,
  freight_charged numeric(14,2) not null default 0,
  freight_cost    numeric(14,2) not null default 0,
  channel_id      uuid references sales_channels(id),
  fees_rates_pct  numeric(6,3) not null, fees_fixed numeric(14,2) not null, fees_total numeric(14,2) not null,
  fees_withheld   boolean not null,
  unit_cost       numeric(18,8),
  cost_status     text not null check (cost_status in ('realizado','estimado','pendente')),
  payment         jsonb not null,
  status          text not null default 'ativa' check (status in ('ativa','cancelada')),
  cancel_reason   text, notes text,
  created_at      timestamptz not null default now()
);

create table fin_titles (
  id               uuid primary key default gen_random_uuid(),
  direction        text not null check (direction in ('in','out')),
  description      text not null,
  category_id      uuid not null references fin_categories(id),
  amount           numeric(14,2) not null check (amount > 0),
  competence_date  date not null,
  due_date         date not null,
  party_id         uuid references parties(id),
  project_id       uuid references projects(id),
  origin_kind      text not null check (origin_kind in ('compra','venda','manual')),
  origin_id        uuid,
  installment_n    int, installment_of int,
  method           text,
  status           text not null check (status in ('aberto','liquidado','cancelado')),
  cancel_reason    text, notes text,
  created_at       timestamptz not null default now()
);
create index on fin_titles(due_date) where status = 'aberto';
create index on fin_titles(origin_kind, origin_id);

create table settlements (
  id              uuid primary key default gen_random_uuid(),
  title_id        uuid not null references fin_titles(id),
  date            date not null,
  amount          numeric(14,2) not null check (amount > 0),
  account_id      uuid not null references accounts(id),
  method          text,
  reversed_at     timestamptz,
  reversed_reason text
);
create index on settlements(account_id);

create table audit_log (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  user_id uuid,                                -- auth.users (quando houver autenticação)
  action  text not null,
  detail  text
);

-- Quando houver autenticação: habilitar RLS em todas as tabelas e políticas por usuário/empresa.
