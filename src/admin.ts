import type { Env } from "./types";
import { sendText } from "./whatsapp";

interface AdminOrder {
  id: number;
  telefono: string;
  nombre_cliente: string;
  carrito_json: string;
  total: number;
  direccion: string;
  latitud: number | null;
  longitud: number | null;
  metodo_pago: string;
  metodo_entrega: string;
  estado: string;
  creado_en: string;
  adiciones_json: string;
  modificado_en: string | null;
  mensaje_entrega_estado: string;
  mensaje_entrega_error: string | null;
}

interface IncomeSummary {
  total: number;
  efectivo: number;
  transferencias: number;
  entregados: number;
}

interface OrderSummary {
  recibidos: number;
  terminados: number;
}

const SESSION_SECONDS = 8 * 60 * 60;
const COOKIE_NAME = "salvaja_admin";
const ADMIN_SCRIPT = `(function(){
  var dialog = document.getElementById('send-dialog');
  var activeOrderId = '';
  var sendButton = document.querySelector('[data-confirm-send]');
  var errorBox = document.getElementById('send-error');
  function showNotice(message, failed) {
    var box = document.getElementById('action-notice');
    box.textContent = message;
    box.className = failed ? 'notice error-notice' : 'notice';
    box.hidden = false;
    box.scrollIntoView({behavior:'smooth', block:'nearest'});
  }
  function makeSendButton() {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'action-button send';
    button.textContent = 'Enviar mensaje';
    button.setAttribute('data-send-order', '');
    return button;
  }
  function renderActions(row, state) {
    var actions = row.querySelector('.actions-cell .row-actions');
    var note = document.createElement('span');
    note.className = 'action-note';
    if (state === 'RECIBIDO') {
      note.textContent = 'Pedido recibido por WhatsApp';
      var finishForm = document.createElement('form');
      finishForm.method = 'post'; finishForm.action = '/admin/finish';
      finishForm.innerHTML = '<input type="hidden" name="id">';
      finishForm.querySelector('input').value = row.dataset.orderId;
      var finish = document.createElement('button');
      finish.type='submit'; finish.className='action-button finish'; finish.textContent='✓ Marcar terminado';
      finishForm.appendChild(finish);
      actions.replaceChildren(note, finishForm);
    } else if (state === 'TERMINADO') {
      note.textContent = 'Pedido terminado';
      var deliverForm = document.createElement('form');
      deliverForm.method='post'; deliverForm.action='/admin/deliver';
      deliverForm.innerHTML='<input type="hidden" name="id">';
      deliverForm.querySelector('input').value=row.dataset.orderId;
      var deliver=document.createElement('button');
      deliver.type='submit'; deliver.className='action-button deliver'; deliver.textContent='✓ Marcar entregado';
      deliverForm.appendChild(deliver);
      if (row.getAttribute('data-message-sent') === 'true') {
        var sentNote = document.createElement('span');
        sentNote.className = 'action-note';
        sentNote.textContent = 'Mensaje enviado por WhatsApp';
        actions.replaceChildren(note, deliverForm, sentNote);
      } else {
        actions.replaceChildren(note, deliverForm, makeSendButton());
      }
    } else if (state === 'ENTREGADO') {
      note.textContent = 'Pedido entregado · Ingreso registrado';
      if (row.getAttribute('data-message-sent') === 'true') {
        var deliveredNote = document.createElement('span');
        deliveredNote.className = 'action-note';
        deliveredNote.textContent = 'Mensaje enviado por WhatsApp';
        actions.replaceChildren(note, deliveredNote);
      } else {
        actions.replaceChildren(note, makeSendButton());
      }
    }
  }
  document.addEventListener('click', function(event) {
    var trigger = event.target.closest('[data-send-order]');
    if (!trigger) return;
    var row = trigger.closest('tr');
    activeOrderId = row.getAttribute('data-order-id');
    document.getElementById('send-order-id').textContent = '#' + activeOrderId;
    document.getElementById('send-recipient').textContent = row.querySelector('.client-cell strong').textContent;
    document.getElementById('send-phone').textContent = row.querySelector('.phone').textContent;
    document.getElementById('send-preview').textContent = 'Hola ' + row.querySelector('.client-cell strong').textContent + ', tu pedido de La Salvajada de Willian está listo. ¡Gracias por tu compra!';
    errorBox.hidden = true;
    sendButton.disabled = false;
    sendButton.textContent = 'Confirmar y enviar';
    dialog.showModal();
  });
  document.addEventListener('submit', async function(event) {
    var form = event.target;
    var action = form.getAttribute('action');
    if (action !== '/admin/finish' && action !== '/admin/deliver') return;
    event.preventDefault();
    var button = form.querySelector('button');
    button.disabled = true;
    button.textContent = 'Actualizando…';
    try {
      var response = await fetch(action, {method:'POST', body:new FormData(form), headers:{'Accept':'application/json'}, credentials:'same-origin'});
      var result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || 'No se pudo actualizar el pedido.');
      var row = form.closest('tr');
      var nextState = action === '/admin/finish' ? 'TERMINADO' : 'ENTREGADO';
      row.setAttribute('data-status', nextState);
      row.querySelectorAll('.pill').forEach(function(pill){pill.textContent=nextState;pill.className='pill done';});
      var pendingCount = document.getElementById('pending-count');
      var readyCount = document.getElementById('ready-count');
      if (action === '/admin/finish') {
        pendingCount.textContent = String(Math.max(0, Number(pendingCount.textContent) - 1));
        readyCount.textContent = String(Number(readyCount.textContent) + 1);
        showNotice('Pedido marcado como terminado. Registra el ingreso al entregarlo.', false);
      } else {
        readyCount.textContent = String(Math.max(0, Number(readyCount.textContent) - 1));
        var incomeTotal = document.getElementById('income-total');
        var currentIncome = Number(incomeTotal.dataset.amount || 0) + Number(row.dataset.total || 0);
        incomeTotal.dataset.amount = String(currentIncome);
        incomeTotal.textContent = '$' + new Intl.NumberFormat('es-CO').format(currentIncome);
        var incomeNote = document.getElementById('income-note');
        var isCash = (row.dataset.payment || '').toLowerCase() === 'efectivo';
        var cash = Number(incomeNote.dataset.cash || 0) + (isCash ? Number(row.dataset.total || 0) : 0);
        var transfers = Number(incomeNote.dataset.transfers || 0) + (isCash ? 0 : Number(row.dataset.total || 0));
        var deliveries = Number(incomeNote.dataset.deliveries || 0) + 1;
        incomeNote.dataset.cash = String(cash);
        incomeNote.dataset.transfers = String(transfers);
        incomeNote.dataset.deliveries = String(deliveries);
        var money = new Intl.NumberFormat('es-CO');
        incomeNote.textContent = deliveries + ' entregados · Efectivo $' + money.format(cash) + ' · Transferencias $' + money.format(transfers);
        showNotice('Pedido entregado y registrado como ingreso.', false);
      }
      renderActions(row, nextState);
    } catch (error) {
      button.disabled = false;
      button.textContent = action === '/admin/finish' ? '✓ Marcar terminado' : '✓ Marcar entregado';
      showNotice(error.message || 'Error al actualizar el pedido.', true);
    }
  });
  sendButton.addEventListener('click', async function() {
    sendButton.disabled = true;
    sendButton.textContent = 'Enviando…';
    errorBox.hidden = true;
    var data = new FormData();
    data.set('id', activeOrderId);
    try {
      var response = await fetch('/admin/send', {method:'POST', body:data, headers:{'Accept':'application/json'}, credentials:'same-origin'});
      var result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || 'No se pudo enviar el mensaje.');
      dialog.close();
      var row = document.querySelector('tr[data-order-id="' + activeOrderId + '"]');
      row.setAttribute('data-message-sent', 'true');
      renderActions(row, row.dataset.status);
      showNotice('Mensaje enviado por WhatsApp.', false);
    } catch (error) {
      sendButton.disabled = false;
      sendButton.textContent = 'Confirmar y enviar';
      errorBox.textContent = error.message || 'No se pudo enviar el mensaje.';
      errorBox.hidden = false;
    }
  });
  document.querySelectorAll('[data-close-send]').forEach(function(button){button.addEventListener('click',function(){dialog.close();});});
})();`;

