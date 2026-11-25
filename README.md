# Bot de WhatsApp — La Salvajada de Willian

Worker de Cloudflare con webhook de Meta, flujo guiado sin IA y estado en D1.

## Flujo configurado

- Menú principal: Ver menú, Hacer pedido, Horario y ubicación.
- Horario: 5:00 p. m. a 11:59 p. m.; barrio El Dorado; ofrece domicilio.
- Pedido: producto → nombre → modalidad de entrega → dirección/ubicación si es domicilio → transferencia o efectivo → confirmación.
- “Hablar con un encargado” pausa el flujo automático. Para avisar al restaurante, configurar `OWNER_WHATSAPP` con el número del encargado en formato internacional.
- Política de privacidad pública: `/privacy`; instrucciones de acceso/eliminación: `/data-deletion`.
- Panel privado de pedidos de WhatsApp: `/admin`; requiere el secreto `ADMIN_PASSWORD` (`npx wrangler secret put ADMIN_PASSWORD`).
- Ciclo de pedidos: `RECIBIDO` → `TERMINADO` → `ENTREGADO`. Al confirmar la entrega, el Worker guarda un ingreso único por pedido en D1 con su monto y método de pago. Los pedidos cancelados o solo terminados no se suman a los ingresos.

## Preparación

1. Instalar Node.js y ejecutar `npm install`.
2. Crear una base D1: `npx wrangler d1 create bot-restaurante-db`.
3. Reemplazar `REEMPLAZA_CON_EL_ID_DE_D1` en `wrangler.jsonc` con el ID obtenido.
4. Aplicar la migración local: `npm run db:local`.
5. Aplicar `0002_seed_menu.sql` con `npm run db:local` o `npm run db:remote`; carga los productos legibles de la imagen en D1. La variante Salvajada XL se omitió porque su precio está tapado en la foto.
6. Agregar secretos con Wrangler: `npx wrangler secret put WHATSAPP_TOKEN`, `npx wrangler secret put VERIFY_TOKEN` y `npx wrangler secret put META_APP_SECRET`. El ID del número de prueba está configurado como variable en `wrangler.jsonc`.
7. Ejecutar `npm run dev`, exponer el Worker local con una URL HTTPS y configurar `https://TU-DOMINIO/webhook` en Meta.
8. Aplicar las migraciones remotas con `npm run db:remote` y desplegar con `npm run deploy`.

No pongas tokens ni secretos en archivos del repositorio. El token de prueba de Meta expira; para producción se requiere un token apropiado para el servidor.

Antes de habilitar pedidos reales, confirma los precios precargados comparándolos con el menú original de alta resolución.
