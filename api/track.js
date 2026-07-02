// Espelho server-side (CAPI) dos eventos de funil disparados pelo Pixel no navegador.
// Chamado via navigator.sendBeacon a cada evento (PageView, ViewContent, QuizStart,
// QuizStepCompleted). O evento de conversão final (Lead/LeadDesqualificado) NÃO passa
// aqui — ele é tratado por /api/notify-lead.js com user_data completo.
//
// Cada evento carrega o mesmo event_id do disparo do Pixel, então o Meta deduplica
// automaticamente os dois lados. Cobre também o caso de ad blocker: se o Pixel do
// navegador for bloqueado, a CAPI ainda registra o evento.
import { buildUserData, getClientIp, sendCapi } from "../lib/meta.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let data = req.body;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch (e) { data = {}; }
  }
  data = data || {};
  const id = data.identifiers || {};

  try {
    const userData = buildUserData({
      browserId: id.browser_id,
      ip: getClientIp(req),
      user_agent: id.user_agent,
      fbp: id.fbp,
      fbc: id.fbc,
      fbclid: id.fbclid,
      fbclid_ts: id.fbclid_ts
    });

    const event = {
      event_name: data.event_name,
      event_time: data.event_time || Math.floor(Date.now() / 1000),
      event_id: data.event_id || undefined,
      action_source: "website",
      event_source_url: data.event_source_url || id.page_url || undefined,
      user_data: userData,
      custom_data: data.custom_data || {}
    };

    const meta = await sendCapi([event]);
    res.status(200).json({ ok: true, meta: meta });
  } catch (err) {
    // Não propaga erro: beacon ignora a resposta e não queremos retry.
    res.status(200).json({ ok: false, error: String(err) });
  }
}
