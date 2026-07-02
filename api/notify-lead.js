// Recebe um novo lead do quiz e:
//   1) grava no Supabase (histórico de todos os leads)
//   2) notifica o WhatsApp do Igor via CallMeBot
//   3) notifica por e-mail via Resend (canal redundante, caso o WhatsApp falhe)
// Os três canais rodam em paralelo e são independentes: falha em um não impede os outros.
//
// Variáveis de ambiente necessárias no projeto Vercel:
//   CALLMEBOT_PHONE, CALLMEBOT_APIKEY       -> WhatsApp (CallMeBot)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY -> gravação no banco (tabela "leads")
//   RESEND_API_KEY, LEAD_NOTIFY_EMAIL       -> e-mail (Resend)
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

  const [supabaseResult, whatsappResult, emailResult] = await Promise.allSettled([
    saveToSupabase(data),
    notifyWhatsapp(resumoLinhas),
    notifyEmail(resumoLinhas, data)
  ]);

  res.status(200).json({
    ok: true,
    supabase: settledToResult(supabaseResult),
    whatsapp: settledToResult(whatsappResult),
    email: settledToResult(emailResult)
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
      desqualificado: !!data.desqualificado
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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
