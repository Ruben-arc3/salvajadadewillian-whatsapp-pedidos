import type { Env, Product } from "./types";

type Button = { id: string; title: string };

async function send(env: Env, to: string, payload: Record<string, unknown>): Promise<void> {
  const version = env.GRAPH_API_VERSION || "v27.0";
  const response = await fetch(`https://graph.facebook.com/${version}/${env.PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, ...payload }),
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error("WhatsApp API error", response.status, detail);
    throw new Error(`WhatsApp API returned ${response.status}`);
  }
}

export function sendText(env: Env, to: string, body: string): Promise<void> {
  return send(env, to, { type: "text", text: { preview_url: false, body } });
}

export function sendButtons(env: Env, to: string, body: string, buttons: Button[]): Promise<void> {
  return send(env, to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: { buttons: buttons.slice(0, 3).map((button) => ({
        type: "reply",
        reply: { id: button.id, title: button.title.slice(0, 20) },
      })) },
    },
  });
}

export function sendProductList(env: Env, to: string, products: Product[]): Promise<void> {
  const rows = products.slice(0, 10).map((product) => ({
    id: `PRODUCT:${product.id}`,
    title: product.nombre.slice(0, 24),
    description: `$${product.precio.toLocaleString("es-CO")}${product.descripcion ? ` · ${product.descripcion}` : ""}`.slice(0, 72),
  }));
  return send(env, to, {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: "Elige un producto para agregarlo a tu pedido:" },
      action: { button: "Ver productos", sections: [{ title: "Menú disponible", rows }] },
    },
  });
}

export function sendCategoryList(env: Env, to: string, categories: string[]): Promise<void> {
  const rows = categories.slice(0, 10).map((category, index) => ({
    id: `CATEGORY:${index}`,
    title: category.slice(0, 24),
    description: "Ver productos de esta categoría",
  }));
  return send(env, to, {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: "¿Qué se te antoja? Elige una categoría:" },
      action: { button: "Ver categorías", sections: [{ title: "Menú", rows }] },
    },
  });
}
