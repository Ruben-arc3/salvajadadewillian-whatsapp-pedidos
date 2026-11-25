CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE,
  rol TEXT NOT NULL CHECK (rol IN ('ADMIN', 'CAJERO')),
  pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  creado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS turnos (
  id TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  base_inicial INTEGER NOT NULL CHECK (base_inicial >= 0),
  estado TEXT NOT NULL DEFAULT 'ABIERTO' CHECK (estado IN ('ABIERTO', 'CERRADO')),
  abierto_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cerrado_en TEXT,
  efectivo_contado INTEGER,
  transferencia_contada INTEGER,
  efectivo_esperado INTEGER,
  transferencia_esperada INTEGER,
  diferencia_efectivo INTEGER,
  diferencia_transferencia INTEGER,
  UNIQUE (id, usuario_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_turnos_uno_abierto_por_usuario
  ON turnos(usuario_id) WHERE estado = 'ABIERTO';
CREATE UNIQUE INDEX IF NOT EXISTS idx_turnos_unico_abierto
  ON turnos((1)) WHERE estado = 'ABIERTO';

CREATE TABLE IF NOT EXISTS insumos (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE,
  unidad TEXT NOT NULL CHECK (unidad IN ('UNIDAD', 'G', 'KG', 'ML', 'L')),
  existencia REAL NOT NULL DEFAULT 0 CHECK (existencia >= 0),
  stock_minimo REAL NOT NULL DEFAULT 0 CHECK (stock_minimo >= 0),
  costo_unitario REAL NOT NULL DEFAULT 0 CHECK (costo_unitario >= 0),
  activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  actualizado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recetas (
  producto_id TEXT NOT NULL REFERENCES productos(id),
  insumo_id TEXT NOT NULL REFERENCES insumos(id),
  cantidad REAL NOT NULL CHECK (cantidad > 0),
  PRIMARY KEY (producto_id, insumo_id)
);

CREATE TABLE IF NOT EXISTS historial_precios (
  id TEXT PRIMARY KEY,
  producto_id TEXT NOT NULL REFERENCES productos(id),
  precio_anterior INTEGER NOT NULL,
  precio_nuevo INTEGER NOT NULL,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  motivo TEXT NOT NULL,
  creado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS historial_costos (
  id TEXT PRIMARY KEY,
  insumo_id TEXT NOT NULL REFERENCES insumos(id),
  costo_anterior REAL NOT NULL,
  costo_nuevo REAL NOT NULL,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  motivo TEXT NOT NULL,
  creado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS modificadores (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE,
  precio_extra INTEGER NOT NULL DEFAULT 0 CHECK (precio_extra >= 0),
  activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1))
);

CREATE TABLE IF NOT EXISTS producto_modificadores (
  producto_id TEXT NOT NULL REFERENCES productos(id),
  modificador_id TEXT NOT NULL REFERENCES modificadores(id),
  PRIMARY KEY (producto_id, modificador_id)
);

CREATE TABLE IF NOT EXISTS receta_modificadores (
  modificador_id TEXT NOT NULL REFERENCES modificadores(id),
  insumo_id TEXT NOT NULL REFERENCES insumos(id),
  cantidad REAL NOT NULL CHECK (cantidad > 0),
  PRIMARY KEY (modificador_id, insumo_id)
);

CREATE TABLE IF NOT EXISTS movimientos_inventario (
  client_uuid TEXT PRIMARY KEY,
  insumo_id TEXT NOT NULL REFERENCES insumos(id),
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  turno_id TEXT REFERENCES turnos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('COMPRA', 'VENTA', 'MERMA', 'CONSUMO_INTERNO', 'AJUSTE')),
  cantidad REAL NOT NULL CHECK (cantidad <> 0),
  costo_unitario REAL NOT NULL DEFAULT 0 CHECK (costo_unitario >= 0),
  motivo TEXT NOT NULL,
  referencia TEXT,
  creado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_movimientos_inventario_insumo_fecha
  ON movimientos_inventario(insumo_id, creado_en);

CREATE TABLE IF NOT EXISTS ventas (
  client_uuid TEXT PRIMARY KEY,
  turno_id TEXT NOT NULL REFERENCES turnos(id),
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  subtotal INTEGER NOT NULL CHECK (subtotal >= 0),
  domicilio INTEGER NOT NULL DEFAULT 0 CHECK (domicilio >= 0),
  efectivo INTEGER NOT NULL DEFAULT 0 CHECK (efectivo >= 0),
  transferencia INTEGER NOT NULL DEFAULT 0 CHECK (transferencia >= 0),
  costo_insumos REAL NOT NULL DEFAULT 0 CHECK (costo_insumos >= 0),
  estado TEXT NOT NULL DEFAULT 'CONFIRMADA' CHECK (estado IN ('CONFIRMADA', 'CANCELADA')),
  notas TEXT NOT NULL DEFAULT '',
  creado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (efectivo + transferencia = subtotal + domicilio)
);

CREATE INDEX IF NOT EXISTS idx_ventas_turno_fecha
  ON ventas(turno_id, creado_en);

CREATE TABLE IF NOT EXISTS venta_detalles (
  id TEXT PRIMARY KEY,
  venta_uuid TEXT NOT NULL REFERENCES ventas(client_uuid),
  producto_id TEXT NOT NULL REFERENCES productos(id),
  nombre_snapshot TEXT NOT NULL,
  cantidad INTEGER NOT NULL CHECK (cantidad > 0),
  precio_unitario INTEGER NOT NULL CHECK (precio_unitario >= 0),
  costo_unitario REAL NOT NULL DEFAULT 0 CHECK (costo_unitario >= 0),
  modificadores_json TEXT NOT NULL DEFAULT '[]',
  notas TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS movimientos_caja (
  client_uuid TEXT PRIMARY KEY,
  turno_id TEXT NOT NULL REFERENCES turnos(id),
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('GASTO', 'APORTE_BASE')),
  monto INTEGER NOT NULL CHECK (monto > 0),
  nota TEXT NOT NULL,
  referencia TEXT,
  creado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cierres_turno (
  turno_id TEXT PRIMARY KEY REFERENCES turnos(id),
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  efectivo_contado INTEGER NOT NULL CHECK (efectivo_contado >= 0),
  transferencia_contada INTEGER NOT NULL CHECK (transferencia_contada >= 0),
  efectivo_esperado INTEGER NOT NULL,
  transferencia_esperada INTEGER NOT NULL,
  diferencia_efectivo INTEGER NOT NULL,
  diferencia_transferencia INTEGER NOT NULL,
  client_uuid TEXT NOT NULL UNIQUE,
  cerrado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auditoria (
  client_uuid TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  accion TEXT NOT NULL,
  entidad TEXT NOT NULL,
  entidad_id TEXT NOT NULL,
  motivo TEXT NOT NULL,
  detalles_json TEXT NOT NULL DEFAULT '{}',
  creado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auditoria_fecha
  ON auditoria(creado_en);

CREATE TABLE IF NOT EXISTS sincronizaciones (
  client_uuid TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  tipo TEXT NOT NULL,
  resultado_json TEXT NOT NULL DEFAULT '{}',
  sincronizado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE ingresos ADD COLUMN turno_id TEXT REFERENCES turnos(id);
ALTER TABLE ingresos ADD COLUMN usuario_id TEXT REFERENCES usuarios(id);
ALTER TABLE ingresos ADD COLUMN monto_efectivo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingresos ADD COLUMN monto_transferencia INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingresos ADD COLUMN origen TEXT NOT NULL DEFAULT 'WHATSAPP';

-- Persist the recipe and ingredient cost used when a WhatsApp order is confirmed.
-- Later recipe or cost edits must not rewrite the historic order.
ALTER TABLE pedidos ADD COLUMN costo_insumos REAL NOT NULL DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN receta_snapshot_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ventas ADD COLUMN modalidad TEXT NOT NULL DEFAULT 'LOCAL';
ALTER TABLE ventas ADD COLUMN cliente TEXT NOT NULL DEFAULT '';
ALTER TABLE ventas ADD COLUMN direccion TEXT NOT NULL DEFAULT '';
ALTER TABLE pedidos ADD COLUMN insumos_consumidos INTEGER NOT NULL DEFAULT 0 CHECK (insumos_consumidos IN (0,1));
