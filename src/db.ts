import type { CartItem, Env, Product, Session } from "./types";

const EMPTY_CART = "[]";

export async function getSession(env: Env, phone: string): Promise<Session> {
  const existing = await env.DB.prepare("SELECT * FROM sesiones WHERE telefono = ?")
    .bind(phone)
    .first<Session>();

  if (existing) return existing;
  const created: Session = {
    telefono: phone,
    paso: "INICIO",
    carrito_json: EMPTY_CART,
    nombre_cliente: null,
    direccion: null,
    latitud: null,
    longitud: null,
    metodo_pago: null,
    metodo_entrega: null,
    carrito_base_json: EMPTY_CART,
  };
  await saveSession(env, created);
  return created;
}

export async function saveSession(env: Env, session: Session): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO sesiones
      (telefono, paso, carrito_json, nombre_cliente, direccion, latitud, longitud, metodo_pago, metodo_entrega, carrito_base_json, actualizado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telefono) DO UPDATE SET
      paso = excluded.paso,
      carrito_json = excluded.carrito_json,
      nombre_cliente = excluded.nombre_cliente,
      direccion = excluded.direccion,
      latitud = excluded.latitud,
      longitud = excluded.longitud,
      metodo_pago = excluded.metodo_pago,
      metodo_entrega = excluded.metodo_entrega,
      carrito_base_json = excluded.carrito_base_json,
      actualizado_en = CURRENT_TIMESTAMP
  `).bind(
    session.telefono,
    session.paso,
    session.carrito_json,
    session.nombre_cliente,
    session.direccion,
    session.latitud,
    session.longitud,
    session.metodo_pago,
    session.metodo_entrega,
    session.carrito_base_json ?? EMPTY_CART,
  ).run();
}

export async function getCategories(env: Env): Promise<string[]> {
  const result = await env.DB.prepare(
    "SELECT DISTINCT categoria FROM productos WHERE disponible = 1 ORDER BY categoria",
  ).all<{ categoria: string }>();
  return result.results.map((row) => row.categoria);
}

export async function getProducts(env: Env, category?: string): Promise<Product[]> {
  if (category) {
    const result = await env.DB.prepare(
      "SELECT id, nombre, categoria, descripcion, precio, disponible FROM productos WHERE disponible = 1 AND categoria = ? ORDER BY nombre LIMIT 10",
    ).bind(category).all<Product>();
    return result.results;
  }
  const result = await env.DB.prepare(
    "SELECT id, nombre, categoria, descripcion, precio, disponible FROM productos WHERE disponible = 1 ORDER BY categoria, nombre",
  ).all<Product>();
  return result.results;
}

export async function getProduct(env: Env, id: string): Promise<Product | null> {
  return env.DB.prepare(
    "SELECT id, nombre, categoria, descripcion, precio, disponible FROM productos WHERE id = ? AND disponible = 1",
  ).bind(id).first<Product>();
}

export function readCart(session: Session): CartItem[] {
  try {
    const parsed = JSON.parse(session.carrito_json) as CartItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function addToCart(env: Env, session: Session, product: Product): Promise<CartItem[]> {
  const cart = readCart(session);
  const item = cart.find((entry) => entry.productId === product.id);
  if (item) item.quantity += 1;
  else cart.push({ productId: product.id, name: product.nombre, price: product.precio, quantity: 1 });
  session.carrito_json = JSON.stringify(cart);
  if (!session.paso.startsWith("AGREGANDO_A_PEDIDO:")) session.paso = "ELIGIENDO_PRODUCTOS";
  await saveSession(env, session);
  return cart;
}

export async function saveOrder(env: Env, session: Session): Promise<number> {
  const cart = readCart(session);
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const result = await env.DB.prepare(`
    INSERT INTO pedidos
      (telefono, nombre_cliente, carrito_json, total, direccion, latitud, longitud, metodo_pago, metodo_entrega, estado)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECIBIDO')
  `).bind(
    session.telefono,
    session.nombre_cliente ?? "",
    session.carrito_json,
    total,
    session.direccion ?? "",
    session.latitud,
    session.longitud,
    session.metodo_pago ?? "",
    session.metodo_entrega ?? "DOMICILIO",
  ).run();

  session.paso = "INICIO";
  session.carrito_json = EMPTY_CART;
  session.nombre_cliente = null;
  session.direccion = null;
  session.latitud = null;
  session.longitud = null;
  session.metodo_pago = null;
  session.metodo_entrega = null;
  session.carrito_base_json = EMPTY_CART;
  await saveSession(env, session);
  return Number(result.meta.last_row_id ?? 0);
}

export async function markMessageProcessed(env: Env, messageId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO mensajes_procesados (id_mensaje) VALUES (?)",
  ).bind(messageId).run();
  return result.meta.changes === 1;
}
