const pageStyle = `
  body { margin: 0; background: #f6f7f9; color: #17202a; font: 16px/1.6 system-ui, -apple-system, Segoe UI, sans-serif; }
  main { max-width: 780px; margin: 40px auto; padding: 32px; background: white; border-radius: 14px; box-shadow: 0 4px 22px #10203014; }
  h1, h2 { line-height: 1.25; } h1 { color: #a14f0b; } a { color: #075e54; }
  .date { color: #59636e; } footer { margin-top: 32px; border-top: 1px solid #ddd; padding-top: 16px; color: #59636e; }
  @media (max-width: 600px) { main { margin: 12px; padding: 22px; } }
`;

function render(title: string, body: string): Response {
  return new Response(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} | La Salvajada de Willian</title><style>${pageStyle}</style></head><body><main>${body}</main></body></html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}

export function privacyPolicyPage(): Response {
  return render("Política de privacidad", `
    <h1>Política de privacidad</h1>
    <p class="date">Última actualización: 24 de noviembre de 2026</p>
    <p>La Salvajada de Willian usa este chatbot de WhatsApp para informar sobre el menú, recibir pedidos a domicilio y atender solicitudes de sus clientes. Esta política explica qué datos se reciben y cómo se usan.</p>
    <h2>Responsable y contacto</h2>
    <p>Responsable: La Salvajada de Willian, barrio El Dorado, Colombia. Para consultas sobre privacidad o para ejercer tus derechos, escribe a <a href="mailto:rubenx544@gmail.com">rubenx544@gmail.com</a>.</p>
    <h2>Datos que podemos recibir</h2>
    <ul>
      <li>Tu número de teléfono y el contenido de los mensajes que envías por WhatsApp.</li>
      <li>El nombre que nos indiques, los productos del pedido, el método de pago elegido y el estado del pedido.</li>
      <li>La dirección de entrega y, si decides compartirla, las coordenadas de tu ubicación.</li>
    </ul>
    <h2>Para qué usamos los datos</h2>
    <p>Usamos estos datos para responderte, preparar y entregar pedidos, confirmar la información del pedido, resolver consultas y atender solicitudes para hablar con un encargado. No usamos la ubicación para publicidad ni vendemos datos personales.</p>
    <h2>Servicios que intervienen</h2>
    <p>Los mensajes se procesan mediante WhatsApp Business Platform de Meta. El chatbot y la base de datos del pedido funcionan en Cloudflare. Estos proveedores procesan la información necesaria para prestar el servicio, conforme a sus propias condiciones y políticas.</p>
    <h2>Conservación y seguridad</h2>
    <p>Conservamos la información mientras sea necesaria para gestionar el pedido, atender consultas y cumplir obligaciones aplicables. Aplicamos medidas razonables para protegerla y limitar su acceso. Ningún sistema puede garantizar seguridad absoluta.</p>
    <h2>Tus opciones y derechos</h2>
    <p>Puedes solicitar acceso, corrección, actualización o supresión de tus datos, o retirar una autorización cuando corresponda. Escribe a <a href="mailto:rubenx544@gmail.com">rubenx544@gmail.com</a> desde el correo que prefieras e indica el número de WhatsApp asociado. Evaluaremos la solicitud y responderemos; ciertos registros podrían conservarse cuando exista una obligación legal o contractual.</p>
    <p>Más información: <a href="https://www.sic.gov.co/tema/proteccion-de-datos-personales">Superintendencia de Industria y Comercio de Colombia</a> y <a href="https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981">Ley 1581 de 2012</a>.</p>
    <footer>La Salvajada de Willian · Barrio El Dorado · Colombia</footer>
  `);
}

export function dataDeletionPage(): Response {
  return render("Solicitud de eliminación de datos", `
    <h1>Solicitar acceso o eliminación de datos</h1>
    <p>Para solicitar acceso, corrección, actualización o eliminación de los datos asociados a tus pedidos de WhatsApp de La Salvajada de Willian, escribe a <a href="mailto:rubenx544@gmail.com?subject=Solicitud%20de%20datos%20personales">rubenx544@gmail.com</a>.</p>
    <p>Incluye el número de WhatsApp usado para el pedido, el tipo de solicitud y, si aplica, una referencia del pedido. Te responderemos para verificar la solicitud y tramitarla. Podemos conservar los datos que debamos mantener por obligaciones legales o contractuales.</p>
    <p>Consulta la <a href="/privacy">Política de privacidad</a> para más información.</p>
    <footer>La Salvajada de Willian · Barrio El Dorado · Colombia</footer>
  `);
}
