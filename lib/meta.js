// Helpers compartilhados para a Meta Conversions API (CAPI).
// Usados por /api/track.js, /api/notify-lead.js e /api/lead-conversion.js.
import { createHash } from "node:crypto";

// Hash SHA-256 no formato exigido pelo Meta (trim + lowercase). Retorna undefined se vazio.
export function sha256(value) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim().toLowerCase();
  if (!s) return undefined;
  return createHash("sha256").update(s).digest("hex");
}

// Normaliza telefone brasileiro digitado (com máscara) para E.164 sem "+": 55 + DDD + número.
export function normalizePhoneBR(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (!d) return "";
  return "55" + d.replace(/^55/, "");
}

// Divide o nome completo em primeiro nome (fn) e sobrenome (ln).
export function splitName(nome) {
  const p = String(nome || "").trim().split(/\s+/).filter(Boolean);
  if (!p.length) return {};
  return { fn: p[0], ln: p.length > 1 ? p.slice(1).join(" ") : undefined };
}

// Reconstrói o fbc a partir do fbclid quando o cookie _fbc não existe (recomendação do Meta).
export function deriveFbc(fbc, fbclid, ts) {
  if (fbc) return fbc;
  if (!fbclid) return undefined;
  return "fb.1." + (ts || Date.now()) + "." + fbclid;
}

export function getClientIp(req) {
  const f = req.headers["x-forwarded-for"];
  return (Array.isArray(f) ? f[0] : f || "").split(",")[0].trim();
}

// Monta o objeto user_data do Meta com o máximo de parâmetros de correspondência disponíveis.
// Campos de PII vão hasheados (em, ph, fn, ln, external_id, country);
// ip, user_agent, fbp e fbc vão em texto puro (exigência do Meta).
export function buildUserData(id) {
  id = id || {};
  const ud = {};

  const em = sha256(id.email);
  const phone = normalizePhoneBR(id.phone);
  const ph = phone ? sha256(phone) : undefined;
  const nm = splitName(id.nome);
  const fn = sha256(nm.fn);
  const ln = sha256(nm.ln);
  const country = sha256("br");

  // external_id: e-mail hasheado (identidade) + browser_id estável (cross-evento).
  const ext = [];
  const emExt = sha256(id.email);
  if (emExt) ext.push(emExt);
  const bid = sha256(id.browserId);
  if (bid) ext.push(bid);

  if (em) ud.em = [em];
  if (ph) ud.ph = [ph];
  if (fn) ud.fn = [fn];
  if (ln) ud.ln = [ln];
  if (ext.length) ud.external_id = ext;
  if (country) ud.country = [country];
  if (id.ip) ud.client_ip_address = id.ip;
  if (id.user_agent) ud.client_user_agent = id.user_agent;
  if (id.fbp) ud.fbp = id.fbp;
  const fbc = deriveFbc(id.fbc, id.fbclid, id.fbclid_ts);
  if (fbc) ud.fbc = fbc;

  return ud;
}

// Envia um ou mais eventos para a Conversions API do Meta.
export async function sendCapi(events) {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_ACCESS_TOKEN;
  if (!pixelId || !token) throw new Error("META_PIXEL_ID / META_CAPI_ACCESS_TOKEN ausentes");

  const body = { data: events, access_token: token };
  if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;

  const resp = await fetch("https://graph.facebook.com/v21.0/" + pixelId + "/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const t = await resp.text();
  if (!resp.ok) throw new Error("Meta CAPI respondeu " + resp.status + ": " + t);
  return t;
}
