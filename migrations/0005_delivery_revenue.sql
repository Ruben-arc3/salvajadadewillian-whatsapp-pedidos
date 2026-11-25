UPDATE pedidos SET estado = 'RECIBIDO' WHERE estado = 'NUEVO';

CREATE TABLE IF NOT EXISTS ingresos (
  pedido_id INTEGER PRIMARY KEY REFERENCES pedidos(id),
  monto INTEGER NOT NULL CHECK (monto >= 0),
  metodo_pago TEXT NOT NULL,
  registrado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ingresos_registrado_en
  ON ingresos(registrado_en);

CREATE INDEX IF NOT EXISTS idx_ingresos_metodo_pago
  ON ingresos(metodo_pago);