function escapeHtml(value: unknown): string {
  const entities: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  };
  return String(value ?? "").replace(/[&<>"']/g, (char) => entities[char] ?? char);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signSession(secret: string, expires: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(expires))));
}

function sameText(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

function getCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("Cookie")?.split(";") ?? [];
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}

function displayPhone(value: string): string {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("57") && digits.length === 12) digits = digits.slice(2);
  return digits.length === 10 ? `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}` : digits;
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_PASSWORD) return false;
  const value = getCookie(request, COOKIE_NAME);
  if (!value) return false;
  const [expires, provided] = value.split(".");
  const expiry = Number(expires);
  if (!Number.isFinite(expiry) || expiry <= Math.floor(Date.now() / 1000) || !provided) return false;
  return sameText(await signSession(env.ADMIN_PASSWORD, expires), provided);
}

function html(body: string, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  return new Response(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/png" href="/logo.png"><title>Pedidos | La Salvajada de Willian</title><style>
    :root{color-scheme:light;--ink:#27231f;--muted:#77736d;--line:#ebe5dc;--paper:#fff;--canvas:#f7f4ef;--orange:#e78a24;--green:#155f4b}
    *{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
    .topbar{background:#24211e;color:#fff;padding:15px max(22px,calc((100vw - 1260px)/2));display:flex;justify-content:space-between;align-items:center;gap:20px;box-shadow:0 3px 14px #1e1a161c}
    .brand{display:flex;align-items:center;gap:12px}.brand-logo{display:block;width:78px;height:70px;object-fit:contain;border-radius:11px;background:#d3d3d3;flex:0 0 auto}.brand-name{font-weight:750;font-size:15px}.brand-sub{display:block;color:#c8c0b5;font-size:12px;margin-top:1px}
    .top-actions{display:flex;align-items:center;gap:15px}.secure-label{font-size:12px;color:#d9d1c7}.secure-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#64c597;margin-right:6px}
    main{max-width:1260px;margin:34px auto;padding:0 22px}.page-heading{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin-bottom:22px}.eyebrow{font-size:11px;letter-spacing:.13em;font-weight:800;color:#a96725;margin:0 0 5px;text-transform:uppercase}h1{font-size:30px;line-height:1.2;letter-spacing:-.03em;margin:0}h2{font-size:18px}.muted{color:var(--muted)}.heading-copy{margin:7px 0 0;color:var(--muted)}
    .button{display:inline-flex;align-items:center;justify-content:center;background:var(--green);border:0;border-radius:9px;padding:10px 15px;color:#fff;text-decoration:none;font:650 13px system-ui;cursor:pointer;transition:transform .15s,background .15s}.button:hover{background:#0e4c3b;transform:translateY(-1px)}.button.dark{background:#45413c}.button.dark:hover{background:#322f2b}button{font:inherit}
    .stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:20px}.stat-card,.panel{background:var(--paper);border:1px solid var(--line);border-radius:14px;box-shadow:0 4px 15px #4e3a2010}.stat-card{padding:18px 20px;position:relative;overflow:hidden}.stat-card:after{content:"";position:absolute;width:5px;inset:0 auto 0 0;background:var(--orange)}.stat-label{color:var(--muted);font-size:12px;font-weight:650}.stat-value{font-size:27px;font-weight:800;letter-spacing:-.04em;margin-top:4px}.stat-note{font-size:11px;color:#999188;margin-top:2px}
    .panel{overflow:hidden}.panel-head{padding:18px 20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px}.panel-head h2{margin:0;font-size:16px}.panel-head p{margin:3px 0 0;font-size:12px;color:var(--muted)}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:1080px}th,td{text-align:left;padding:14px 13px;border-bottom:1px solid #f0ece6;vertical-align:top}th{background:#fcfaf7;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:#80796f;font-weight:800;white-space:nowrap}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:#fffdf9}td{font-size:13px}.order-id{font-weight:800;color:#a15b1c}.item-list{line-height:1.65;color:#49443e}.phone{display:block;color:var(--muted);font-size:12px;letter-spacing:.035em;margin-top:3px}.order-time{display:block;color:var(--muted);font-size:11px;margin-top:4px;white-space:nowrap}.pill{display:inline-flex;align-items:center;background:#eaf2ff;color:#245a92;padding:4px 9px;border-radius:30px;font-size:11px;font-weight:750;white-space:nowrap}.pill.pending{background:#eaf2ff;color:#245a92}.pill.done{background:#e9f4ed;color:#176b4c}.pill.cancelled{background:#fde8e7;color:#b42318}.mobile-order-head .pill{display:none}.address{max-width:210px}.map-link{display:inline-block;margin-top:5px;color:#14684f;font-size:12px;font-weight:700;text-decoration:none}.map-link:hover{text-decoration:underline}.row-actions{display:flex;flex-direction:column;gap:7px;min-width:118px}.action-button{border:0;border-radius:7px;padding:8px 10px;font:700 11px system-ui;cursor:pointer;white-space:nowrap}.action-button.finish,.action-button.deliver{background:#eaf4ed;color:#176b4c}.action-button.send{background:#155f4b;color:white}.action-button:disabled{opacity:.55;cursor:default}.action-note{font-size:10px;color:var(--muted)}.modified-box{margin-top:8px;padding:8px 9px;border-left:3px solid #df922b;background:#fff8eb;border-radius:0 7px 7px 0;font-size:11px}.modified-badge{display:inline-block;color:#8b5618;background:#ffedca;border-radius:20px;padding:2px 7px;font-size:10px;font-weight:800;margin-bottom:4px}.modified-when{display:block;color:#877a66;font-size:10px;margin-bottom:3px}
    .notice{background:#eaf4ed;color:#176b4c;border:1px solid #cfe5d5;border-radius:10px;padding:11px 14px;font-size:13px;font-weight:650}.error-notice{background:#fff0ed;color:#a32323;border-color:#f6d0c8}.confirm-dialog{width:min(460px,calc(100% - 28px));border:1px solid var(--line);border-radius:18px;padding:0;color:var(--ink);box-shadow:0 24px 70px #21180e40}.confirm-dialog::backdrop{background:#211d19a8;backdrop-filter:blur(3px)}.dialog-content{padding:23px}.dialog-content h2{margin:0;font-size:21px}.dialog-copy{color:var(--muted);font-size:13px;margin:5px 0 18px}.dialog-order{background:var(--canvas);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:13px}.dialog-order strong{display:block}.dialog-phone{color:var(--muted);font-size:12px}.dialog-message{border-top:1px solid var(--line);padding-top:12px;margin-top:12px;font-size:13px;line-height:1.5}.dialog-error{color:#a32323;background:#fff0ed;border-radius:8px;padding:9px 11px;font-size:12px;margin:10px 0}.dialog-actions{display:flex;gap:9px;margin-top:16px}.dialog-actions button{flex:1}.empty{padding:54px 20px;text-align:center;color:var(--muted)}.empty-icon{width:48px;height:48px;border-radius:50%;display:grid;place-items:center;background:#fbf0df;color:#b76a1d;font-size:23px;margin:0 auto 12px}.empty strong{display:block;color:var(--ink);font-size:15px;margin-bottom:3px}
    .login-shell{min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at 50% 0%,#f2d6b3 0,transparent 45%),var(--canvas)}.login{width:min(440px,100%);background:#fff;border:1px solid var(--line);border-radius:20px;padding:32px;box-shadow:0 18px 50px #35281720}.login .brand-logo{width:100%;height:auto;max-height:300px;object-fit:contain;margin:0 auto 18px}.login h1{font-size:24px}.login p{color:var(--muted);margin:9px 0 22px}.login label{display:block;font-weight:700;font-size:13px;margin:0 0 7px}.login input{width:100%;padding:12px 13px;border:1px solid #d8d0c5;border-radius:9px;font:inherit;outline:none}.login input:focus{border-color:var(--orange);box-shadow:0 0 0 3px #e78a2423}.login .button{width:100%;margin-top:15px;padding:12px}.error{color:#a32323;background:#fff0ed;border:1px solid #f6d0c8;padding:9px 11px;border-radius:8px;margin:12px 0;font-size:13px}
    @media(max-width:760px){main{margin:23px auto;padding:0 14px}.topbar{padding:13px 15px}.secure-label{display:none}.stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.stat-card{padding:14px 13px}.stat-value{font-size:23px}.page-heading{align-items:flex-start}.page-heading h1{font-size:27px}.heading-copy{font-size:13px}.top-actions{gap:8px}}
    @media(max-width:560px){
      main{margin:16px auto;padding:0 12px 24px}.topbar{position:sticky;top:0;z-index:10;padding:10px 12px;gap:8px}.brand{gap:8px}.brand-logo{width:64px;height:58px;border-radius:9px}.brand-name{font-size:13px}.brand-sub{font-size:10px}.top-actions{gap:0}.top-actions .button{padding:8px 10px;font-size:11px}
      .page-heading{display:block;margin-bottom:17px}.page-heading h1{font-size:26px}.heading-copy{font-size:12px;line-height:1.45}.page-heading .button{margin-top:12px;width:100%}
      .stats{grid-template-columns:1fr 1fr;gap:8px;margin-bottom:15px}.stat-card{padding:13px 12px;border-radius:12px;min-width:0}.stat-card:nth-child(4){grid-column:1/-1;display:grid;grid-template-columns:1fr auto;align-items:center;background:#1d4035;color:#fff;padding:15px 16px}.stat-card:nth-child(4):after{background:#f0a33a}.stat-card:nth-child(4) .stat-label{color:#d9e7df}.stat-card:nth-child(4) .stat-value{grid-column:2;grid-row:1/3;font-size:25px;margin:0;color:#fff}.stat-card:nth-child(4) .stat-note{grid-column:1;grid-row:2;color:#c1d0c8}.stat-label{font-size:10px;line-height:1.3}.stat-value{font-size:19px;overflow-wrap:anywhere}.stat-note{font-size:10px}
      .panel{border-radius:13px}.panel-head{padding:14px}.panel-head h2{font-size:15px}.panel-head p{font-size:11px}.panel-head>.pill{font-size:10px}.table-wrap{overflow:visible}table,tbody{display:block;width:100%;min-width:0}thead{display:none}tbody{padding:8px}tbody tr{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 13px;width:100%;border:1px solid #e9e1d6;border-left:4px solid #2563eb;border-radius:15px;margin:0 0 12px;padding:12px 14px;background:#fff;box-shadow:0 4px 12px #3428170d}tbody tr[data-status="RECIBIDO"]{border-left-color:#2563eb;background:#fbfdff}tbody tr[data-status="TERMINADO"],tbody tr[data-status="ENTREGADO"]{border-left-color:#16834a;background:#fbfffc}tbody tr[data-status="CANCELADO"]{border-left-color:#b42318;background:#fffafa}tbody tr:last-child{margin-bottom:0}tbody td{display:block;width:auto;min-width:0;padding:10px 0;border-bottom:1px solid #f1ece5;font-size:12px;overflow-wrap:anywhere}tbody td:before{content:attr(data-label);display:block;margin-bottom:5px;font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:#887f73;font-weight:800}.order-cell{grid-column:1/-1;grid-row:1;padding:2px 0 11px!important;border-bottom:1px solid var(--line)!important}.order-cell:before{display:none}.mobile-order-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.mobile-order-head .order-id{font-size:17px}.mobile-order-head .pill{display:inline-flex;font-size:10px}.order-time{font-size:10px;margin-top:3px;white-space:normal}.client-cell{grid-column:1;grid-row:2}.total-cell{grid-column:2;grid-row:2;text-align:right}.total-cell strong{font-size:16px;color:#155f4b}.products-cell{grid-column:1/-1;grid-row:3}.payment-cell{grid-column:1;grid-row:4}.fulfillment-cell{grid-column:2;grid-row:4}.address-cell{grid-column:1/-1;grid-row:5}.status-cell{display:none!important}.actions-cell{grid-column:1/-1;grid-row:6;padding-bottom:0!important;border-bottom:0!important}.phone{font-size:11px}.item-list{font-size:12px;line-height:1.55}.address{max-width:none}.map-link{font-size:11px}.row-actions{display:grid;grid-template-columns:1fr;gap:8px;min-width:0}.row-actions form{width:100%}.action-button{width:100%;min-height:46px;font-size:12px;border-radius:10px}.action-note{font-size:11px}.modified-box{font-size:11px}.modified-when{font-size:10px}.dialog-content{padding:18px}.dialog-actions{flex-direction:column-reverse}.login{padding:24px}
    }
  </style></head><body>${body}</body></html>`, { status, headers });
}

function actionResult(request: Request, ok: boolean, message: string, notice: string, status = 200): Response {
  if (request.headers.get("Accept")?.includes("application/json")) {
    return Response.json({ ok, message }, { status, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(null, { status: 303, headers: { Location: `/admin?notice=${notice}`, "Cache-Control": "no-store" } });
}

function loginPage(message = ""): Response {
  return html(`<main class="login-shell"><section class="login"><img class="brand-logo" src="/logo.png" alt="La Salvajada de Willian"><p class="eyebrow">Panel privado</p><h1>Bienvenido</h1><p>Consulta y gestiona los pedidos de <strong>La Salvajada de Willian</strong>.</p>${message ? `<div class="error">${escapeHtml(message)}</div>` : ""}<form method="post" action="/admin/login"><label for="password">Contraseña del panel</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button class="button" type="submit">Entrar al panel</button></form></section></main>`);
}

function cartItems(json: string): string {
  try {
    const items = JSON.parse(json) as Array<{ name?: string; quantity?: number; price?: number }>;
    if (!Array.isArray(items)) return "";
    return items.map((item) => `<div>${escapeHtml(item.quantity ?? 1)} × ${escapeHtml(item.name ?? "Producto")} <span class="muted">$${Number(item.price ?? 0).toLocaleString("es-CO")}</span></div>`).join("");
  } catch {
    return "";
  }
}

async function ordersPage(env: Env, notice = ""): Promise<Response> {
  const [result, income, orderSummary] = await Promise.all([
    env.DB.prepare(`
    SELECT id, telefono, nombre_cliente, carrito_json, total, direccion,
           latitud, longitud, metodo_pago, metodo_entrega, estado, creado_en, adiciones_json, modificado_en,
           mensaje_entrega_estado, mensaje_entrega_error
    FROM pedidos ORDER BY id DESC LIMIT 100
    `).all<AdminOrder>(),
    env.DB.prepare(`
      SELECT COALESCE(SUM(monto), 0) AS total,
             COALESCE(SUM(CASE WHEN LOWER(metodo_pago) = 'efectivo' THEN monto ELSE 0 END), 0) AS efectivo,
             COALESCE(SUM(CASE WHEN LOWER(metodo_pago) <> 'efectivo' THEN monto ELSE 0 END), 0) AS transferencias,
             COUNT(*) AS entregados
      FROM ingresos
    `).first<IncomeSummary>(),
    env.DB.prepare(`
      SELECT COALESCE(SUM(CASE WHEN estado = 'RECIBIDO' THEN 1 ELSE 0 END), 0) AS recibidos,
             COALESCE(SUM(CASE WHEN estado = 'TERMINADO' THEN 1 ELSE 0 END), 0) AS terminados
      FROM pedidos
    `).first<OrderSummary>(),
  ]);
  const orderCount = result.results.length;
  const newOrders = Number(orderSummary?.recibidos ?? 0);
  const readyOrders = Number(orderSummary?.terminados ?? 0);
  const incomeTotal = Number(income?.total ?? 0);
  const cashIncome = Number(income?.efectivo ?? 0);
  const transferIncome = Number(income?.transferencias ?? 0);
  const rows = result.results.map((order) => {
    const location = order.latitud !== null && order.longitud !== null
      ? `<a class="map-link" href="https://maps.google.com/?q=${encodeURIComponent(`${order.latitud},${order.longitud}`)}" target="_blank" rel="noreferrer">↗ Abrir mapa</a>`
      : `<span class="muted">Sin ubicación</span>`;
    const done = order.estado === "TERMINADO" || order.estado === "ENTREGADO";
    const modification = order.modificado_en
      ? `<div class="modified-box"><span class="modified-badge">✦ Modificado</span><small class="modified-when">${escapeHtml(order.modificado_en)}</small><strong>Se agregó:</strong><div class="item-list">${cartItems(order.adiciones_json)}</div></div>`
      : "";
    const pickup = order.metodo_entrega === "RECOGER";
    const cancelled = order.estado === "CANCELADO";
    const pending = order.estado === "RECIBIDO";
    const statusPill = `<span class="pill${pending ? " pending" : ""}${done ? " done" : ""}${cancelled ? " cancelled" : ""}">${escapeHtml(order.estado)}</span>`;
    const sendMessageAction = order.mensaje_entrega_estado === "ENVIADO"
      ? `<span class="action-note">Mensaje enviado por WhatsApp</span>`
      : `${order.mensaje_entrega_estado === "ERROR" ? `<span class="action-note">No se pudo enviar el mensaje. Puedes reintentar.</span>` : ""}<button class="action-button send" type="button" data-send-order>Enviar mensaje</button>`;
    const actions = cancelled
      ? `<span class="action-note">Pedido cancelado</span>`
      : order.estado === "RECIBIDO"
        ? `<span class="action-note">Pedido recibido por WhatsApp</span><form method="post" action="/admin/finish"><input type="hidden" name="id" value="${escapeHtml(order.id)}"><button class="action-button finish" type="submit">✓ Marcar terminado</button></form>`
      : order.estado === "TERMINADO"
          ? `<span class="action-note">Pedido terminado</span><form method="post" action="/admin/deliver"><input type="hidden" name="id" value="${escapeHtml(order.id)}"><button class="action-button deliver" type="submit">✓ Marcar entregado</button></form>${sendMessageAction}`
          : `<span class="action-note">Pedido entregado · Ingreso registrado</span>${sendMessageAction}`;
    return `<tr data-order-id="${escapeHtml(order.id)}" data-status="${escapeHtml(order.estado)}" data-message-sent="${order.mensaje_entrega_estado === "ENVIADO" ? "true" : "false"}" data-total="${Number(order.total)}" data-payment="${escapeHtml(order.metodo_pago)}"><td class="order-cell" data-label="Pedido"><div class="mobile-order-head"><span class="order-id">#${escapeHtml(order.id)}</span>${statusPill}</div><small class="order-time">${escapeHtml(order.creado_en)}</small></td><td class="client-cell" data-label="Cliente"><strong>${escapeHtml(order.nombre_cliente)}</strong><small class="phone">${escapeHtml(displayPhone(order.telefono))}</small></td><td class="products-cell" data-label="Productos"><div class="item-list">${cartItems(order.carrito_json)}</div>${modification}</td><td class="total-cell" data-label="Total"><strong>$${Number(order.total).toLocaleString("es-CO")}</strong></td><td class="payment-cell" data-label="Pago">${escapeHtml(order.metodo_pago)}</td><td class="fulfillment-cell" data-label="Entrega">${pickup ? "Recoger en el local" : "Domicilio"}</td><td class="address address-cell" data-label="Dirección">${pickup ? "No requiere dirección" : `${escapeHtml(order.direccion)}<br>${location}`}</td><td class="status-cell" data-label="Estado">${statusPill}</td><td class="actions-cell" data-label="Acciones"><div class="row-actions">${actions}</div></td></tr>`;
  }).join("");
  const notices: Record<string, string> = {
    finished: "Pedido marcado como terminado.",
    delivered: "Pedido entregado y registrado como ingreso.",
    sent: "Mensaje enviado al cliente por WhatsApp.",
    "send-error": "No se pudo enviar. Puede que haya pasado la ventana de 24 horas; revisa el estado en WhatsApp Manager.",
    "order-error": "No se encontró ese pedido.",
    "must-finish": "Marca el pedido como terminado antes de entregarlo o enviar el mensaje.",
  };
  return html(`<header class="topbar"><div class="brand"><img class="brand-logo" src="/logo.png" alt="La Salvajada de Willian"><div><div class="brand-name">La Salvajada de Willian</div><span class="brand-sub">Administración de pedidos</span></div></div><div class="top-actions"><span class="secure-label"><span class="secure-dot"></span>Panel privado</span><form class="inline" method="post" action="/admin/logout"><button class="button dark" type="submit">Cerrar sesión</button></form></div></header><main><div class="page-heading"><div><p class="eyebrow">Resumen del restaurante</p><h1>Pedidos de WhatsApp</h1><p class="heading-copy">Pedidos confirmados, estado de entrega e ingresos registrados cuando se entregan.</p></div><a class="button" href="/admin">↻ Actualizar pedidos</a></div>${notices[notice] ? `<p class="notice">${escapeHtml(notices[notice])}</p>` : ""}<p class="notice" id="action-notice" role="status" aria-live="polite" hidden></p><section class="stats"><article class="stat-card"><div class="stat-label">Pedidos recientes</div><div class="stat-value">${orderCount}</div><div class="stat-note">Últimos 100 registros</div></article><article class="stat-card"><div class="stat-label">Recibidos</div><div class="stat-value" id="pending-count">${newOrders}</div><div class="stat-note">En cola de preparación</div></article><article class="stat-card"><div class="stat-label">Terminados por entregar</div><div class="stat-value" id="ready-count">${readyOrders}</div><div class="stat-note">Aún no cuentan como ingreso</div></article><article class="stat-card"><div class="stat-label">Ingresos acumulados</div><div class="stat-value" id="income-total" data-amount="${incomeTotal}">$${incomeTotal.toLocaleString("es-CO")}</div><div class="stat-note" id="income-note" data-deliveries="${Number(income?.entregados ?? 0)}" data-cash="${cashIncome}" data-transfers="${transferIncome}">${Number(income?.entregados ?? 0)} entregados · Efectivo $${cashIncome.toLocaleString("es-CO")} · Transferencias $${transferIncome.toLocaleString("es-CO")}</div></article></section><section class="panel"><div class="panel-head"><div><h2>Pedidos confirmados</h2><p>Los pedidos más recientes aparecen primero.</p></div><span class="pill">${orderCount} registros</span></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Pedido</th><th>Cliente</th><th>Productos</th><th>Total</th><th>Pago</th><th>Entrega</th><th>Dirección</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><div class="empty-icon">＋</div><strong>Aún no hay pedidos</strong>Los pedidos confirmados desde WhatsApp aparecerán aquí.</div>`}</section></main><dialog class="confirm-dialog" id="send-dialog"><div class="dialog-content"><p class="eyebrow">Confirmar destinatario</p><h2>Enviar mensaje por WhatsApp</h2><p class="dialog-copy">Verifica que el pedido y el número sean correctos.</p><div class="dialog-order"><strong>Pedido <span id="send-order-id"></span></strong><div style="margin-top:8px">Cliente: <strong id="send-recipient"></strong><br><span class="dialog-phone" id="send-phone"></span></div><div class="dialog-message" id="send-preview"></div></div><p class="dialog-error" id="send-error" role="alert" hidden></p><div class="dialog-actions"><button class="button dark" type="button" data-close-send>Cancelar</button><button class="button" type="button" data-confirm-send>Confirmar y enviar</button></div></div></dialog><script>${ADMIN_SCRIPT}</script>`);
}

export async function handleAdmin(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/admin")) return null;
  if (!env.ADMIN_PASSWORD) {
    return html(`<main class="login"><section class="card"><h1>Panel no configurado</h1><p>Agrega el secreto <code>ADMIN_PASSWORD</code> en Cloudflare para proteger el panel.</p></section></main>`, 503);
  }

  if (request.method === "POST" && url.pathname === "/admin/login") {
    const form = await request.formData();
    const password = String(form.get("password") ?? "");
    if (!sameText(password, env.ADMIN_PASSWORD)) return loginPage("Contraseña incorrecta.");
    const expires = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
    const signature = await signSession(env.ADMIN_PASSWORD, expires);
    const cookie = `${COOKIE_NAME}=${expires}.${signature}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
    return new Response(null, { status: 303, headers: { Location: "/admin", "Set-Cookie": cookie, "Cache-Control": "no-store" } });
  }

  if (request.method === "POST" && url.pathname === "/admin/logout") {
    return new Response(null, { status: 303, headers: { Location: "/admin", "Set-Cookie": `${COOKIE_NAME}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`, "Cache-Control": "no-store" } });
  }

  if (request.method === "GET" && url.pathname === "/admin/confirm-send") {
    if (!(await isAuthenticated(request, env))) return loginPage("Inicia sesión para gestionar los pedidos.");
    const id = Number(url.searchParams.get("id"));
    if (!Number.isSafeInteger(id) || id < 1) return new Response("Pedido inválido", { status: 400 });
    const order = await env.DB.prepare("SELECT id, telefono, nombre_cliente, estado, mensaje_entrega_estado FROM pedidos WHERE id = ?").bind(id).first<{ id: number; telefono: string; nombre_cliente: string; estado: string; mensaje_entrega_estado: string }>();
    if (!order) return new Response(null, { status: 303, headers: { Location: "/admin?notice=order-error", "Cache-Control": "no-store" } });
    if (order.estado !== "TERMINADO") return new Response(null, { status: 303, headers: { Location: "/admin?notice=must-finish", "Cache-Control": "no-store" } });
    if (order.mensaje_entrega_estado === "ENVIADO") return new Response(null, { status: 303, headers: { Location: "/admin?notice=sent", "Cache-Control": "no-store" } });
    const message = `Hola ${order.nombre_cliente}, tu pedido de La Salvajada de Willian está listo. ¡Gracias por tu compra!`;
    return html(`<main class="login-shell"><section class="login"><img class="brand-logo" src="/logo.png" alt="La Salvajada de Willian"><p class="eyebrow">Confirmación de envío</p><h1>¿Enviar este mensaje?</h1><p>Verifica que el pedido y el destinatario sean correctos antes de enviarlo.</p><div style="background:#f7f4ef;border:1px solid #ebe5dc;border-radius:12px;padding:16px;margin:18px 0"><strong>Pedido #${escapeHtml(order.id)}</strong><div style="margin-top:8px">Destinatario: <strong>${escapeHtml(order.nombre_cliente)}</strong><br><span class="muted">${escapeHtml(displayPhone(order.telefono))}</span></div><div style="margin-top:14px;color:#49443e">${escapeHtml(message)}</div></div><form method="post" action="/admin/send"><input type="hidden" name="id" value="${escapeHtml(order.id)}"><button class="button" type="submit">Confirmar y enviar mensaje</button></form><a class="button dark" style="width:100%;margin-top:10px" href="/admin">Cancelar y volver</a></section></main>`);
  }

  if (request.method === "POST" && ["/admin/finish", "/admin/deliver", "/admin/send"].includes(url.pathname)) {
    const wantsJson = request.headers.get("Accept")?.includes("application/json");
    if (!(await isAuthenticated(request, env))) {
      if (wantsJson) return actionResult(request, false, "La sesión expiró. Inicia sesión de nuevo.", "order-error", 401);
      return loginPage("Inicia sesión para gestionar los pedidos.");
    }
    const form = await request.formData();
    const id = Number(form.get("id"));
    if (!Number.isSafeInteger(id) || id < 1) return actionResult(request, false, "Pedido inválido.", "order-error", 400);
    const order = await env.DB.prepare("SELECT id, telefono, nombre_cliente, estado, mensaje_entrega_estado FROM pedidos WHERE id = ?").bind(id).first<{ id: number; telefono: string; nombre_cliente: string; estado: string; mensaje_entrega_estado: string }>();
    if (!order) return actionResult(request, false, "No se encontró ese pedido.", "order-error", 404);
    if (url.pathname === "/admin/finish") {
      if (order.estado !== "RECIBIDO") return actionResult(request, false, "Solo se puede terminar un pedido recibido.", "must-finish", 409);
      const result = await env.DB.prepare("UPDATE pedidos SET estado = 'TERMINADO' WHERE id = ? AND estado = 'RECIBIDO'").bind(id).run();
      if (result.meta.changes !== 1) return actionResult(request, false, "El pedido cambió de estado; actualiza el panel.", "order-error", 409);
      return actionResult(request, true, "Pedido marcado como terminado.", "finished");
    }
    if (url.pathname === "/admin/deliver") {
      if (order.estado !== "TERMINADO") return actionResult(request, false, "Solo se puede registrar el ingreso después de terminar el pedido.", "must-finish", 409);
      const results = await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO ingresos (pedido_id, monto, metodo_pago, monto_efectivo, monto_transferencia)
          SELECT id, total, metodo_pago,
            CASE WHEN LOWER(metodo_pago) = 'efectivo' THEN total ELSE 0 END,
            CASE WHEN LOWER(metodo_pago) = 'efectivo' THEN 0 ELSE total END
          FROM pedidos
          WHERE id = ? AND estado = 'TERMINADO'
          ON CONFLICT(pedido_id) DO NOTHING
        `).bind(id),
        env.DB.prepare("UPDATE pedidos SET estado = 'ENTREGADO' WHERE id = ? AND estado = 'TERMINADO'").bind(id),
      ]);
      if (results[1].meta.changes !== 1) return actionResult(request, false, "El pedido cambió de estado; actualiza el panel.", "order-error", 409);
      return actionResult(request, true, "Pedido entregado y registrado como ingreso.", "delivered");
    }
    if (order.estado !== "TERMINADO" && order.estado !== "ENTREGADO") return actionResult(request, false, "Marca el pedido como terminado antes de enviar el mensaje.", "must-finish", 409);
    if (order.mensaje_entrega_estado === "ENVIADO") return actionResult(request, false, "El mensaje de entrega ya se envió.", "already-sent", 409);
    try {
      await sendText(env, order.telefono, `Hola ${order.nombre_cliente}, tu pedido de La Salvajada de Willian está listo. ¡Gracias por tu compra!`);
      await env.DB.prepare("UPDATE pedidos SET mensaje_entrega_estado='ENVIADO',mensaje_entrega_error=NULL WHERE id=?").bind(id).run();
      return actionResult(request, true, "Mensaje enviado al cliente por WhatsApp.", "sent");
    } catch {
      return actionResult(request, false, "No se pudo enviar. Revisa el token y la ventana de 24 horas de WhatsApp.", "send-error", 502);
    }
  }

  if (request.method !== "GET" || url.pathname !== "/admin") return new Response("Not found", { status: 404 });
  if (!(await isAuthenticated(request, env))) return loginPage();
  try {
    return await ordersPage(env, url.searchParams.get("notice") ?? "");
  } catch (error) {
    console.error("Admin orders query failed", error);
    return html(`<main><section class="card"><h1>No se pudieron cargar los pedidos</h1><p>Recarga el panel más tarde.</p></section></main>`, 500);
  }
}
