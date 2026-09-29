-- ═══════════════════════════════════════════════════════════════
-- EPIMELEIA TRAZABILIDAD · tablas de Supabase
-- Pegar en: Supabase → SQL Editor → New query → Run.
-- No toca la tabla `activos` ni nada de lo existente. Son tablas nuevas.
-- ═══════════════════════════════════════════════════════════════

-- ── Declaraciones: la cuenta de saldo de un origen para un año ──
create table if not exists public.traz_declaraciones (
  id                   uuid primary key default gen_random_uuid(),
  creado_en            timestamptz not null default now(),

  origen_tipo          text,            -- 'epimeleia' | 'externo'
  origen_ref           text,            -- activo on-chain (nº) o referencia externa
  cultivo              text,
  pais                 text,            -- ISO3
  anio                 integer,

  base_ha              numeric,         -- base admisible (A_limpia)
  fuente_base          text,            -- 'epimeleia-satelite' | 'declarada-titular' | 'certificado-externo'
  produccion_declarada numeric,         -- toneladas declaradas por el titular

  referencia           jsonb,           -- { rinde, unidad, fuente, ambito, codigoAmbito, anioDato, fechaConsulta }
  margen               numeric,         -- múltiplo de tolerancia (3× por defecto)
  rinde_declarado      numeric,         -- produccion / base_ha
  techo                numeric,         -- referencia.rinde * margen
  veredicto            text,            -- 'ACEPTADA' | 'NO_ACEPTADA' | 'PENDIENTE'
  capacidad_anual      numeric,         -- si ACEPTADA, = produccion_declarada; el techo del saldo

  titular_hash         text,            -- huella del email (pública, va en el paquete)
  titular_email        text,            -- SOLO gestión; NO entra al paquete canónico

  paquete_canonical    text,            -- lo que se publica y se rehashea para verificar
  paquete_hash         text,            -- keccak256 del canonical; lo que se sella en Polygon
  tx_hash              text,            -- transacción de sellado
  bloque               integer,
  sellado_en           timestamptz
);

create index if not exists idx_traz_decl_hash    on public.traz_declaraciones (paquete_hash);
create index if not exists idx_traz_decl_origen  on public.traz_declaraciones (origen_tipo, origen_ref, anio);


-- ── Atribuciones: cada descuento de saldo, encadenado ──
create table if not exists public.traz_atribuciones (
  id                   uuid primary key default gen_random_uuid(),
  creado_en            timestamptz not null default now(),

  declaracion_id       uuid not null references public.traz_declaraciones(id),
  declaracion_hash     text,            -- raíz de la cuenta
  hash_anterior        text,            -- eslabón inmediato anterior (declaración o atribución previa)

  origen_tipo          text,
  origen_ref           text,
  cultivo              text,
  anio                 integer,

  toneladas            numeric,
  saldo_anterior       numeric,
  saldo_nuevo          numeric,
  veredicto            text,            -- 'ATRIBUIDA' (los RECHAZADA no se guardan)

  receptor_hash        text,            -- huella del receptor (pública)
  referencia_comercial text,            -- id de venta/lote opcional
  fecha                date,

  paquete_canonical    text,
  paquete_hash         text,
  tx_hash              text,
  bloque               integer,
  sellado_en           timestamptz
);

-- Índice clave: así el cálculo de saldo (sumar lo ATRIBUIDO de una
-- declaración y año) es una sola consulta rápida.
create index if not exists idx_traz_atrib_cuenta on public.traz_atribuciones (declaracion_id, anio, veredicto);
create index if not exists idx_traz_atrib_hash   on public.traz_atribuciones (paquete_hash);
