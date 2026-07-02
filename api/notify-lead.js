// Handler do envio final do quiz. Dispara, em paralelo e de forma independente:
//   1) gravação no Supabase (histórico completo + tracking jsonb + lead_status)
//   2) notificação instantânea no Telegram do Igor
//   3) notificação no WhatsApp via CallMeBot (canal redundante, pode atrasar)
//   4) notificação por e-mail via Resend (canal redundante)
//   5) evento de conversão pro Meta via CAPI:
//        - "Lead" quando o lead é qualificado (evento de otimização)
//        - "LeadDesqualificado" quando não é (público separado, não otimiza por ele)
//      com user_data completo e o mesmo event_id do Pixel (dedup).
// Falha em um canal não impede os outros.
//
// Variáveis de ambiente necessárias no projeto Vercel:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID            -> notificação instantânea no Telegram
//   CALLMEBOT_PHONE, CALLMEBOT_APIKEY               -> WhatsApp (CallMeBot, redundante)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY         -> gravação no banco (tabela "leads")
//   RESEND_API_KEY, LEAD_NOTIFY_EMAIL               -> e-mail (Resend)
//   META_PIXEL_ID, META_CAPI_ACCESS_TOKEN           -> Meta Conversions API
//   META_TEST_EVENT_CODE (opcional)                 -> só durante testes no Events Manager
import { buildUserData, getClientIp, sendCapi } from "../lib/meta.js";

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
    "Qualificado: " + (data.desqualificado ? "Não" : "Sim")
  ];

  const [supabaseResult, telegramResult, whatsappResult, emailResult, metaResult] = await Promise.allSettled([
    saveToSupabase(data),
    notifyTelegram(resumoLinhas, data),
    notifyWhatsapp(resumoLinhas),
    notifyEmail(resumoLinhas, data),
    sendLeadCapi(data, req)
  ]);

  res.status(200).json({
    ok: true,
    supabase: settledToResult(supabaseResult),
    telegram: settledToResult(telegramResult),
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
      lead_status: "novo",
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

async function notifyTelegram(resumoLinhas, data) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID ausentes");

  const cabecalho = data.desqualificado
    ? "🟡 Novo lead (desqualificado) — Diagnóstico Planejados"
    : "🟢 Novo lead — Diagnóstico Planejados";
  const texto = [cabecalho, ""].concat(resumoLinhas).join("\n");

  const resp = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: texto,
      disable_web_page_preview: true
    })
  });

  const body = await resp.text();
  if (!resp.ok) {
    throw new Error("Telegram respondeu " + resp.status + ": " + body);
  }
  return "notificado no Telegram";
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
      subject: "Novo lead" + (data.desqualificado ? " (desqualificado)" : "") + ": " + (data.nome || "Diagnóstico"),
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

async function sendLeadCapi(data, req) {
  const tracking = data.tracking || {};
  const qualified = !data.desqualificado;

  const userData = buildUserData({
    email: data.email,
    phone: data.whatsapp,
    nome: data.nome,
    browserId: tracking.browser_id,
    ip: getClientIp(req),
    user_agent: tracking.user_agent,
    fbp: tracking.fbp,
    fbc: tracking.fbc,
    fbclid: tracking.fbclid,
    fbclid_ts: tracking.fbclid_ts
  });

  const event = {
    event_name: qualified ? "Lead" : "LeadDesqualificado",
    event_time: Math.floor(Date.now() / 1000),
    event_id: data.event_id || undefined,
    action_source: "website",
    event_source_url: tracking.page_url || tracking.landing_url || undefined,
    user_data: userData,
    custom_data: {
      content_name: "Diagnóstico Móveis Planejados",
      faturamento: data.faturamento || undefined,
      investimento: data.investimento || undefined,
      qualificado: qualified ? "sim" : "nao"
    }
  };

  return sendCapi([event]);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
