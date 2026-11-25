export interface Env {
  DB: D1Database;
  WHATSAPP_TOKEN: string;
  PHONE_NUMBER_ID: string;
  VERIFY_TOKEN: string;
  META_APP_SECRET: string;
  ADMIN_PASSWORD?: string;
  POS_AUTH_SECRET?: string;
  GRAPH_API_VERSION?: string;
  RESTAURANT_NAME?: string;
  OWNER_WHATSAPP?: string;
}

export interface Product {
  id: string;
  nombre: string;
  categoria: string;
  descripcion: string;
  precio: number;
  disponible: number;
}

export interface CartItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
}

export interface Session {
  telefono: string;
  paso: string;
  carrito_json: string;
  nombre_cliente: string | null;
  direccion: string | null;
  latitud: number | null;
  longitud: number | null;
  metodo_pago: string | null;
  metodo_entrega: string | null;
  carrito_base_json: string;
}

export interface WhatsAppMessage {
  id: string;
  from: string;
  type: string;
  text?: { body?: string };
  interactive?: {
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
}
