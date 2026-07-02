// Loop de venda fechado (offline conversion).
// Disparado por um Database Webhook do Supabase quando um lead vira cliente:
// quando "lead_status" muda para "cliente", envia o evento "CompraFechada" pro Meta
// via CAPI, com o valor da venda e os mesmos identificadores do lead original —
// para o algoritmo otimizar por quem VIRA CLIENTE, não só por quem preenche o form.
//
// Também aceita chamada manual (POST direto) desde que autenticada.
//
// Segurança: exige o header Authorization com o CONVERSION_SECRET. Configure o mesmo
// valor no Database Webhook do Supabase (header Authorization: Bearer <segredo>).
//
// Variáveis de ambiente necessárias:
//   CONVERSION_SECRET                          -> autentica quem chama este endpoint
//   META_PIXEL_ID, META_CAPI_ACCESS_TOKEN      -> Meta Conversions API
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY    -> marcar o lead como já enviado
import { buildUserData, sendCapi } from "../lib/meta.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const secret = process.env.CONVERSION_SECRET;
  const provided = req.headers["authorization"] || req.headers["x-conversion-secret"] || "";
  if (!secret || (provided !== "Bearer " + secret && provided !== secret)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  // Payload do Database Webhook do Supabase: { type, table, record, old_record }.
  // Numa chamada manual, aceita o próprio corpo como o registro.
  const record = body.record || body;
  const oldRecord = body.old_record || {};

  if (record.lead_status !== "cliente") {
    res.status(200).json({ ok: true, skipped: "lead_status != cliente" });
    return;
  }
  if (oldRecord.lead_status === "cliente") {
    res.status(200).json({ ok: true, skipped: "já era cliente" });
    return;
  }
  if (record.capi_purchase_sent) {
    res.status(200).json({ ok: true, skipped: "conversão já enviada" });
    return;
  }

  const tracking = record.tracking || {};
  const userData = buildUserData({
    email: record.email,
    phone: record.whatsapp,
    nome: record.nome,
    browserId: tracking.browser_id,
    user_agent: tracking.user_agent,
    fbp: tracking.fbp,
    fbc: tracking.fbc,
    fbclid: tracking.fbclid,
    fbclid_ts: tracking.fbclid_ts
  });

  const value = Number(record.valor_venda);
  const customData = { content_name: "Projeto fechado" };
  if (!Number.isNaN(value) && value > 0) {
    customData.currency = "BRL";
    customData.value = value;
  }

  const event = {
    event_name: "CompraFechada",
    event_time: Math.floor(Date.now() / 1000),
    // event_id estável derivado do lead: se o webhook disparar 2x, o Meta deduplica.
    event_id: record.event_id ? record.event_id + "-compra" : undefined,
    action_source: "system_generated",
    user_data: userData,
    custom_data: customData
  };

  try {
    const meta = await sendCapi([event]);
    await markSent(record.id);
    res.status(200).json({ ok: true, meta: meta });
  } catch (err) {
    res.status(200).json({ ok: false, error: String(err) });
  }
}

// Marca o lead como convertido para evitar envio duplicado em disparos repetidos do webhook.
async function markSent(id) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !id) return;
  await fetch(url.replace(/\/$/, "") + "/rest/v1/leads?id=eq." + encodeURIComponent(id), {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: "Bearer " + key,
      Prefer: "return=minimal"
    },
    body: JSON.stringify({
      capi_purchase_sent: true,
      fechado_em: new Date().toISOString()
    })
  });
}
