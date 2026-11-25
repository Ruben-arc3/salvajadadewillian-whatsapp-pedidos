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
- Al marcar un pedido de WhatsApp como entregado desde la app Flutter, el Worker registra el ingreso y envía el mensaje de entrega al cliente. D1 conserva el estado del mensaje para evitar reenviarlo al sincronizar de nuevo; si WhatsApp lo rechaza, el panel permite reintentarlo.

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

## Punto de venta móvil

La carpeta `mobile_app/` contiene la app Android Flutter. Usa SQLite local mediante Drift y conserva acciones pendientes con UUID para reintentar la sincronización. El Worker guarda los datos compartidos en D1.

1. Configura `ADMIN_PASSWORD` (contraseña del administrador inicial) y `POS_AUTH_SECRET` como secretos del Worker. Usa una clave aleatoria distinta para `POS_AUTH_SECRET`.
2. Aplica las migraciones locales y luego remotas con `npm run db:local` y `npm run db:remote`. La migración `0006_pos_operations.sql` agrega usuarios, turnos, ventas, inventario, recetas, caja y auditoría; `0007_whatsapp_delivery_message.sql` guarda el estado del aviso enviado al cliente.
3. Publica el Worker con `npm run deploy` para habilitar las rutas `/api/*`.
4. En `mobile_app/`, ejecuta `flutter pub get` y `flutter run`. Inicia sesión con usuario `admin` y el valor de `ADMIN_PASSWORD`; luego crea cajeros desde Administración con PIN de 4 a 8 dígitos.
5. Crea productos e insumos, registra existencias y costos, y asigna una receta a cada producto antes de venderlo. Las compras y ajustes de inventario requieren motivo y el rol ADMIN.
6. Abre el turno con su base inicial. El cierre se hace contando efectivo y transferencias sin mostrar los valores esperados antes del conteo.

La app sincroniza automáticamente cuando detecta conectividad y muestra operaciones pendientes. La primera instalación y el inicio de sesión requieren internet. Las operaciones locales se sincronizan con validación del Worker; revisa el contador de pendientes y las respuestas rechazadas antes de dar por conciliado un turno.
