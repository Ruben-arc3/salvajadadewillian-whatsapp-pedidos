import type { Env } from "./types";
import { sendText } from "./whatsapp";

type Role = "ADMIN" | "CAJERO";
interface Principal { userId: string; name: string; role: Role; expiresAt: number }
interface SyncEvent { client_uuid: string; type: string; payload: Record<string, unknown> }
interface Product { id: string; nombre: string; precio: number; disponible: number }
interface Ingredient { id: string; existencia: number; costo_unitario: number }

const response = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value);
const money = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

function equal(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}

function encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
}

async function sign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function token(env: Env, principal: Principal): Promise<string> {
  const secret = env.POS_AUTH_SECRET || env.ADMIN_PASSWORD;
  if (!secret) throw new Error("Configura POS_AUTH_SECRET en Cloudflare.");
  const payload = encode(JSON.stringify(principal));
  return payload + "." + await sign(secret, payload);
}

async function principalFor(request: Request, env: Env): Promise<Principal | null> {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  const parts = header.slice(7).split(".");
  const secret = env.POS_AUTH_SECRET || env.ADMIN_PASSWORD;
  if (parts.length !== 2 || !secret || !equal(await sign(secret, parts[0]), parts[1])) return null;
  try {
    const value = JSON.parse(decode(parts[0])) as Principal;
    if (!value.userId || !value.name || !["ADMIN", "CAJERO"].includes(value.role) ||
      !Number.isFinite(value.expiresAt) || value.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    return value;
  } catch { return null; }
}

async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json() as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

async function requireUser(request: Request, env: Env): Promise<Principal | Response> {
  const value = await principalFor(request, env);
  return value || response({ message: "Sesión inválida o vencida." }, 401);
}

function isResponse(value: Principal | Response): value is Response { return value instanceof Response; }

function localOrderStorageError(error: unknown): Response {
  const detail = error instanceof Error ? error.message : "Error desconocido de D1.";
  console.error("Local order D1 operation failed", detail);
  const message = /no such column:.*(origen|client_uuid)|no such column.*(origen|client_uuid)/i.test(detail)
    ? "La base D1 no tiene la migración 0008. Ejecuta las migraciones remotas y vuelve a intentar."
    : "D1 no pudo guardar o consultar el pedido local: " + detail.slice(0, 240);
  return response({message},500);
}

function archiveDeliveredOrder(env: Env, orderId: number): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO ventas_historial (
    id,tipo,referencia,pedido_id,origen,cliente,telefono,modalidad,direccion,
    metodo_pago,efectivo,transferencia,subtotal,domicilio,total,productos_json,vendido_en
  ) SELECT 'PEDIDO:' || p.id,'PEDIDO',CAST(p.id AS TEXT),p.id,p.origen,
    p.nombre_cliente,p.telefono,p.metodo_entrega,p.direccion,i.metodo_pago,
    i.monto_efectivo,i.monto_transferencia,p.total,0,p.total,p.carrito_json,i.registrado_en
    FROM pedidos p JOIN ingresos i ON i.pedido_id=p.id
    WHERE p.id=? AND p.estado='ENTREGADO'
    ON CONFLICT(id) DO NOTHING`).bind(orderId);
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await bodyOf(request);
  const username = text(body?.username);
  const pin = text(body?.pin);
  if (!username || !pin || !env.ADMIN_PASSWORD) return response({ message: "Usuario o PIN incorrectos." }, 401);

  if (["admin", "administrador"].includes(username.toLowerCase()) && equal(pin, env.ADMIN_PASSWORD)) {
    await env.DB.prepare("INSERT INTO usuarios (id,nombre,rol,pin_salt,pin_hash,activo) VALUES ('env-admin','Administrador principal','ADMIN','cloudflare-secret','environment-auth',1) ON CONFLICT(id) DO UPDATE SET activo=1,rol='ADMIN'").run();
    const user: Principal = { userId: "env-admin", name: "Administrador", role: "ADMIN", expiresAt: Math.floor(Date.now() / 1000) + 43200 };
    return response({ token: await token(env, user), user_id: user.userId, name: user.name, role: user.role });
  }

  const staff = await env.DB.prepare("SELECT id,nombre,rol,pin_salt,pin_hash FROM usuarios WHERE nombre=? COLLATE NOCASE AND activo=1")
    .bind(username).first<{ id: string; nombre: string; rol: Role; pin_salt: string; pin_hash: string }>();
  if (!staff || !/^\d{4,8}$/.test(pin)) return response({ message: "Usuario o PIN incorrectos." }, 401);
  const secret = env.POS_AUTH_SECRET || env.ADMIN_PASSWORD;
  if (!equal(await sign(secret, "pin|" + staff.id + "|" + staff.pin_salt + "|" + pin), staff.pin_hash)) {
    return response({ message: "Usuario o PIN incorrectos." }, 401);
  }
  const user: Principal = { userId: staff.id, name: staff.nombre, role: staff.rol, expiresAt: Math.floor(Date.now() / 1000) + 43200 };
  return response({ token: await token(env, user), user_id: user.userId, name: user.name, role: user.role });
}

async function adminPrincipal(request: Request, env: Env): Promise<Principal | Response> {
  const user = await requireUser(request, env);
  if (isResponse(user)) return user;
  return user.role === "ADMIN" ? user : response({ message: "Esta acción requiere el rol ADMIN." }, 403);
}

async function openShift(env: Env, user: Principal, id: string) {
  return env.DB.prepare("SELECT id,base_inicial FROM turnos WHERE id=? AND usuario_id=? AND estado='ABIERTO'")
    .bind(id, user.userId).first<{ id: string; base_inicial: number }>();
}

async function previousSyncResult(env: Env, id: string): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare("SELECT resultado_json FROM sincronizaciones WHERE client_uuid=?")
    .bind(id).first<{ resultado_json: string }>();
  if (!row) return null;
  try { return JSON.parse(row.resultado_json) as Record<string, unknown>; }
  catch { return {}; }
}

function audit(env: Env, id: string, user: Principal, action: string, entity: string, entityId: string, reason: string, details: unknown) {
  return env.DB.prepare("INSERT INTO auditoria (client_uuid,usuario_id,accion,entidad,entidad_id,motivo,detalles_json) VALUES (?,?,?,?,?,?,?)")
    .bind(id, user.userId, action, entity, entityId, reason, JSON.stringify(details));
}

function receipt(env: Env, id: string, user: Principal, type: string, result: unknown = {}) {
  return env.DB.prepare("INSERT INTO sincronizaciones (client_uuid,usuario_id,tipo,resultado_json) VALUES (?,?,?,?)")
    .bind(id, user.userId, type, JSON.stringify(result));
}

async function processEvent(env: Env, user: Principal, event: SyncEvent): Promise<Record<string, unknown>> {
  const id = event.client_uuid;
  const p = event.payload || {};
  if (!uuid(id)) throw new Error("client_uuid inválido.");
  const priorResult = await previousSyncResult(env, id);
  if (priorResult) return { ...priorResult, client_uuid: id, duplicate: true };

  if (event.type === "shift_open") {
    const shift = text(p.shift_id);
    const opening = money(p.opening_cash);
    if (!uuid(shift) || opening === null) throw new Error("Datos de apertura inválidos.");
    if (await env.DB.prepare("SELECT id FROM turnos WHERE usuario_id=? AND estado='ABIERTO'").bind(user.userId).first()) {
      throw new Error("Ya tienes un turno abierto.");
    }
    await env.DB.batch([
      env.DB.prepare("INSERT INTO turnos (id,usuario_id,base_inicial) VALUES (?,?,?)").bind(shift, user.userId, opening),
      audit(env,id,user,"ABRIR_TURNO","TURNO",shift,"Apertura de caja",{ opening_cash: opening }),
      receipt(env,id,user,event.type,{ shift_id: shift }),
    ]);
    return { client_uuid: id, shift_id: shift };
  }

  if (event.type === "shift_close") {
    const shiftId = text(p.shift_id);
    const countedCash = money(p.counted_cash);
    const countedTransfer = money(p.counted_transfer);
    const shift = shiftId ? await openShift(env,user,shiftId) : null;
    if (!shift || countedCash === null || countedTransfer === null) throw new Error("Turno abierto o valores de cierre inválidos.");
    const sales = await env.DB.prepare("SELECT COALESCE(SUM(efectivo),0) AS cash,COALESCE(SUM(transferencia),0) AS transfer FROM ventas WHERE turno_id=? AND estado='CONFIRMADA'")
      .bind(shiftId).first<{ cash: number; transfer: number }>();
    const wa = await env.DB.prepare("SELECT COALESCE(SUM(monto_efectivo),0) AS cash,COALESCE(SUM(monto_transferencia),0) AS transfer FROM ingresos WHERE turno_id=?")
      .bind(shiftId).first<{ cash: number; transfer: number }>();
    const cashMoves = await env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN tipo='APORTE_BASE' THEN monto ELSE -monto END),0) AS net FROM movimientos_caja WHERE turno_id=?")
      .bind(shiftId).first<{ net: number }>();
    const expectedCash = Number(shift.base_inicial) + Number(sales?.cash || 0) + Number(wa?.cash || 0) + Number(cashMoves?.net || 0);
    const expectedTransfer = Number(sales?.transfer || 0) + Number(wa?.transfer || 0);
    const result = { client_uuid:id, shift_id:shiftId, expected_cash:expectedCash, expected_transfer:expectedTransfer, difference_cash:countedCash-expectedCash, difference_transfer:countedTransfer-expectedTransfer };
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cierres_turno (turno_id,usuario_id,efectivo_contado,transferencia_contada,efectivo_esperado,transferencia_esperada,diferencia_efectivo,diferencia_transferencia,client_uuid) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(shiftId,user.userId,countedCash,countedTransfer,expectedCash,expectedTransfer,countedCash-expectedCash,countedTransfer-expectedTransfer,id),
      env.DB.prepare("UPDATE turnos SET estado='CERRADO',cerrado_en=CURRENT_TIMESTAMP,efectivo_contado=?,transferencia_contada=?,efectivo_esperado=?,transferencia_esperada=?,diferencia_efectivo=?,diferencia_transferencia=? WHERE id=? AND usuario_id=? AND estado='ABIERTO'")
        .bind(countedCash,countedTransfer,expectedCash,expectedTransfer,countedCash-expectedCash,countedTransfer-expectedTransfer,shiftId,user.userId),
      audit(env,id,user,"CERRAR_TURNO","TURNO",shiftId,"Cierre ciego de caja",result),
      receipt(env,id,user,event.type,result),
    ]);
    return result;
  }

  if (event.type === "cash_movement") {
    const shiftId = text(p.shift_id);
    const kind = text(p.movement_type);
    const amount = money(p.amount);
    const reason = text(p.note);
    if (!shiftId || !["GASTO","APORTE_BASE"].includes(kind) || amount === null || amount < 1 || !reason) throw new Error("Movimiento: tipo, turno, valor y motivo obligatorios.");
    if (!(await openShift(env,user,shiftId))) throw new Error("El turno no está abierto.");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO movimientos_caja (client_uuid,turno_id,usuario_id,tipo,monto,nota,referencia) VALUES (?,?,?,?,?,?,?)")
        .bind(id,shiftId,user.userId,kind,amount,reason,text(p.reference)||null),
      audit(env,id,user,kind,"CAJA",shiftId,reason,{ amount, reference:p.reference||null }),
      receipt(env,id,user,event.type),
    ]);
    return { client_uuid:id };
  }

  if (event.type === "local_delivered") {
    const orderId = Number(p.order_id);
    const shiftId = text(p.shift_id);
    const cash = money(p.cash);
    const transfer = money(p.transfer);
    if (!Number.isSafeInteger(orderId) || orderId < 1 || cash === null || transfer === null) {
      throw new Error("Datos de entrega del pedido local inválidos.");
    }
    if (!(await openShift(env,user,shiftId))) throw new Error("Abre un turno antes de entregar pedidos.");
    const order = await env.DB.prepare("SELECT total,estado,origen,metodo_pago,costo_insumos FROM pedidos WHERE id=?")
      .bind(orderId).first<{total:number;estado:string;origen:string;metodo_pago:string;costo_insumos:number}>();
    if (!order || order.origen !== "LOCAL" || order.estado !== "TERMINADO") {
      throw new Error("Solo se puede entregar un pedido local terminado.");
    }
    if (cash + transfer !== Number(order.total)) throw new Error("El pago no coincide con el total del pedido.");
    const method = cash > 0 && transfer > 0 ? "Mixto" : cash > 0 ? "Efectivo" : "Transferencia";
    await env.DB.batch([
      env.DB.prepare("UPDATE pedidos SET estado='ENTREGADO',metodo_pago=? WHERE id=? AND estado='TERMINADO' AND origen='LOCAL'").bind(method,orderId),
      env.DB.prepare("INSERT INTO ingresos (pedido_id,monto,metodo_pago,turno_id,usuario_id,monto_efectivo,monto_transferencia,origen) VALUES (?,?,?,?,?,?,?,'LOCAL') ON CONFLICT(pedido_id) DO NOTHING")
        .bind(orderId,order.total,method,shiftId,user.userId,cash,transfer),
      archiveDeliveredOrder(env,orderId),
      audit(env,id,user,"ENTREGAR_PEDIDO_LOCAL","PEDIDO",String(orderId),"Entrega confirmada desde caja",{total:order.total,cost:order.costo_insumos,payment_method:method,shift_id:shiftId}),
      receipt(env,id,user,event.type,{order_id:orderId,income:order.total}),
    ]);
    return {client_uuid:id,order_id:orderId,income:order.total};
  }

  if (event.type === "whatsapp_delivered") {
    const orderId = Number(p.order_id);
    const shiftId = text(p.shift_id);
    if (!Number.isSafeInteger(orderId) || orderId < 1) throw new Error("Pedido inválido.");
    const order = await env.DB.prepare("SELECT telefono,nombre_cliente,total,metodo_pago,estado,receta_snapshot_json,costo_insumos,insumos_consumidos,mensaje_entrega_estado,mensaje_entrega_error FROM pedidos WHERE id=?").bind(orderId)
      .first<{ telefono:string; nombre_cliente:string; total:number; metodo_pago:string; estado:string; receta_snapshot_json:string; costo_insumos:number; insumos_consumidos:number; mensaje_entrega_estado:string; mensaje_entrega_error:string|null }>();
    if (!order || !["TERMINADO", "ENTREGADO"].includes(order.estado)) throw new Error("Solo se entrega un pedido terminado.");
    const cash = order.metodo_pago.toLowerCase() === "efectivo";
    const total = Number(order.total);
    if (order.estado === "TERMINADO") {
      if (!(await openShift(env,user,shiftId))) throw new Error("Abre un turno antes de entregar pedidos.");
      let recipe: Array<{ingredient_id:string;quantity:number;unit_cost:number}>;
      try { recipe = JSON.parse(order.receta_snapshot_json || "[]") as typeof recipe; }
      catch { throw new Error("No se pudo leer la receta histórica del pedido."); }
      const statements: D1PreparedStatement[] = [];
      for (const ingredient of order.insumos_consumidos?[]:recipe) {
        if (!ingredient.ingredient_id || !Number.isFinite(ingredient.quantity) || ingredient.quantity <= 0) throw new Error("Receta histórica inválida.");
        const current = await env.DB.prepare("SELECT existencia FROM insumos WHERE id=? AND activo=1").bind(ingredient.ingredient_id).first<{existencia:number}>();
        if (!current || Number(current.existencia) < ingredient.quantity) throw new Error("No hay existencias para entregar este pedido. Registra el ajuste o compra primero.");
        const movementId = id + "-wa-" + ingredient.ingredient_id;
        statements.push(
          env.DB.prepare("UPDATE insumos SET existencia=existencia-?,actualizado_en=CURRENT_TIMESTAMP WHERE id=? AND existencia>=?").bind(ingredient.quantity,ingredient.ingredient_id,ingredient.quantity),
          env.DB.prepare("INSERT INTO movimientos_inventario (client_uuid,insumo_id,usuario_id,turno_id,tipo,cantidad,costo_unitario,motivo,referencia) VALUES (?,?,?,?,'VENTA',?,?,?,?)")
            .bind(movementId,ingredient.ingredient_id,user.userId,shiftId,-ingredient.quantity,ingredient.unit_cost,"Consumo por pedido WhatsApp #"+orderId,String(orderId)),
        );
      }
      statements.push(
        env.DB.prepare("UPDATE pedidos SET estado='ENTREGADO' WHERE id=? AND estado='TERMINADO'").bind(orderId),
        env.DB.prepare("INSERT INTO ingresos (pedido_id,monto,metodo_pago,turno_id,usuario_id,monto_efectivo,monto_transferencia,origen) SELECT id,total,metodo_pago,?,?,?,?,'WHATSAPP' FROM pedidos WHERE id=? AND estado='ENTREGADO' ON CONFLICT(pedido_id) DO NOTHING")
          .bind(shiftId,user.userId,cash?total:0,cash?0:total,orderId),
        archiveDeliveredOrder(env,orderId),
        audit(env,id,user,"ENTREGAR_PEDIDO","PEDIDO",String(orderId),"Entrega confirmada desde caja",{total,cost:Number(order.costo_insumos),payment_method:order.metodo_pago,shift_id:shiftId}),
      );
      await env.DB.batch(statements);
    }

    let messageSent = order.mensaje_entrega_estado === "ENVIADO";
    let messageError = order.mensaje_entrega_error;
    if (order.mensaje_entrega_estado === "PENDIENTE") {
      try {
        await sendText(env, order.telefono, `Hola ${order.nombre_cliente}, tu pedido de La Salvajada de Willian está listo. ¡Gracias por tu compra!`);
        await env.DB.prepare("UPDATE pedidos SET mensaje_entrega_estado='ENVIADO',mensaje_entrega_error=NULL WHERE id=? AND mensaje_entrega_estado='PENDIENTE'")
          .bind(orderId).run();
        messageSent = true;
        messageError = null;
      } catch (error) {
        messageSent = false;
        messageError = error instanceof Error ? error.message.slice(0, 500) : "No se pudo enviar el mensaje por WhatsApp.";
        await env.DB.prepare("UPDATE pedidos SET mensaje_entrega_estado='ERROR',mensaje_entrega_error=? WHERE id=? AND mensaje_entrega_estado='PENDIENTE'")
          .bind(messageError,orderId).run();
      }
    }
    const result = { order_id:orderId, income:total, message_sent:messageSent, message_error:messageError };
    await env.DB.batch([receipt(env,id,user,event.type,result)]);
    return { client_uuid:id, ...result };
  }

  if (event.type === "whatsapp_status") {
    const orderId=Number(p.order_id);const next=text(p.status);const reason=text(p.reason);
    if(!Number.isSafeInteger(orderId)||orderId<1||!['TERMINADO','CANCELADO'].includes(next)||(next==='CANCELADO'&&!reason))throw new Error("Estado o motivo de cancelación inválido.");
    const shiftId=text(p.shift_id);
    if(next==='TERMINADO'&&!(await openShift(env,user,shiftId)))throw new Error("Abre un turno antes de terminar pedidos.");
    const order=await env.DB.prepare("SELECT estado,origen,receta_snapshot_json,insumos_consumidos FROM pedidos WHERE id=?").bind(orderId).first<{estado:string;origen:string;receta_snapshot_json:string;insumos_consumidos:number}>();
    if(!order||!['RECIBIDO','TERMINADO'].includes(order.estado))throw new Error("El pedido ya no permite cambiar de estado.");
    if(next==='TERMINADO'&&order.estado!=='RECIBIDO')throw new Error("El pedido no está recibido.");
    let recipe:Array<{ingredient_id:string;quantity:number;unit_cost:number}>=[];
    if(next==='TERMINADO'&&!order.insumos_consumidos){try{recipe=JSON.parse(order.receta_snapshot_json||'[]') as typeof recipe;}catch{throw new Error('Receta del pedido inválida.');}}
    const statements:D1PreparedStatement[]=[];
    for(const ingredient of recipe){
      if(!ingredient.ingredient_id||!Number.isFinite(ingredient.quantity)||ingredient.quantity<=0)throw new Error('Receta del pedido inválida.');
      const current=await env.DB.prepare("SELECT existencia FROM insumos WHERE id=? AND activo=1").bind(ingredient.ingredient_id).first<{existencia:number}>();
      if(!current||Number(current.existencia)<ingredient.quantity)throw new Error('No hay inventario suficiente para marcar como terminado.');
      statements.push(env.DB.prepare("UPDATE insumos SET existencia=existencia-?,actualizado_en=CURRENT_TIMESTAMP WHERE id=? AND existencia>=?").bind(ingredient.quantity,ingredient.ingredient_id,ingredient.quantity));
      statements.push(env.DB.prepare("INSERT INTO movimientos_inventario (client_uuid,insumo_id,usuario_id,turno_id,tipo,cantidad,costo_unitario,motivo,referencia) VALUES (?,?,?,?,'VENTA',?,?,?,?)").bind(id+'-wa-'+ingredient.ingredient_id,ingredient.ingredient_id,user.userId,shiftId,-ingredient.quantity,ingredient.unit_cost,'Preparación pedido WhatsApp #'+orderId,String(orderId)));
    }
    statements.push(env.DB.prepare("UPDATE pedidos SET estado=?,insumos_consumidos=CASE WHEN ?='TERMINADO' AND receta_snapshot_json<>'[]' THEN 1 ELSE insumos_consumidos END WHERE id=? AND estado=?").bind(next,next,orderId,order.estado));
    if(next==='CANCELADO'&&order.estado==='TERMINADO'&&order.insumos_consumidos){
      let consumed:Array<{ingredient_id:string;quantity:number;unit_cost:number}>=[];
      try{consumed=JSON.parse(order.receta_snapshot_json||'[]') as typeof consumed;}catch{}
      for(const ingredient of consumed)statements.push(env.DB.prepare("INSERT INTO movimientos_inventario (client_uuid,insumo_id,usuario_id,tipo,cantidad,costo_unitario,motivo,referencia) VALUES (?,?,?,'MERMA',?,?,?,?)").bind(id+'-wacancel-'+ingredient.ingredient_id,ingredient.ingredient_id,user.userId,-ingredient.quantity,ingredient.unit_cost,'Pedido '+order.origen.toLowerCase()+' cancelado después de preparación: '+reason,String(orderId)));
    }
    statements.push(
      audit(env,id,user,next==='CANCELADO'?'CANCELAR_PEDIDO':'TERMINAR_PEDIDO','PEDIDO',String(orderId),reason||'Pedido listo para entregar',{previous_status:order.estado,source:order.origen}),
      receipt(env,id,user,event.type,{order_id:orderId,status:next}),
    );
    await env.DB.batch(statements);
    return {client_uuid:id,order_id:orderId,status:next};
  }

  if (["inventory_purchase","inventory_loss","inventory_adjustment"].includes(event.type)) {
    if (user.role !== "ADMIN") throw new Error("Solo ADMIN puede cambiar existencias.");
    const itemId = text(p.ingredient_id);
    const quantity = Number(p.quantity);
    const reason = text(p.reason);
    const totalCost = Number(p.total_cost || 0);
    const item = await env.DB.prepare("SELECT existencia,costo_unitario FROM insumos WHERE id=? AND activo=1")
      .bind(itemId).first<Ingredient>();
    if (!item || !Number.isFinite(quantity) || quantity === 0 || !reason || !Number.isFinite(totalCost) || totalCost < 0) {
      throw new Error("Insumo, cantidad, costo y motivo requeridos.");
    }
    const kind = event.type === "inventory_purchase" ? "COMPRA" : event.type === "inventory_loss" ? (text(p.loss_type) === "CONSUMO_INTERNO" ? "CONSUMO_INTERNO" : "MERMA") : "AJUSTE";
    if((kind==='COMPRA'&&quantity<=0)||(kind!=='AJUSTE'&&kind!=='COMPRA'&&quantity<=0))throw new Error("La cantidad debe ser positiva para compras y mermas; usa negativo solo en ajustes.");
    const delta = kind === "COMPRA" ? Math.abs(quantity) : kind==='AJUSTE' ? quantity : -Math.abs(quantity);
    if (Number(item.existencia) + delta < 0) throw new Error("El ajuste excede las existencias disponibles.");
    const unitCost = kind === "COMPRA" ? totalCost / Math.abs(quantity) : Number(item.costo_unitario);
    const newCost = kind === "COMPRA" && Number(item.existencia)+delta>0
      ? ((Number(item.existencia)*Number(item.costo_unitario))+totalCost)/(Number(item.existencia)+delta)
      : Number(item.costo_unitario);
    const statements = [
      env.DB.prepare("UPDATE insumos SET existencia=existencia+?,costo_unitario=CASE WHEN ?='COMPRA' AND existencia+?>0 THEN ((existencia*costo_unitario)+?)/(existencia+?) ELSE costo_unitario END,actualizado_en=CURRENT_TIMESTAMP WHERE id=?")
        .bind(delta,kind,delta,totalCost,delta,itemId),
      env.DB.prepare("INSERT INTO movimientos_inventario (client_uuid,insumo_id,usuario_id,turno_id,tipo,cantidad,costo_unitario,motivo,referencia) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(id,itemId,user.userId,text(p.shift_id)||null,kind,delta,unitCost,reason,text(p.reference)||null),
      audit(env,id,user,kind,"INSUMO",itemId,reason,{ quantity:delta, unit_cost:unitCost, reference:p.reference||null }),
    ];
    if(kind==='COMPRA' && newCost!==Number(item.costo_unitario)) statements.push(
      env.DB.prepare("INSERT INTO historial_costos (id,insumo_id,costo_anterior,costo_nuevo,usuario_id,motivo) VALUES (?,?,?,?,?,?)")
        .bind(id+"-cost",itemId,item.costo_unitario,newCost,user.userId,reason),
    );
    statements.push(receipt(env,id,user,event.type));
    await env.DB.batch(statements);
    return { client_uuid:id };
  }

  if (event.type === "sale") return createSale(env,user,event);
  throw new Error("Tipo de sincronización no reconocido.");
}

async function createSale(env: Env, user: Principal, event: SyncEvent): Promise<Record<string, unknown>> {
  const p = event.payload;
  const shiftId = text(p.shift_id);
  const items = Array.isArray(p.items) ? p.items as Array<Record<string, unknown>> : [];
  const cash = money(p.cash);
  const transfer = money(p.transfer);
  const delivery = money(p.delivery_fee || 0);
  const modality=text(p.modality||'LOCAL');const customer=text(p.customer);const address=text(p.address);
  if (!shiftId || !items.length || items.length > 40 || cash === null || transfer === null || delivery === null || !['LOCAL','LLEVAR','DOMICILIO'].includes(modality) || (modality==='DOMICILIO'&&delivery>0&&!address)) throw new Error("Venta incompleta o modalidad/dirección inválida.");
  if (!(await openShift(env,user,shiftId))) throw new Error("El turno no está abierto.");
  let subtotal = 0;
  let costTotal = 0;
  const stock = new Map<string,number>();
  const stockValue = new Map<string,number>();
  const details: Array<{ id:string; product:Product; qty:number; cost:number; price:number; modifiers:string[]; note:string }> = [];
  for (const line of items) {
    const productId = text(line.product_id);
    const qty = Number(line.quantity);
    if (!productId || !Number.isSafeInteger(qty) || qty < 1 || qty > 100) throw new Error("Producto o cantidad inválida.");
    const product = await env.DB.prepare("SELECT id,nombre,precio,disponible FROM productos WHERE id=?").bind(productId).first<Product>();
    if (!product || product.disponible !== 1) throw new Error("Un producto de la venta está inactivo.");
    // The server is the source of truth: never trust recipe, unit price, or
    // modifier-price snapshots sent by an offline client.
    const recipe = (await env.DB.prepare("SELECT r.insumo_id,r.cantidad,i.costo_unitario FROM recetas r JOIN insumos i ON i.id=r.insumo_id WHERE r.producto_id=? AND i.activo=1")
      .bind(productId).all<{insumo_id:string;cantidad:number;costo_unitario:number}>()).results;
    // Some menu items are not inventory controlled (for example drinks or
    // packaged goods). An empty recipe means zero tracked ingredient cost.
    let lineCost = 0;
    for (const ingredient of recipe) {
      if(!ingredient.insumo_id||!Number.isFinite(ingredient.cantidad)||ingredient.cantidad<=0||!Number.isFinite(ingredient.costo_unitario)||ingredient.costo_unitario<0)throw new Error("La receta guardada de la venta es inválida.");
      const need = Number(ingredient.cantidad) * qty;
      stock.set(ingredient.insumo_id,(stock.get(ingredient.insumo_id)||0)+need);
      stockValue.set(ingredient.insumo_id,(stockValue.get(ingredient.insumo_id)||0)+need*Number(ingredient.costo_unitario));
      lineCost += need * Number(ingredient.costo_unitario);
    }
    const modifierIds=Array.isArray(line.modifier_ids)?line.modifier_ids.map(text).filter(Boolean):[];
    const modifierNames:string[]=[];let modifierPrice=0;
    for(const modifierId of modifierIds){
      const modifier=await env.DB.prepare("SELECT m.nombre,m.precio_extra FROM modificadores m JOIN producto_modificadores pm ON pm.modificador_id=m.id WHERE pm.producto_id=? AND m.id=? AND m.activo=1")
        .bind(productId,modifierId).first<{nombre:string;precio_extra:number}>();
      if(!modifier)throw new Error("Una adición no está disponible para este producto.");
      modifierNames.push(modifier.nombre);modifierPrice+=Number(modifier.precio_extra);
      const extraRecipe=await env.DB.prepare("SELECT r.insumo_id,r.cantidad,i.costo_unitario FROM receta_modificadores r JOIN insumos i ON i.id=r.insumo_id WHERE r.modificador_id=? AND i.activo=1")
        .bind(modifierId).all<{insumo_id:string;cantidad:number;costo_unitario:number}>();
      for(const extra of extraRecipe.results){const need=Number(extra.cantidad)*qty;stock.set(extra.insumo_id,(stock.get(extra.insumo_id)||0)+need);stockValue.set(extra.insumo_id,(stockValue.get(extra.insumo_id)||0)+need*Number(extra.costo_unitario));lineCost+=need*Number(extra.costo_unitario);}
    }
    const basePrice=Number(product.precio);
    subtotal += (basePrice+modifierPrice) * qty;
    costTotal += lineCost;
    details.push({ id:event.client_uuid+":"+details.length, product, qty, cost:lineCost/qty, price:basePrice+modifierPrice, modifiers:modifierNames, note:text(line.notes) });
  }
  const total = subtotal + delivery;
  if (cash + transfer !== total) throw new Error("El pago no coincide con el total de la venta.");
  for (const [ingredientId,qty] of stock) {
    const current = await env.DB.prepare("SELECT existencia FROM insumos WHERE id=? AND activo=1").bind(ingredientId).first<{existencia:number}>();
    if (!current || Number(current.existencia) < qty) throw new Error("No hay existencias suficientes para esta venta.");
  }
  const statements = [
    env.DB.prepare("INSERT INTO ventas (client_uuid,turno_id,usuario_id,subtotal,domicilio,efectivo,transferencia,costo_insumos,notas,modalidad,cliente,direccion) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(event.client_uuid,shiftId,user.userId,subtotal,delivery,cash,transfer,costTotal,text(p.note),modality,customer,address),
    ...details.map((line) => env.DB.prepare("INSERT INTO venta_detalles (id,venta_uuid,producto_id,nombre_snapshot,cantidad,precio_unitario,costo_unitario,modificadores_json,notas) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(line.id,event.client_uuid,line.product.id,line.product.nombre,line.qty,line.price,line.cost,JSON.stringify(line.modifiers),line.note)),
    env.DB.prepare(`INSERT INTO ventas_historial (
      id,tipo,referencia,pedido_id,origen,cliente,telefono,modalidad,direccion,
      metodo_pago,efectivo,transferencia,subtotal,domicilio,total,productos_json,vendido_en
    ) SELECT 'VENTA:' || v.client_uuid,'VENTA',v.client_uuid,NULL,'LOCAL',v.cliente,'',
      v.modalidad,v.direccion,
      CASE WHEN v.efectivo>0 AND v.transferencia>0 THEN 'Mixto'
           WHEN v.efectivo>0 THEN 'Efectivo' ELSE 'Transferencia' END,
      v.efectivo,v.transferencia,v.subtotal,v.domicilio,v.subtotal+v.domicilio,
      COALESCE((SELECT json_group_array(json_object(
        'productId',d.producto_id,'name',d.nombre_snapshot,'quantity',d.cantidad,
        'price',d.precio_unitario,'modifiers',json(d.modificadores_json),'notes',d.notas
      )) FROM venta_detalles d WHERE d.venta_uuid=v.client_uuid),'[]'),v.creado_en
      FROM ventas v WHERE v.client_uuid=? ON CONFLICT(id) DO NOTHING`).bind(event.client_uuid),
    ...[...stock].map(([ingredientId,qty]) => env.DB.prepare("UPDATE insumos SET existencia=existencia-?,actualizado_en=CURRENT_TIMESTAMP WHERE id=? AND existencia>=?").bind(qty,ingredientId,qty)),
    ...[...stock].map(([ingredientId,qty]) => env.DB.prepare("INSERT INTO movimientos_inventario (client_uuid,insumo_id,usuario_id,turno_id,tipo,cantidad,costo_unitario,motivo) VALUES (?,?,?,?,'VENTA',?,?,?)")
      .bind(event.client_uuid+":"+ingredientId,ingredientId,user.userId,shiftId,-qty,(stockValue.get(ingredientId)||0)/qty,"Descuento por venta")),
    audit(env,event.client_uuid,user,"CREAR_VENTA","VENTA",event.client_uuid,text(p.note)||"Venta de mostrador",{total,cash,transfer,costTotal}),
    receipt(env,event.client_uuid,user,event.type,{total,cost_insumos:costTotal}),
  ];
  await env.DB.batch(statements);
  return { client_uuid:event.client_uuid,total,cost_insumos:costTotal };
}

async function createLocalOrder(request: Request, env: Env, user: Principal): Promise<Response> {
  const body = await bodyOf(request);
  const clientUuid = text(body?.client_uuid);
  const rawItems = Array.isArray(body?.items) ? body.items as Array<Record<string, unknown>> : [];
  const customer = text(body?.customer) || "Cliente local";
  const phone = text(body?.phone).replace(/[^0-9+]/g, "").slice(0, 20);
  const address = text(body?.address).slice(0, 300);
  const modality = text(body?.modality || "LOCAL");
  if (!uuid(clientUuid) || !rawItems.length || rawItems.length > 40 || !["LOCAL","LLEVAR","DOMICILIO"].includes(modality)) {
    return response({message:"Datos del pedido local inválidos."},400);
  }
  const existing = await env.DB.prepare("SELECT id FROM pedidos WHERE client_uuid=?").bind(clientUuid).first<{id:number}>();
  if (existing) return response({id:existing.id,client_uuid:clientUuid,source:"LOCAL",duplicate:true});

  const cart: Array<Record<string, unknown>> = [];
  const recipeByIngredient = new Map<string,{ingredient_id:string;quantity:number;unit_cost:number}>();
  let total = 0;
  let cost = 0;
  for (const item of rawItems) {
    const productId = text(item.product_id);
    const quantity = Number(item.quantity);
    if (!productId || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) {
      return response({message:"Producto o cantidad inválida."},400);
    }
    const product = await env.DB.prepare("SELECT id,nombre,categoria,precio,disponible FROM productos WHERE id=?").bind(productId)
      .first<{id:string;nombre:string;categoria:string;precio:number;disponible:number}>();
    if (!product || product.disponible !== 1) return response({message:"Un producto ya no está disponible."},400);
    const modifierIds = Array.isArray(item.modifier_ids) ? item.modifier_ids.map(text).filter(Boolean) : [];
    const modifierNames: string[] = [];
    let extra = 0;
    for (const modifierId of modifierIds) {
      const modifier = await env.DB.prepare("SELECT m.nombre,m.precio_extra FROM modificadores m JOIN producto_modificadores pm ON pm.modificador_id=m.id WHERE pm.producto_id=? AND m.id=? AND m.activo=1")
        .bind(productId,modifierId).first<{nombre:string;precio_extra:number}>();
      if (!modifier) return response({message:"Una adición ya no está disponible."},400);
      modifierNames.push(modifier.nombre);
      extra += Number(modifier.precio_extra);
    }
    const recipe = await env.DB.prepare("SELECT r.insumo_id,r.cantidad,i.costo_unitario FROM recetas r JOIN insumos i ON i.id=r.insumo_id AND i.activo=1 WHERE r.producto_id=?")
      .bind(productId).all<{insumo_id:string;cantidad:number;costo_unitario:number}>();
    for (const row of recipe.results) {
      const amount = Number(row.cantidad) * quantity;
      const prior = recipeByIngredient.get(row.insumo_id);
      recipeByIngredient.set(row.insumo_id,{ingredient_id:row.insumo_id,quantity:amount+(prior?.quantity||0),unit_cost:Number(row.costo_unitario)});
      cost += amount * Number(row.costo_unitario);
    }
    for (const modifierId of modifierIds) {
      const extraRecipe = await env.DB.prepare("SELECT r.insumo_id,r.cantidad,i.costo_unitario FROM receta_modificadores r JOIN insumos i ON i.id=r.insumo_id AND i.activo=1 WHERE r.modificador_id=?")
        .bind(modifierId).all<{insumo_id:string;cantidad:number;costo_unitario:number}>();
      for (const row of extraRecipe.results) {
        const amount = Number(row.cantidad) * quantity;
        const prior = recipeByIngredient.get(row.insumo_id);
        recipeByIngredient.set(row.insumo_id,{ingredient_id:row.insumo_id,quantity:amount+(prior?.quantity||0),unit_cost:Number(row.costo_unitario)});
        cost += amount * Number(row.costo_unitario);
      }
    }
    const price = Number(product.precio) + extra;
    total += price * quantity;
    cart.push({productId:product.id,name:product.nombre,category:product.categoria,price,quantity,modifiers:modifierNames});
  }
  const recipeSnapshot = [...recipeByIngredient.values()];
  const insert = await env.DB.prepare("INSERT INTO pedidos (telefono,nombre_cliente,carrito_json,total,direccion,latitud,longitud,metodo_pago,metodo_entrega,estado,costo_insumos,receta_snapshot_json,origen,client_uuid) VALUES (?,?,?,?,?,NULL,NULL,'Pendiente',?,'RECIBIDO',?,?,'LOCAL',?)")
    .bind(phone,customer,JSON.stringify(cart),total,address,modality,cost,JSON.stringify(recipeSnapshot),clientUuid).run();
  const orderId = Number(insert.meta.last_row_id||0);
  await env.DB.batch([audit(env,clientUuid,user,"CREAR_PEDIDO_LOCAL","PEDIDO",String(orderId),"Pedido local creado",{total,customer,phone:phone?"registrado":"omitido",modality}),receipt(env,clientUuid,user,"local_order",{order_id:orderId,total})]);
  return response({id:orderId,client_uuid:clientUuid,source:"LOCAL",status:"RECIBIDO",total});
}

async function sync(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request,env);
  if (isResponse(user)) return user;
  const body = await bodyOf(request);
  const events = Array.isArray(body?.events) ? body.events as SyncEvent[] : [];
  if (!events.length || events.length > 100) return response({message:"Envía entre 1 y 100 eventos."},400);
  const accepted: string[] = [];
  const results: Record<string,unknown>[] = [];
  const rejected: Array<{client_uuid?:string;message:string}> = [];
  for (const event of events) {
    try {
      if (!event || !event.payload || typeof event.payload !== "object") throw new Error("Evento inválido.");
      results.push(await processEvent(env,user,event));
      accepted.push(event.client_uuid);
    } catch (error) {
      rejected.push({client_uuid:event?.client_uuid,message:error instanceof Error?error.message:"No se pudo sincronizar."});
    }
  }
  return response({accepted,results,rejected});
}

async function adminApi(request: Request, env: Env, path: string): Promise<Response> {
  const admin = await adminPrincipal(request,env);
  if (isResponse(admin)) return admin;
  if(path==="/api/admin/products"&&request.method==="GET"){
    const rows=await env.DB.prepare("SELECT id,nombre AS name,categoria AS category,descripcion AS description,precio AS price,disponible AS active FROM productos ORDER BY categoria,nombre").all();
    return response({products:rows.results});
  }
  const body = request.method==="GET" ? {} : await bodyOf(request);
  if (!body) return response({message:"Solicitud inválida."},400);
  if (path === "/api/admin/users" && request.method === "POST") {
    const name = text(body.name);
    const pin = text(body.pin);
    const role = text(body.role);
    if (!name || name.length > 80 || !/^\d{4,8}$/.test(pin) || !["ADMIN","CAJERO"].includes(role)) return response({message:"Nombre, PIN de 4 a 8 dígitos y rol ADMIN o CAJERO requeridos."},400);
    const id = crypto.randomUUID();
    const salt = crypto.randomUUID();
    const pinHash = await sign(env.POS_AUTH_SECRET || env.ADMIN_PASSWORD!, "pin|"+id+"|"+salt+"|"+pin);
    try {
      await env.DB.prepare("INSERT INTO usuarios (id,nombre,rol,pin_salt,pin_hash) VALUES (?,?,?,?,?)").bind(id,name,role,salt,pinHash).run();
    } catch { return response({message:"Ese nombre ya está en uso."},409); }
    return response({id,name,role},201);
  }
  if (path === "/api/admin/products" && request.method === "POST") {
    const id = text(body.id) || crypto.randomUUID();
    const name = text(body.name);
    const category = text(body.category);
    const description = text(body.description);
    const price = money(body.price);
    const reason = text(body.reason);
    if (!name || !category || price === null) return response({message:"Producto, categoría y precio son obligatorios."},400);
    const old = await env.DB.prepare("SELECT nombre,categoria,descripcion,precio,disponible FROM productos WHERE id=?").bind(id).first<{nombre:string;categoria:string;descripcion:string;precio:number;disponible:number}>();
    const active=body.active===false?0:1;
    const changed=Boolean(old&&(old.nombre!==name||old.categoria!==category||old.descripcion!==description||Number(old.precio)!==price||Number(old.disponible)!==active));
    if (changed && !reason) return response({message:"Indica el motivo del cambio de producto."},400);
    const auditId = crypto.randomUUID();
    const statements = [
      env.DB.prepare("INSERT INTO productos (id,nombre,categoria,descripcion,precio,disponible) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET nombre=excluded.nombre,categoria=excluded.categoria,descripcion=excluded.descripcion,precio=excluded.precio,disponible=excluded.disponible")
        .bind(id,name,category,description,price,active),
    ];
    if (old && Number(old.precio)!==price) statements.push(env.DB.prepare("INSERT INTO historial_precios (id,producto_id,precio_anterior,precio_nuevo,usuario_id,motivo) VALUES (?,?,?,?,?,?)").bind(auditId,id,old.precio,price,admin.userId,reason));
    statements.push(audit(env,auditId,admin,old?"EDITAR_PRODUCTO":"CREAR_PRODUCTO","PRODUCTO",id,reason||"Alta de producto",{price,category}));
    await env.DB.batch(statements);
    return response({id,name,category,price});
  }
  if (path === "/api/admin/ingredients" && request.method === "POST") {
    const id = text(body.id) || crypto.randomUUID();
    const name = text(body.name);
    const unit = text(body.unit);
    const quantity = Number(body.quantity || 0);
    const minimum = Number(body.minimum || 0);
    const unitCost = Number(body.unit_cost || 0);
    const reason = text(body.reason);
    if (!name || !["UNIDAD","G","KG","ML","L"].includes(unit) ||
      ![quantity,minimum,unitCost].every(Number.isFinite) || quantity<0 || minimum<0 || unitCost<0 || !reason) {
      return response({message:"Nombre, unidad, existencias iniciales, mínimo, costo y motivo son obligatorios."},400);
    }
    if (await env.DB.prepare("SELECT id FROM insumos WHERE id=? OR nombre=? COLLATE NOCASE").bind(id,name).first()) {
      return response({message:"Ya existe un insumo con ese nombre."},409);
    }
    const auditId=crypto.randomUUID();
    const statements=[env.DB.prepare("INSERT INTO insumos (id,nombre,unidad,existencia,stock_minimo,costo_unitario) VALUES (?,?,?,?,?,?)").bind(id,name,unit,quantity,minimum,unitCost)];
    if(quantity>0) statements.push(env.DB.prepare("INSERT INTO movimientos_inventario (client_uuid,insumo_id,usuario_id,tipo,cantidad,costo_unitario,motivo) VALUES (?,?,?,'AJUSTE',?,?,?)").bind(auditId+"-stock",id,admin.userId,quantity,unitCost,reason));
    statements.push(audit(env,auditId,admin,"CREAR_INSUMO","INSUMO",id,reason,{unit,quantity,minimum,unitCost}));
    await env.DB.batch(statements);
    return response({id,name,unit,quantity,minimum,unit_cost:unitCost},201);
  }
  if (path === "/api/admin/recipes" && request.method === "POST") {
    const productId=text(body.product_id);
    const ingredients=Array.isArray(body.ingredients)?body.ingredients as Array<Record<string,unknown>>:[];
    const reason=text(body.reason);
    if(!productId||!ingredients.length||ingredients.length>80)return response({message:"El producto debe tener por lo menos un insumo en su receta."},400);
    if(new Set(ingredients.map((row)=>text(row.ingredient_id))).size!==ingredients.length)return response({message:"No repitas el mismo insumo en la receta."},400);
    const product=await env.DB.prepare("SELECT id FROM productos WHERE id=?").bind(productId).first();
    if(!product)return response({message:"No existe ese producto."},404);
    const existing=await env.DB.prepare("SELECT COUNT(*) AS total FROM recetas WHERE producto_id=?").bind(productId).first<{total:number}>();
    if(Number(existing?.total)>0&&!reason)return response({message:"Indica el motivo del cambio de receta."},400);
    const validated:Array<{id:string;quantity:number}>=[];
    for(const item of ingredients){
      const ingredientId=text(item.ingredient_id);const quantity=Number(item.quantity);
      if(!ingredientId||!Number.isFinite(quantity)||quantity<=0)return response({message:"Cada ingrediente necesita una cantidad mayor a cero."},400);
      if(!await env.DB.prepare("SELECT id FROM insumos WHERE id=? AND activo=1").bind(ingredientId).first())return response({message:"No se encontró uno de los insumos."},404);
      validated.push({id:ingredientId,quantity});
    }
    const auditId=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM recetas WHERE producto_id=?").bind(productId),
      ...validated.map((item)=>env.DB.prepare("INSERT INTO recetas (producto_id,insumo_id,cantidad) VALUES (?,?,?)").bind(productId,item.id,item.quantity)),
      audit(env,auditId,admin,Number(existing?.total)>0?"CAMBIAR_RECETA":"CREAR_RECETA","PRODUCTO",productId,reason||"Receta inicial",validated),
    ]);
    return response({product_id:productId,ingredients:validated});
  }
  if (path === "/api/admin/modifiers" && request.method === "POST") {
    const id=text(body.id)||crypto.randomUUID();const name=text(body.name);const price=money(body.price_extra);
    const products=Array.isArray(body.product_ids)?body.product_ids.map(text).filter(Boolean):[];
    const ingredients=Array.isArray(body.ingredients)?body.ingredients as Array<Record<string,unknown>>:[];
    const reason=text(body.reason);
    if(!name||price===null||products.length===0)return response({message:"Nombre, precio extra y al menos un producto son obligatorios."},400);
    const old=await env.DB.prepare("SELECT id FROM modificadores WHERE id=?").bind(id).first();
    if(old&&!reason)return response({message:"Indica el motivo del cambio de modificador."},400);
    const validated:Array<{id:string;quantity:number}>=[];
    for(const item of ingredients){const ingredientId=text(item.ingredient_id);const quantity=Number(item.quantity);if(!ingredientId||!Number.isFinite(quantity)||quantity<=0)return response({message:"Revisa los insumos adicionales."},400);if(!await env.DB.prepare("SELECT id FROM insumos WHERE id=? AND activo=1").bind(ingredientId).first())return response({message:"No se encontró un insumo adicional."},404);validated.push({id:ingredientId,quantity});}
    const auditId=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO modificadores (id,nombre,precio_extra) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET nombre=excluded.nombre,precio_extra=excluded.precio_extra,activo=1").bind(id,name,price),
      env.DB.prepare("DELETE FROM producto_modificadores WHERE modificador_id=?").bind(id),
      ...products.map((productId)=>env.DB.prepare("INSERT INTO producto_modificadores (producto_id,modificador_id) VALUES (?,?)").bind(productId,id)),
      env.DB.prepare("DELETE FROM receta_modificadores WHERE modificador_id=?").bind(id),
      ...validated.map((item)=>env.DB.prepare("INSERT INTO receta_modificadores (modificador_id,insumo_id,cantidad) VALUES (?,?,?)").bind(id,item.id,item.quantity)),
      audit(env,auditId,admin,old?"EDITAR_MODIFICADOR":"CREAR_MODIFICADOR","MODIFICADOR",id,reason||"Alta de modificador",{products,price,ingredients:validated}),
    ]);
    return response({id,name,price_extra:price});
  }
  return response({message:"Ruta administrativa no encontrada."},404);
}

export async function handlePos(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/")) return null;
  if (path === "/api/auth/login" && request.method === "POST") return login(request,env);
  if (path === "/api/sync" && request.method === "POST") return sync(request,env);
  if (path.startsWith("/api/admin/")) return adminApi(request,env,path);
  if (path === "/api/pos/orders/local" && request.method === "POST") {
    const user = await requireUser(request,env);
    if (isResponse(user)) return user;
    try {
      return await createLocalOrder(request,env,user);
    } catch (error) {
      return localOrderStorageError(error);
    }
  }
  const allowed = ["/api/pos/dashboard","/api/pos/catalog","/api/pos/orders","/api/pos/sales-history","/api/pos/inventory","/api/pos/audit","/api/pos/reports"];
  if (!allowed.includes(path)) return response({message:"Ruta no encontrada."},404);
  const user = await requireUser(request,env);
  if (isResponse(user)) return user;
  if (path === "/api/pos/catalog") {
    const rows = await env.DB.prepare("SELECT id,nombre AS name,categoria AS category,descripcion AS description,precio AS price,disponible AS available FROM productos WHERE disponible=1 ORDER BY categoria,nombre").all<{id:string;name:string;category:string;description:string;price:number;available:number}>();
    const products=[];
    for(const product of rows.results){const [modifiers,recipe]=await Promise.all([
      env.DB.prepare("SELECT m.id,m.nombre AS name,m.precio_extra AS price FROM modificadores m JOIN producto_modificadores pm ON pm.modificador_id=m.id WHERE pm.producto_id=? AND m.activo=1 ORDER BY m.nombre").bind(product.id).all(),
      env.DB.prepare("SELECT r.insumo_id AS ingredient_id,r.cantidad AS quantity,i.costo_unitario AS unit_cost FROM recetas r JOIN insumos i ON i.id=r.insumo_id WHERE r.producto_id=? AND i.activo=1").bind(product.id).all(),
    ]);products.push({...product,modifiers:modifiers.results,recipe:recipe.results});}
    return response({products});
  }
  if (path === "/api/pos/orders") {
    try {
      const rows = await env.DB.prepare("SELECT id,nombre_cliente AS customer_name,telefono AS phone,estado AS status,carrito_json AS products,total,metodo_pago AS payment_method,metodo_entrega AS modality,direccion AS address,creado_en AS created_at,receta_snapshot_json AS recipe_snapshot,insumos_consumidos AS ingredients_consumed,origen AS source FROM pedidos ORDER BY id DESC LIMIT 200").all<Record<string, unknown>>();
      const orders = rows.results.map((row)=>({...row,products:JSON.parse(String(row.products||"[]"))}));
      return response({orders});
    } catch (error) {
      return localOrderStorageError(error);
    }
  }
  if (path === "/api/pos/sales-history") {
    const rows = await env.DB.prepare(`SELECT id,tipo AS type,referencia AS reference,
      pedido_id AS order_id,origen AS source,cliente AS customer_name,
      telefono AS phone,modalidad AS modality,direccion AS address,
      metodo_pago AS payment_method,efectivo AS cash,transferencia AS transfer,
      subtotal,domicilio AS delivery_fee,total,productos_json AS products,
      vendido_en AS sold_at FROM ventas_historial
      ORDER BY vendido_en DESC,id DESC`).all<Record<string, unknown>>();
    const sales = rows.results.map((row) => ({
      ...row,
      products: JSON.parse(String(row.products || "[]")),
    }));
    return response({sales});
  }
  if (path === "/api/pos/inventory") {
    const rows = await env.DB.prepare("SELECT id,nombre AS name,unidad AS unit,existencia AS quantity,stock_minimo AS minimum,costo_unitario AS unit_cost FROM insumos WHERE activo=1 ORDER BY nombre").all();
    return response({inventory:rows.results,low_stock:rows.results.filter((row)=>Number(row.quantity)<=Number(row.minimum))});
  }
  if (path === "/api/pos/audit") {
    if (user.role!=="ADMIN") return response({message:"Esta sección requiere ADMIN."},403);
    const rows = await env.DB.prepare("SELECT a.client_uuid,a.accion,a.entidad,a.entidad_id,a.motivo,a.detalles_json,a.creado_en,u.nombre AS usuario FROM auditoria a JOIN usuarios u ON u.id=a.usuario_id ORDER BY a.creado_en DESC LIMIT 200").all();
    return response({records:rows.results});
  }
  if(path==="/api/pos/reports"){
    const start=url.searchParams.get('start')||new Date(Date.now()-6*86400000).toISOString().slice(0,10);
    const end=url.searchParams.get('end')||new Date().toISOString().slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||start>end)return response({message:"Rango de fechas inválido."},400);
    const range="date(created_en,'-5 hours') BETWEEN ? AND ?";
    try {
    const [sales,expenses,products,deliveredProducts,hours,closes]=await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS tickets,COALESCE(AVG(total),0) AS ticket_promedio,COALESCE(SUM(total),0) AS ingresos,COALESCE(SUM(efectivo),0) AS efectivo,COALESCE(SUM(transferencia),0) AS transferencia,COALESCE(SUM(costo),0) AS costo FROM (SELECT monto AS total,monto_efectivo AS efectivo,monto_transferencia AS transferencia,(SELECT costo_insumos FROM pedidos WHERE pedidos.id=ingresos.pedido_id) AS costo,registrado_en AS created_en FROM ingresos UNION ALL SELECT efectivo+transferencia,efectivo,transferencia,costo_insumos,creado_en FROM ventas WHERE estado='CONFIRMADA') WHERE "+range).bind(start,end).first(),
      env.DB.prepare("SELECT COALESCE(SUM(monto),0) AS gastos FROM movimientos_caja WHERE tipo='GASTO' AND date(creado_en,'-5 hours') BETWEEN ? AND ?").bind(start,end).first(),
      env.DB.prepare("SELECT producto,SUM(unidades) AS unidades,SUM(ventas) AS ventas,SUM(costo) AS costo FROM (SELECT d.nombre_snapshot AS producto,d.cantidad AS unidades,d.precio_unitario*d.cantidad AS ventas,d.costo_unitario*d.cantidad AS costo FROM venta_detalles d JOIN ventas v ON v.client_uuid=d.venta_uuid WHERE v.estado='CONFIRMADA' AND date(v.creado_en,'-5 hours') BETWEEN ? AND ? UNION ALL SELECT json_extract(line.value,'$.name') AS producto,CAST(json_extract(line.value,'$.quantity') AS INTEGER) AS unidades,CAST(json_extract(line.value,'$.price') AS INTEGER)*CAST(json_extract(line.value,'$.quantity') AS INTEGER) AS ventas,CASE WHEN p.total>0 THEN p.costo_insumos*(CAST(json_extract(line.value,'$.price') AS REAL)*CAST(json_extract(line.value,'$.quantity') AS REAL))/p.total ELSE 0 END AS costo FROM ingresos i JOIN pedidos p ON p.id=i.pedido_id CROSS JOIN json_each(p.carrito_json) line WHERE date(i.registrado_en,'-5 hours') BETWEEN ? AND ?) GROUP BY producto ORDER BY unidades DESC LIMIT 20").bind(start,end,start,end).all(),
      env.DB.prepare("SELECT json_extract(line.value,'$.productId') AS product_id,json_extract(line.value,'$.name') AS producto,SUM(CAST(json_extract(line.value,'$.quantity') AS INTEGER)) AS unidades,SUM(CAST(json_extract(line.value,'$.price') AS INTEGER)*CAST(json_extract(line.value,'$.quantity') AS INTEGER)) AS ventas,COUNT(DISTINCT p.id) AS pedidos FROM pedidos p CROSS JOIN json_each(p.carrito_json) line WHERE p.estado='ENTREGADO' AND date(p.creado_en,'-5 hours') BETWEEN ? AND ? GROUP BY product_id,producto ORDER BY unidades DESC,producto LIMIT 100").bind(start,end).all(),
      env.DB.prepare("SELECT strftime('%H',creado_en) AS hora,COUNT(*) AS ventas FROM (SELECT creado_en FROM ventas WHERE estado='CONFIRMADA' AND date(creado_en,'-5 hours') BETWEEN ? AND ? UNION ALL SELECT i.registrado_en AS creado_en FROM ingresos i WHERE date(i.registrado_en,'-5 hours') BETWEEN ? AND ?) GROUP BY hora ORDER BY ventas DESC LIMIT 8").bind(start,end,start,end).all(),
      env.DB.prepare("SELECT COUNT(*) AS cierres,COALESCE(SUM(CASE WHEN diferencia_efectivo<0 THEN 1 ELSE 0 END),0) AS faltantes,COALESCE(SUM(CASE WHEN diferencia_efectivo>0 THEN 1 ELSE 0 END),0) AS sobrantes,COALESCE(SUM(diferencia_efectivo),0) AS diferencia_efectivo FROM cierres_turno WHERE date(cerrado_en,'-5 hours') BETWEEN ? AND ?").bind(start,end).first(),
    ]);
    const totals=sales as Record<string,number>|null;const expenseTotal=Number((expenses as {gastos?:number}|null)?.gastos||0);
    return response({start,end,summary:{...totals,gastos:expenseTotal,utilidad_bruta:Number(totals?.ingresos||0)-Number(totals?.costo||0),utilidad_neta:Number(totals?.ingresos||0)-Number(totals?.costo||0)-expenseTotal},products:products.results,delivered_products:deliveredProducts.results,peak_hours:hours.results,closures:closes});
    } catch (error) {
      console.error("POS report query failed", error);
      return response({message:"No se pudo cargar el reporte de ventas. Revisa los registros del Worker."},500);
    }
  }
  const [income,states,shift,lowStock] = await Promise.all([
    env.DB.prepare("SELECT COALESCE(SUM(total),0) AS total,COALESCE(SUM(cash),0) AS efectivo,COALESCE(SUM(transfer),0) AS transferencia FROM (SELECT monto AS total,monto_efectivo AS cash,monto_transferencia AS transfer FROM ingresos WHERE date(registrado_en,'-5 hours')=date('now','-5 hours') UNION ALL SELECT efectivo+transferencia AS total,efectivo AS cash,transferencia AS transfer FROM ventas WHERE estado='CONFIRMADA' AND date(creado_en,'-5 hours')=date('now','-5 hours'))").first(),
    env.DB.prepare("SELECT COALESCE(SUM(estado='RECIBIDO'),0) AS recibidos,COALESCE(SUM(estado='TERMINADO'),0) AS terminados,COALESCE(SUM(estado='ENTREGADO'),0) AS entregados,COALESCE(SUM(estado='CANCELADO'),0) AS cancelados FROM pedidos").first(),
    env.DB.prepare("SELECT id,base_inicial,abierto_en FROM turnos WHERE usuario_id=? AND estado='ABIERTO' LIMIT 1").bind(user.userId).first(),
    env.DB.prepare("SELECT id,nombre AS name,existencia AS quantity,stock_minimo AS minimum,unidad AS unit FROM insumos WHERE activo=1 AND existencia<=stock_minimo ORDER BY existencia-stock_minimo LIMIT 8").all(),
  ]);
  return response({user:{id:user.userId,name:user.name,role:user.role},income,orders:states,open_shift:shift,alerts:lowStock.results});
}
