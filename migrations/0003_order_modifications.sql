ALTER TABLE pedidos ADD COLUMN adiciones_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE pedidos ADD COLUMN modificado_en TEXT;
ALTER TABLE sesiones ADD COLUMN carrito_base_json TEXT NOT NULL DEFAULT '[]';
