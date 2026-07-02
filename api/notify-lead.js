// Envia uma notificação de novo lead para o WhatsApp do Igor via CallMeBot.
// Requer as variáveis de ambiente CALLMEBOT_PHONE e CALLMEBOT_APIKEY configuradas no projeto Vercel.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const phone = process.env.CALLMEBOT_PHONE;
  const apikey = process.env.CALLMEBOT_APIKEY;

  if (!phone || !apikey) {
    res.status(500).json({ error: "CallMeBot não configurado (CALLMEBOT_PHONE / CALLMEBOT_APIKEY ausentes)" });
    return;
  }

  const data = req.body || {};

  const linhas = [
    "Novo lead: Diagnóstico de Móveis Planejados",
    "",
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
  const texto = linhas.join("\n");

  const url =
    "https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(phone) +
    "&text=" + encodeURIComponent(texto) +
    "&apikey=" + encodeURIComponent(apikey);

  try {
    const resp = await fetch(url);
    const body = await resp.text();
    res.status(200).json({ ok: true, callmebot: body });
  } catch (err) {
    res.status(502).json({ error: "Falha ao contatar CallMeBot", details: String(err) });
  }
}
