import { handleMessage } from "./flow";
import { markMessageProcessed } from "./db";
import type { Env, WhatsAppMessage } from "./types";
import { dataDeletionPage, privacyPolicyPage } from "./privacy";
import { handleAdmin } from "./admin";

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

async function validSignature(rawBody: ArrayBuffer, signatureHeader: string | null, appSecret: string): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const supplied = signatureHeader.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  const expectedHex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const encoder = new TextEncoder();
  return constantTimeEqual(encoder.encode(expectedHex), encoder.encode(supplied.toLowerCase()));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    console.log("Webhook request", request.method, url.pathname);
    const adminResponse = await handleAdmin(request, env);
    if (adminResponse) return adminResponse;
    if (request.method === "GET" && url.pathname === "/privacy") return privacyPolicyPage();
    if (request.method === "GET" && url.pathname === "/data-deletion") return dataDeletionPage();
    if (url.pathname !== "/webhook") return new Response("La Salvajada WhatsApp bot", { status: 200 });

    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === env.VERIFY_TOKEN && challenge) {
        console.log("Webhook verification successful");
        return new Response(challenge, { status: 200 });
      }
      console.warn("Webhook verification rejected");
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const rawBody = await request.arrayBuffer();
    if (!(await validSignature(rawBody, request.headers.get("X-Hub-Signature-256"), env.META_APP_SECRET))) {
      console.warn("Webhook rejected: invalid signature");
      return new Response("Invalid signature", { status: 401 });
    }

    let payload: any;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    try {
      let messageCount = 0;
      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          for (const message of (change.value?.messages ?? []) as WhatsAppMessage[]) {
            if (!message.id || !message.from) continue;
            messageCount++;
            if (!(await markMessageProcessed(env, message.id))) continue;
            await handleMessage(env, message);
          }
        }
      }
      console.log("Webhook processed", messageCount, "inbound messages");
      return new Response("EVENT_RECEIVED", { status: 200 });
    } catch (error) {
      console.error("Webhook processing error", error);
      return new Response("Processing failed", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
