ALTER TABLE pedidos ADD COLUMN origen TEXT NOT NULL DEFAULT 'WHATSAPP'
  CHECK (origen IN ('WHATSAPP', 'LOCAL'));
ALTER TABLE pedidos ADD COLUMN client_uuid TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_client_uuid
  ON pedidos(client_uuid) WHERE client_uuid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pedidos_origen_estado_fecha
  ON pedidos(origen, estado, creado_en);
