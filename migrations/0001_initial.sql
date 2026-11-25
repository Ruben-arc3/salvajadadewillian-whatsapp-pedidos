CREATE TABLE IF NOT EXISTS productos (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  categoria TEXT NOT NULL,
  descripcion TEXT NOT NULL DEFAULT '',
  precio INTEGER NOT NULL CHECK (precio >= 0),
  disponible INTEGER NOT NULL DEFAULT 1 CHECK (disponible IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_productos_disponibles_categoria
  ON productos(disponible, categoria, nombre);

CREATE TABLE IF NOT EXISTS sesiones (
  telefono TEXT PRIMARY KEY,
  paso TEXT NOT NULL DEFAULT 'INICIO',
  carrito_json TEXT NOT NULL DEFAULT '[]',
  nombre_cliente TEXT,
  direccion TEXT,
  latitud REAL,
  longitud REAL,
  metodo_pago TEXT,
  actualizado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telefono TEXT NOT NULL,
  nombre_cliente TEXT NOT NULL,
  carrito_json TEXT NOT NULL,
  total INTEGER NOT NULL,
  direccion TEXT NOT NULL,
  latitud REAL,
  longitud REAL,
  metodo_pago TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'NUEVO',
  creado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS mensajes_procesados (
  id_mensaje TEXT PRIMARY KEY,
  procesado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
