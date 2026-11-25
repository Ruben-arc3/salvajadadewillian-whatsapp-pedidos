-- Immutable sale snapshots are kept apart from the operational order queue.
CREATE TABLE IF NOT EXISTS ventas_historial (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('PEDIDO', 'VENTA')),
  referencia TEXT NOT NULL,
  pedido_id INTEGER,
  origen TEXT NOT NULL CHECK (origen IN ('WHATSAPP', 'LOCAL')),
  cliente TEXT NOT NULL DEFAULT '',
  telefono TEXT NOT NULL DEFAULT '',
  modalidad TEXT NOT NULL DEFAULT 'LOCAL',
  direccion TEXT NOT NULL DEFAULT '',
  metodo_pago TEXT NOT NULL DEFAULT '',
  efectivo INTEGER NOT NULL DEFAULT 0,
  transferencia INTEGER NOT NULL DEFAULT 0,
  subtotal INTEGER NOT NULL DEFAULT 0,
  domicilio INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL CHECK (total >= 0),
  productos_json TEXT NOT NULL DEFAULT '[]',
  vendido_en TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_historial_tipo_referencia
  ON ventas_historial(tipo, referencia);
CREATE INDEX IF NOT EXISTS idx_ventas_historial_vendido_en
  ON ventas_historial(vendido_en DESC);

-- Preserve already delivered WhatsApp and local orders as permanent sales.
INSERT OR IGNORE INTO ventas_historial (
  id,tipo,referencia,pedido_id,origen,cliente,telefono,modalidad,direccion,
  metodo_pago,efectivo,transferencia,subtotal,domicilio,total,productos_json,vendido_en
)
SELECT
  'PEDIDO:' || p.id,'PEDIDO',CAST(p.id AS TEXT),p.id,p.origen,p.nombre_cliente,
  p.telefono,p.metodo_entrega,p.direccion,i.metodo_pago,i.monto_efectivo,
  i.monto_transferencia,p.total,0,p.total,p.carrito_json,i.registrado_en
FROM pedidos p
JOIN ingresos i ON i.pedido_id=p.id
WHERE p.estado='ENTREGADO';

-- Preserve existing confirmed quick sales, including their item snapshots.
INSERT OR IGNORE INTO ventas_historial (
  id,tipo,referencia,pedido_id,origen,cliente,telefono,modalidad,direccion,
  metodo_pago,efectivo,transferencia,subtotal,domicilio,total,productos_json,vendido_en
)
SELECT
  'VENTA:' || v.client_uuid,'VENTA',v.client_uuid,NULL,'LOCAL',v.cliente,'',
  v.modalidad,v.direccion,
  CASE WHEN v.efectivo>0 AND v.transferencia>0 THEN 'Mixto'
       WHEN v.efectivo>0 THEN 'Efectivo' ELSE 'Transferencia' END,
  v.efectivo,v.transferencia,v.subtotal,v.domicilio,v.subtotal+v.domicilio,
  COALESCE((
    SELECT json_group_array(json_object(
      'productId',d.producto_id,'name',d.nombre_snapshot,'quantity',d.cantidad,
      'price',d.precio_unitario,'modifiers',json(d.modificadores_json),'notes',d.notas
    )) FROM venta_detalles d WHERE d.venta_uuid=v.client_uuid
  ),'[]'),v.creado_en
FROM ventas v
WHERE v.estado='CONFIRMADA';
