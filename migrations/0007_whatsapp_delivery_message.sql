ALTER TABLE pedidos
  ADD COLUMN mensaje_entrega_estado TEXT NOT NULL DEFAULT 'PENDIENTE'
  CHECK (mensaje_entrega_estado IN ('PENDIENTE', 'ENVIADO', 'ERROR'));

ALTER TABLE pedidos ADD COLUMN mensaje_entrega_error TEXT;
