import { addToCart, getCategories, getProduct, getProducts, getSession, readCart, saveOrder, saveSession } from "./db";
import type { CartItem, Env, Session, WhatsAppMessage } from "./types";
import { sendButtons, sendCategoryList, sendProductList, sendText } from "./whatsapp";

function textOf(message: WhatsAppMessage): string {
  return message.text?.body?.trim() ?? "";
}

function replyId(message: WhatsAppMessage): string {
  return message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id ?? "";
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function total(cart: CartItem[]): number {
  return cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

function cartSummary(cart: CartItem[]): string {
  const lines = cart.map((item) => `• ${item.quantity} × ${item.name} — $${(item.price * item.quantity).toLocaleString("es-CO")}`);
  return `${lines.join("\n")}\n\nTotal: $${total(cart).toLocaleString("es-CO")}`;
}

function additionsSince(base: CartItem[], updated: CartItem[]): CartItem[] {
  return updated.flatMap((item) => {
    const previous = base.find((entry) => entry.productId === item.productId)?.quantity ?? 0;
    const added = item.quantity - previous;
    return added > 0 ? [{ ...item, quantity: added }] : [];
  });
}

function mergeAdditions(previousJson: string, newlyAdded: CartItem[]): CartItem[] {
  let previous: CartItem[] = [];
  try { previous = JSON.parse(previousJson) as CartItem[]; } catch { /* start a fresh addition log */ }
  for (const added of newlyAdded) {
    const existing = previous.find((item) => item.productId === added.productId);
    if (existing) existing.quantity += added.quantity;
    else previous.push({ ...added });
  }
  return previous;
}

async function showHome(env: Env, phone: string): Promise<void> {
  const name = env.RESTAURANT_NAME || "La Salvajada de Willian";
  await sendButtons(env, phone, `¡Hola! 👋 Bienvenido a ${name}. ¿Qué deseas hacer?`, [
    { id: "MENU", title: "Ver menú" },
    { id: "ORDER", title: "Hacer pedido" },
    { id: "INFO", title: "Horario y ubicación" },
  ]);
  const pending = await env.DB.prepare(
    "SELECT id FROM pedidos WHERE telefono = ? AND estado IN ('RECIBIDO','TERMINADO') ORDER BY id DESC LIMIT 1",
  ).bind(phone).first<{ id: number }>();
  if (pending) await showCancelOption(env, phone, `Opciones para tu pedido #${pending.id}:`);
}

async function showCancelOption(env: Env, phone: string, prompt = "¿Deseas cancelar este pedido?"): Promise<void> {
  await sendButtons(env, phone, prompt, [{ id: "CANCEL_ORDER", title: "Cancelar" }]);
}

async function showMenu(env: Env, phone: string, cancellable = false): Promise<void> {
  const categories = await getCategories(env);
  if (!categories.length) {
    await sendText(env, phone, "Estamos actualizando el menú. Escríbenos en unos minutos o pide hablar con un encargado.");
    if (cancellable) await showCancelOption(env, phone);
    return;
  }
  await sendCategoryList(env, phone, categories);
  if (cancellable) await showCancelOption(env, phone);
}

async function askPayment(env: Env, session: Session): Promise<void> {
  session.paso = "PIDIENDO_METODO_PAGO";
  await saveSession(env, session);
  await sendButtons(env, session.telefono, "¿Cómo deseas pagar?", [
    { id: "PAYMENT:TRANSFER", title: "Transferencia" },
    { id: "PAYMENT:CASH", title: "Efectivo" },
    { id: "CANCEL_ORDER", title: "Cancelar" },
  ]);
}

async function requestHuman(env: Env, session: Session): Promise<void> {
  session.paso = "HUMANO";
  await saveSession(env, session);
  await sendText(env, session.telefono, "Entendido. Deseas hablar con un encargado. La atención automática queda pausada y te responderemos en cuanto sea posible.");
  if (env.OWNER_WHATSAPP) {
    await sendText(env, env.OWNER_WHATSAPP, `Solicitud de encargado de ${session.telefono}. Responde manualmente a este cliente en WhatsApp.`);
  }
}

function clearOrderDraft(session: Session): void {
  session.paso = "INICIO";
  session.carrito_json = "[]";
  session.carrito_base_json = "[]";
  session.nombre_cliente = null;
  session.direccion = null;
  session.latitud = null;
  session.longitud = null;
  session.metodo_pago = null;
  session.metodo_entrega = null;
}

function isCancellationRequest(command: string, id: string, step: string): boolean {
  if (id === "CANCEL_ORDER") return true;
  if (command === "2" && (step === "INICIO" || step === "HUMANO")) return true;
  return command.includes("cancel") || command.includes("anul");
}

async function cancelOrder(env: Env, session: Session): Promise<void> {
  const phone = session.telefono;
  const editingMatch = session.paso.match(/^AGREGANDO_A_PEDIDO:(\d+)$/);
  const editingOrderId = editingMatch ? Number(editingMatch[1]) : null;
  const isDraft = [
    "ELIGIENDO_PRODUCTOS",
    "PIDIENDO_ENTREGA",
    "PIDIENDO_NOMBRE",
    "PIDIENDO_DIRECCION",
    "PIDIENDO_UBICACION",
    "PIDIENDO_METODO_PAGO",
    "CONFIRMANDO",
  ].includes(session.paso);

  if (isDraft && !editingOrderId) {
    clearOrderDraft(session);
    await saveSession(env, session);
    await sendText(env, phone, "Cancelé el pedido en curso. No se envió al restaurante ni se registró. Cuando quieras, puedes empezar de nuevo.");
    await showHome(env, phone);
    return;
  }

  const pending = editingOrderId
    ? await env.DB.prepare("SELECT id, estado FROM pedidos WHERE id = ? AND telefono = ? AND estado IN ('RECIBIDO','TERMINADO')")
      .bind(editingOrderId, phone).first<{ id: number; estado: string }>()
    : await env.DB.prepare("SELECT id, estado FROM pedidos WHERE telefono = ? AND estado IN ('RECIBIDO','TERMINADO') ORDER BY id DESC LIMIT 1")
      .bind(phone).first<{ id: number; estado: string }>();

  if (pending?.estado === "RECIBIDO") {
    const result = await env.DB.prepare("UPDATE pedidos SET estado = 'CANCELADO' WHERE id = ? AND telefono = ? AND estado = 'RECIBIDO'")
      .bind(pending.id, phone).run();
    clearOrderDraft(session);
    await saveSession(env, session);
    if (result.meta.changes !== 1) {
      await sendText(env, phone, "No pude cancelar el pedido porque su estado cambió. Escribe “Hablar con un encargado” para que te ayuden.");
      return;
    }
    await sendText(env, phone, `Cancelé tu pedido #${pending.id}. Si fue un error, escribe “Hacer pedido” para comenzar otro.`);
    await showHome(env, phone);
    return;
  }

  if (pending?.estado === "TERMINADO") {
    session.paso = "HUMANO";
    await saveSession(env, session);
    if (env.OWNER_WHATSAPP) {
      await sendText(env, phone, "Tu pedido ya está en preparación. Envié tu solicitud de cancelación al encargado para que confirme si todavía es posible detenerlo.");
      await sendText(env, env.OWNER_WHATSAPP, `Solicitud de cancelación del pedido #${pending.id} de ${phone}. El pedido ya está en preparación; revisa y responde al cliente.`);
    } else {
      await sendText(env, phone, "Tu pedido ya está en preparación y no puedo cancelarlo automáticamente. Contacta directamente al restaurante para solicitar ayuda.");
    }
    return;
  }

  if (isDraft || editingOrderId) {
    clearOrderDraft(session);
    await saveSession(env, session);
  }
  await sendText(env, phone, "No tienes un pedido en curso que se pueda cancelar.");
  if (session.paso !== "HUMANO") await showHome(env, phone);
}

export async function handleMessage(env: Env, message: WhatsAppMessage): Promise<void> {
  const phone = message.from;
  const session = await getSession(env, phone);
  const text = textOf(message);
  const command = normalize(text);
  const id = replyId(message);

  // Handle cancellation before the human handoff and state-specific branches so
  // customers can ask to cancel from any point in the guided flow.
  if (isCancellationRequest(command, id, session.paso)) {
    await cancelOrder(env, session);
    return;
  }

  if (
    (command.includes("hablar") && command.includes("encargado")) ||
    ["encargado", "asesor", "humano", "persona"].some((phrase) => command.includes(phrase)) ||
    id === "HUMAN"
  ) {
    await requestHuman(env, session);
    return;
  }

  if (session.paso === "HUMANO") {
    if (["menu", "hola", "inicio", "volver"].includes(command)) {
      session.paso = "INICIO";
      await saveSession(env, session);
      await showHome(env, phone);
    }
    return;
  }

  const addCommand = id === "ADD_ORDER" || command === "1 agregar" || command === "1 agregar algo" || command === "agregar algo" || (command === "1" && (session.paso === "INICIO" || session.paso === "HUMANO"));
  if (addCommand) {
    const activeOrder = await env.DB.prepare(
      "SELECT id, carrito_json FROM pedidos WHERE telefono = ? AND estado = 'RECIBIDO' ORDER BY id DESC LIMIT 1",
    ).bind(phone).first<{ id: number; carrito_json: string }>();
    if (!activeOrder) {
      await sendText(env, phone, "No tienes un pedido pendiente que se pueda modificar o cancelar.");
      return;
    }
    session.paso = `AGREGANDO_A_PEDIDO:${activeOrder.id}`;
    session.carrito_json = activeOrder.carrito_json;
    session.carrito_base_json = activeOrder.carrito_json;
    await saveSession(env, session);
    await sendText(env, phone, "Claro, elige los productos que deseas agregar. Al terminar, toca “Continuar” para guardar los cambios en tu pedido.");
    await showMenu(env, phone, true);
    return;
  }

  if (id === "MENU" || id === "ORDER") {
    session.paso = "ELIGIENDO_PRODUCTOS";
    await saveSession(env, session);
    await showMenu(env, phone, true);
    return;
  }
  if (id === "INFO" || command === "horario" || command === "ubicacion" || command === "ubicación") {
    await sendText(env, phone, "🕔 Atendemos todos los días de 5:00 p. m. a 11:59 p. m.\n📍 Estamos en el barrio El Dorado.\n🛵 Ofrecemos domicilio. Para pedir, escribe “Hacer pedido”.");
    await showHome(env, phone);
    return;
  }
  if (id === "MORE") {
    await showMenu(env, phone, true);
    return;
  }
  if (id.startsWith("CATEGORY:")) {
    const index = Number(id.slice("CATEGORY:".length));
    const categories = await getCategories(env);
    const category = categories[index];
    if (!category) {
      await showMenu(env, phone, true);
      return;
    }
    await sendProductList(env, phone, await getProducts(env, category));
    await showCancelOption(env, phone);
    return;
  }
  if (id === "CHECKOUT") {
    if (session.paso.startsWith("AGREGANDO_A_PEDIDO:")) {
      const orderId = Number(session.paso.slice("AGREGANDO_A_PEDIDO:".length));
      const cart = readCart(session);
      const orderBeforeUpdate = await env.DB.prepare("SELECT adiciones_json FROM pedidos WHERE id = ? AND telefono = ? AND estado = 'RECIBIDO'")
        .bind(orderId, phone).first<{ adiciones_json: string }>();
      const additions = mergeAdditions(orderBeforeUpdate?.adiciones_json ?? "[]", additionsSince(readCart({ ...session, carrito_json: session.carrito_base_json }), cart));
      const result = await env.DB.prepare(`
        UPDATE pedidos SET carrito_json = ?, total = ?, adiciones_json = ?, modificado_en = CURRENT_TIMESTAMP
        WHERE id = ? AND telefono = ? AND estado = 'RECIBIDO'
      `).bind(JSON.stringify(cart), total(cart), JSON.stringify(additions), orderId, phone).run();
      session.paso = "INICIO";
      session.carrito_json = "[]";
      session.nombre_cliente = null;
      session.direccion = null;
      session.latitud = null;
      session.longitud = null;
      session.metodo_pago = null;
      session.carrito_base_json = "[]";
      await saveSession(env, session);
      if (result.meta.changes !== 1) {
        await sendText(env, phone, "No pude modificar el pedido porque ya no está pendiente. Escribe “Hablar con un encargado” para recibir ayuda.");
        return;
      }
      await sendText(env, phone, `Listo, agregué los productos a tu pedido.\n${cartSummary(cart)}`);
      await sendButtons(env, phone, "¿Qué deseas hacer con tu pedido?", [
        { id: "ADD_ORDER", title: "1. Agregar algo" },
        { id: "CANCEL_ORDER", title: "2. Cancelar" },
      ]);
      return;
    }
    session.paso = "PIDIENDO_ENTREGA";
    await saveSession(env, session);
    await sendButtons(env, phone, "¿Lo deseas a domicilio o lo recogerás en el local?", [
      { id: "DELIVERY:HOME", title: "Domicilio" },
      { id: "DELIVERY:PICKUP", title: "Recoger en el local" },
      { id: "CANCEL_ORDER", title: "Cancelar" },
    ]);
    return;
  }
  if (id.startsWith("PRODUCT:")) {
    const product = await getProduct(env, id.slice("PRODUCT:".length));
    if (!product) {
      await sendText(env, phone, "Ese producto ya no está disponible. Te muestro el menú actualizado.");
      await showMenu(env, phone, true);
      return;
    }
    const cart = await addToCart(env, session, product);
    await sendButtons(env, phone, `Agregué ${product.nombre}.\n\n${cartSummary(cart)}\n\n¿Deseas agregar algo más o continuar?`, [
      { id: "MORE", title: "Agregar otro" },
      { id: "CHECKOUT", title: "Continuar" },
      { id: "HUMAN", title: "Hablar encargado" },
    ]);
    await showCancelOption(env, phone);
    return;
  }

  if (session.paso === "PIDIENDO_ENTREGA" && (id === "DELIVERY:HOME" || id === "DELIVERY:PICKUP")) {
    session.metodo_entrega = id === "DELIVERY:PICKUP" ? "RECOGER" : "DOMICILIO";
    session.direccion = null;
    session.latitud = null;
    session.longitud = null;
    session.paso = "PIDIENDO_NOMBRE";
    await saveSession(env, session);
      await sendText(env, phone, "Perfecto. ¿A nombre de quién registramos el pedido?");
    return;
  }
  if (session.paso === "PIDIENDO_NOMBRE" && text) {
    session.nombre_cliente = text.slice(0, 100);
    if (session.metodo_entrega === "RECOGER") {
      await saveSession(env, session);
      await askPayment(env, session);
    } else {
      session.paso = "PIDIENDO_DIRECCION";
      await saveSession(env, session);
      await sendButtons(env, phone, "Gracias. Escríbeme la dirección completa para el domicilio (barrio, calle/carrera, número y alguna referencia).", [
        { id: "HUMAN", title: "Hablar encargado" },
        { id: "CANCEL_ORDER", title: "Cancelar" },
      ]);
    }
    return;
  }
  if (session.paso === "PIDIENDO_DIRECCION" && text) {
    session.direccion = text.slice(0, 500);
    session.paso = "PIDIENDO_UBICACION";
    await saveSession(env, session);
    await sendButtons(env, phone, "Ahora comparte tu ubicación en tiempo real o ubicación actual desde el clip ➕ → Ubicación → Enviar ubicación actual. Cuando WhatsApp la envíe, la guardaré en el pedido.", [
      { id: "SKIP_LOCATION", title: "Omitir ubicación" },
      { id: "HUMAN", title: "Hablar encargado" },
      { id: "CANCEL_ORDER", title: "Cancelar" },
    ]);
    return;
  }
  if (session.paso === "PIDIENDO_UBICACION" && message.location) {
    session.latitud = message.location.latitude;
    session.longitud = message.location.longitude;
    await askPayment(env, session);
    return;
  }
  if (session.paso === "PIDIENDO_UBICACION" && (id === "SKIP_LOCATION" || command === "omitir")) {
    session.latitud = null;
    session.longitud = null;
    await askPayment(env, session);
    return;
  }
  if (session.paso === "PIDIENDO_METODO_PAGO" && (id === "PAYMENT:TRANSFER" || id === "PAYMENT:CASH")) {
    session.metodo_pago = id === "PAYMENT:TRANSFER" ? "Transferencia" : "Efectivo";
    session.paso = "CONFIRMANDO";
    await saveSession(env, session);
    const cart = readCart(session);
    const location = session.latitud !== null && session.longitud !== null ? "Ubicación compartida ✅" : "Ubicación: no compartida";
    const deliverySummary = session.metodo_entrega === "RECOGER"
      ? "Entrega: Recoger en el local"
      : `Entrega: Domicilio\nDirección: ${session.direccion}\n${location}`;
    await sendButtons(env, phone, `Confirma tu pedido:\n${cartSummary(cart)}\n\nNombre: ${session.nombre_cliente}\n${deliverySummary}\nPago: ${session.metodo_pago}`, [
      { id: "CONFIRM_ORDER", title: "Confirmar pedido" },
      { id: "CANCEL_ORDER", title: "Cancelar" },
      { id: "HUMAN", title: "Hablar encargado" },
    ]);
    return;
  }
  if (id === "CONFIRM_ORDER" && session.paso === "CONFIRMANDO") {
    const orderCart = readCart(session);
    const orderName = session.nombre_cliente;
    const orderAddress = session.direccion;
    const paymentMethod = session.metodo_pago;
    const deliveryMethod = session.metodo_entrega;
    const orderId = await saveOrder(env, session);
    await sendText(env, phone, `¡Pedido recibido! ✅\nGracias por elegir La Salvajada de Willian. Si necesitas ayuda, escribe “Hablar con un encargado”.`);
    await sendButtons(env, phone, "¿Qué deseas hacer con tu pedido antes de que empecemos a prepararlo?", [
      { id: "ADD_ORDER", title: "1. Agregar algo" },
      { id: "CANCEL_ORDER", title: "2. Cancelar" },
    ]);
    if (env.OWNER_WHATSAPP) {
      const deliveryDetails = deliveryMethod === "RECOGER" ? "Recoge en el local" : `Domicilio: ${orderAddress}`;
      await sendText(env, env.OWNER_WHATSAPP, `Nuevo pedido #${orderId}\nCliente: ${orderName} (${phone})\n${deliveryDetails}\nPago: ${paymentMethod}\n${cartSummary(orderCart)}`);
    }
    return;
  }
  if (message.type === "location" && message.location) {
    session.latitud = message.location.latitude;
    session.longitud = message.location.longitude;
    await saveSession(env, session);
    if (session.paso === "PIDIENDO_UBICACION") await askPayment(env, session);
    else await sendText(env, phone, "Ubicación recibida. Para hacer un pedido, escribe “Hola”.");
    return;
  }

  if (session.paso === "INICIO" || command === "hola" || command === "menu" || command === "menú" || command === "inicio") {
    await showHome(env, phone);
    return;
  }
  if (session.paso === "ELIGIENDO_PRODUCTOS") {
    await sendText(env, phone, "Elige un producto de la lista. También puedes escribir “Hablar con un encargado”.");
    await showMenu(env, phone, true);
    return;
  }
  await showHome(env, phone);
}
