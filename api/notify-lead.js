import { createHash } from "node:crypto";

// Recebe um novo lead do quiz e dispara, em paralelo e de forma independente:
//   1) gravação no Supabase (histórico completo + dados de tracking em "tracking" jsonb)
//   2) notificação no WhatsApp do Igor via CallMeBot
//   3) notificação por e-mail via Resend (canal redundante ao WhatsApp)
//   4) evento "Lead" pro Meta via Conversions API (server-side, casado com o Pixel
//      pelo mesmo event_id para deduplicação automática)
// Falha em um canal não impede os outros.
//
// Variáveis de ambiente necessárias no projeto Vercel:
//   CALLMEBOT_PHONE, CALLMEBOT_APIKEY               -> WhatsApp (CallMeBot)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY         -> gravação no banco (tabela "leads")
//   RESEND_API_KEY, LEAD_NOTIFY_EMAIL               -> e-mail (Resend)
//   META_PIXEL_ID, META_CAPI_ACCESS_TOKEN           -> Meta Conversions API
//   META_TEST_EVENT_CODE (opcional)                 -> só durante testes no Events Manager
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const data = req.body || {};

  const resumoLinhas = [
    "Nome: " + (data.nome || "-"),
    "WhatsApp: " + (data.whatsapp || "-"),
    "E-mail: " + (data.email || "-"),
    "Instagram: " + (data.instagram || "-"),
    "",
    "Relação com a loja: " + (data.relacao || "-"),
    "Origem dos clientes: " + (data.origem || "-"),
    "Faturamento: " + (data.faturamento || "-"),
    "Maior dor: " + (data.dor || "-") + (data.dor_outro ? " (" + data.dor_outro + ")" : ""),
    "Investimento em anúncios: " + (data.investimento || "-"),
    "Desqualificado: " + (data.desqualificado ? "Sim" : "Não")
  ];

  const [supabaseResult, whatsappResult, emailResult, metaResult] = await Promise.allSettled([
    saveToSupabase(data),
    notifyWhatsapp(resumoLinhas),
    notifyEmail(resumoLinhas, data),
    sendMetaCapi(data, req)
  ]);

  res.status(200).json({
    ok: true,
    supabase: settledToResult(supabaseResult),
    whatsapp: settledToResult(whatsappResult),
    email: settledToResult(emailResult),
    meta_capi: settledToResult(metaResult)
  });
}

function settledToResult(settled) {
  return settled.status === "fulfilled"
    ? { ok: true, detail: settled.value }
    : { ok: false, error: String(settled.reason) };
}

async function saveToSupabase(data) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes");

  const resp = await fetch(url.replace(/\/$/, "") + "/rest/v1/leads", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: "Bearer " + key,
      Prefer: "return=minimal"
    },
    body: JSON.stringify({
      event_id: data.event_id || null,
      nome: data.nome || null,
      whatsapp: data.whatsapp || null,
      email: data.email || null,
      instagram: data.instagram || null,
      relacao: data.relacao || null,
      origem: data.origem || null,
      faturamento: data.faturamento || null,
      dor: data.dor || null,
      dor_outro: data.dor_outro || null,
      investimento: data.investimento || null,
      desqualificado: !!data.desqualificado,
      tracking: data.tracking || null
    })
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error("Supabase respondeu " + resp.status + ": " + body);
  }
  return "lead salvo";
}

async function notifyWhatsapp(resumoLinhas) {
  const phone = process.env.CALLMEBOT_PHONE;
  const apikey = process.env.CALLMEBOT_APIKEY;
  if (!phone || !apikey) throw new Error("CALLMEBOT_PHONE / CALLMEBOT_APIKEY ausentes");

  const texto = ["Novo lead: Diagnóstico de Móveis Planejados", ""].concat(resumoLinhas).join("\n");
  const url =
    "https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(phone) +
    "&text=" + encodeURIComponent(texto) +
    "&apikey=" + encodeURIComponent(apikey);

  const resp = await fetch(url);
  const body = await resp.text();
  if (/error/i.test(body) || /invalid/i.test(body)) {
    throw new Error("CallMeBot retornou erro: " + body);
  }
  return body;
}

async function notifyEmail(resumoLinhas, data) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_NOTIFY_EMAIL;
  if (!apiKey || !to) throw new Error("RESEND_API_KEY / LEAD_NOTIFY_EMAIL ausentes");

  const texto = resumoLinhas.join("\n");
  const html = "<pre style=\"font-family: monospace; white-space: pre-wrap;\">" +
    resumoLinhas.map(escapeHtml).join("\n") + "</pre>";

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey
    },
    body: JSON.stringify({
      from: "Diagnóstico Planejados <onboarding@resend.dev>",
      to: [to],
      subject: "Novo lead: " + (data.nome || "Diagnóstico de Móveis Planejados"),
      text: texto,
      html: html
    })
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error("Resend respondeu " + resp.status + ": " + body);
  }
  return "e-mail enviado";
}

function sha256(value) {
  return createHash("sha256").update(String(value).trim().toLowerCase()).digest("hex");
}

async function sendMetaCapi(data, req) {
  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  if (!pixelId || !accessToken) throw new Error("META_PIXEL_ID / META_CAPI_ACCESS_TOKEN ausentes");

  const tracking = data.tracking || {};

  // Assume leads brasileiros: normaliza o WhatsApp digitado (formato local) para E.164 (55 + DDD + número).
  const phoneDigits = String(data.whatsapp || "").replace(/\D/g, "");
  const phoneE164 = phoneDigits ? "55" + phoneDigits.replace(/^55/, "") : "";

  const forwardedFor = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor || "").split(",")[0].trim();

  const userData = {};
  if (data.email) userData.em = [sha256(data.email)];
  if (phoneE164) userData.ph = [sha256(phoneE164)];
  if (ip) userData.client_ip_address = ip;
  if (tracking.user_agent) userData.client_user_agent = tracking.user_agent;
  if (tracking.fbp) userData.fbp = tracking.fbp;
  if (tracking.fbc) userData.fbc = tracking.fbc;

  const eventPayload = {
    event_name: "Lead",
    event_time: Math.floor(Date.now() / 1000),
    event_id: data.event_id || undefined,
    action_source: "website",
    event_source_url: tracking.page_url || tracking.landing_url || undefined,
    user_data: userData,
    custom_data: {
      content_name: "Diagnóstico Móveis Planejados"
    }
  };

  const body = { data: [eventPayload], access_token: accessToken };
  if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;

  const resp = await fetch("https://graph.facebook.com/v21.0/" + pixelId + "/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const respBody = await resp.text();
  if (!resp.ok) {
    throw new Error("Meta CAPI respondeu " + resp.status + ": " + respBody);
  }
  return respBody;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
