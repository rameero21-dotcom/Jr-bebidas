const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

// El Access Token vive en Secret Manager (se carga con
// `firebase functions:secrets:set MP_ACCESS_TOKEN`), nunca en este
// archivo ni en el repositorio.
const MP_ACCESS_TOKEN = defineSecret("MP_ACCESS_TOKEN");

// Origen permitido de la web (GitHub Pages). Si en algún momento Jr
// Bebidas tiene dominio propio, agregarlo acá también.
const ORIGEN_PERMITIDO = "https://rameero21-dotcom.github.io";

/**
 * Recibe el carrito armado en la web (items con nombre, cantidad y
 * precio unitario) y crea una preferencia de pago en Mercado Pago
 * (Checkout Pro). Devuelve el link ("init_point") al que hay que mandar
 * al cliente para que pague el total exacto de su pedido.
 *
 * El precio de cada línea se valida acá (no se confía ciegamente en lo
 * que mande el navegador): tiene que ser un número positivo razonable.
 */
exports.crearPreferenciaMercadoPago = onRequest(
  { region: "southamerica-east1", secrets: [MP_ACCESS_TOKEN], cors: [ORIGEN_PERMITIDO] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Método no permitido" });
      return;
    }

    try {
      const itemsRecibidos = Array.isArray(req.body?.items) ? req.body.items : [];
      if (itemsRecibidos.length === 0) {
        res.status(400).json({ error: "El pedido está vacío" });
        return;
      }
      if (itemsRecibidos.length > 100) {
        res.status(400).json({ error: "El pedido tiene demasiados productos" });
        return;
      }

      const items = itemsRecibidos.map((it) => {
        const title = String(it?.title || "Producto").slice(0, 200);
        const quantity = Math.max(1, Math.min(999, Math.round(Number(it?.quantity) || 1)));
        const unitPrice = Number(it?.unit_price);
        if (!Number.isFinite(unitPrice) || unitPrice <= 0 || unitPrice > 5_000_000) {
          throw new Error(`Precio inválido para "${title}"`);
        }
        return {
          title,
          quantity,
          unit_price: Math.round(unitPrice * 100) / 100,
          currency_id: "ARS",
        };
      });

      const nombreCliente = String(req.body?.payerName || "").slice(0, 100);

      const preferencia = {
        items,
        payer: nombreCliente ? { name: nombreCliente } : undefined,
        back_urls: {
          success: `${ORIGEN_PERMITIDO}/?pago=aprobado`,
          pending: `${ORIGEN_PERMITIDO}/?pago=pendiente`,
          failure: `${ORIGEN_PERMITIDO}/?pago=rechazado`,
        },
        auto_return: "approved",
        statement_descriptor: "JR BEBIDAS",
      };

      const respuestaMp = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${MP_ACCESS_TOKEN.value()}`,
        },
        body: JSON.stringify(preferencia),
      });

      const datos = await respuestaMp.json();
      if (!respuestaMp.ok) {
        logger.error("Mercado Pago rechazó la preferencia", datos);
        res.status(502).json({ error: "No se pudo generar el link de pago" });
        return;
      }

      res.status(200).json({ init_point: datos.init_point });
    } catch (e) {
      logger.warn("Pedido inválido al crear preferencia", e.message);
      res.status(400).json({ error: e.message || "No se pudo generar el link de pago" });
    }
  }
);
