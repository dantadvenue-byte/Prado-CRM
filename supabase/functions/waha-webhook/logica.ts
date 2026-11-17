// ============================================================
// waha-webhook — LÓGICA PURA (sem rede, sem banco). Testável isoladamente.
// Converte eventos da WAHA (motor NOWEB) para o formato que o CRM já grava
// em crm_mensagens / crm_conversas / crm_conexoes (o mesmo do whatsapp-webhook).
// ============================================================

// ---------- IDs ----------
// A WAHA serializa o id como "<fromMe>_<chatId>_<id>[_<participante>]"
// (ex.: "true_5591999999999@c.us_3EB0ABC..."). O CRM guarda só o <id> curto,
// igual à Evolution (key.id). Usar SEMPRE este formato evita duplicar mensagens.
export function idCurto(valor: unknown): string {
  if (valor == null) return "";
  if (typeof valor === "object") {
    const o = valor as Record<string, unknown>;
    if (typeof o.id === "string" && o.id) return idCurto(o.id);
    if (o._serialized) return idCurto(o._serialized);
    return "";
  }
  const s = String(valor).trim();
  if (!s) return "";
  const partes = s.split("_");
  if (partes.length >= 3 && (partes[0] === "true" || partes[0] === "false")) return partes[2];
  return s;
}

// ---------- Números / chats ----------
export function soDigitos(s: unknown): string {
  return String(s ?? "").replace(/\D/g, "");
}

// Tipo do JID: usuário (c.us / s.whatsapp.net), lid (id oculto), ou algo a ignorar.
export function tipoJid(jid: string): "usuario" | "lid" | "ignorar" {
  const j = String(jid || "");
  if (!j) return "ignorar";
  if (j.endsWith("@g.us") || j.endsWith("@newsletter") || j.endsWith("@broadcast") || j === "status@broadcast") return "ignorar";
  if (j.endsWith("@lid")) return "lid";
  if (j.endsWith("@c.us") || j.endsWith("@s.whatsapp.net")) return "usuario";
  return "ignorar";
}

// Procura o número real quando o chat vem como @lid (o Baileys às vezes manda o
// número em campos "Alt"/"Pn" da key). Retorna só dígitos ou "".
export function numeroAlternativoDoLid(dados: any): string {
  const k = dados?.key ?? {};
  const candidatos = [k.remoteJidAlt, k.senderPn, k.participantAlt, k.participantPn, dados?.senderPn];
  for (const c of candidatos) {
    if (typeof c === "string" && tipoJid(c) === "usuario") {
      const d = soDigitos(c.split("@")[0]);
      if (d.length >= 10 && d.length <= 15) return d;
    }
  }
  return "";
}

// ---------- Status ----------
// session.status da WAHA -> status de crm_conexoes (mesmos valores que a tela já usa).
export function statusConexao(statusWaha: unknown): string {
  const s = String(statusWaha || "").toUpperCase();
  if (s === "WORKING") return "conectado";
  if (s === "STARTING" || s === "SCAN_QR_CODE" || s === "PASSKEY_REQUIRED" || s === "PASSKEY_CONFIRMATION_REQUIRED") return "conectando";
  return "desconectado"; // STOPPED, FAILED, desconhecido
}

// message.ack (número) -> status de crm_mensagens (mesmo padrão do whatsapp-webhook).
// -1 ERROR, 0 PENDING, 1 SERVER, 2 DEVICE, 3 READ, 4 PLAYED
export function statusAck(ack: unknown): string | null {
  const n = Number(ack);
  if (n === 1) return "sent";
  if (n === 2) return "delivered";
  if (n === 3 || n === 4) return "read";
  return null;
}

// ---------- Conteúdo (o _data do NOWEB é a mensagem crua do Baileys, igual à da Evolution) ----------
export type Conteudo = { tipo: string; texto: string; midia_mime: string | null; extensao: string | null };

export function extrairConteudo(dados: any, payload: any): Conteudo {
  const m = dados?.message ?? {};
  // Mensagens "embrulhadas" (visualização única, efêmeras, editadas) trazem o conteúdo dentro.
  const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ??
    m.documentWithCaptionMessage?.message ?? null;
  const x = inner ?? m;
  if (x.conversation) return { tipo: "text", texto: x.conversation, midia_mime: null, extensao: null };
  if (x.extendedTextMessage?.text) return { tipo: "text", texto: x.extendedTextMessage.text, midia_mime: null, extensao: null };
  if (x.imageMessage) return { tipo: "image", texto: x.imageMessage.caption ?? "", midia_mime: x.imageMessage.mimetype ?? "image/jpeg", extensao: "jpg" };
  if (x.videoMessage) return { tipo: "video", texto: x.videoMessage.caption ?? "", midia_mime: x.videoMessage.mimetype ?? "video/mp4", extensao: "mp4" };
  if (x.audioMessage) return { tipo: "audio", texto: "", midia_mime: x.audioMessage.mimetype ?? "audio/ogg", extensao: "ogg" };
  if (x.documentMessage) {
    const nome = x.documentMessage.fileName ?? "documento";
    return { tipo: "document", texto: nome, midia_mime: x.documentMessage.mimetype ?? "application/octet-stream", extensao: extensaoSegura(nome.split(".").pop()) };
  }
  if (x.stickerMessage) return { tipo: "sticker", texto: "", midia_mime: x.stickerMessage.mimetype ?? "image/webp", extensao: "webp" };
  if (x.locationMessage) return { tipo: "location", texto: x.locationMessage.degreesLatitude + "," + x.locationMessage.degreesLongitude, midia_mime: null, extensao: null };

  // Fallback pelos campos normalizados da WAHA (caso o _data venha diferente).
  if (payload?.hasMedia) {
    const mime = String(payload?.media?.mimetype || "application/octet-stream");
    const tipo = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "document";
    const nome = payload?.media?.filename || "";
    const ext = tipo === "image" ? "jpg" : tipo === "video" ? "mp4" : tipo === "audio" ? "ogg" : extensaoSegura(String(nome).split(".").pop());
    return { tipo, texto: tipo === "document" ? (nome || "documento") : String(payload?.body || ""), midia_mime: mime, extensao: ext };
  }
  if (typeof payload?.body === "string" && payload.body.length > 0) return { tipo: "text", texto: payload.body, midia_mime: null, extensao: null };
  return { tipo: "other", texto: "[mensagem nao suportada]", midia_mime: null, extensao: null };
}

// Mensagens "de sistema" do WhatsApp (reação, edição, apagar, enquete, chaves) não viram bolha no chat.
const CHAVES_SISTEMA = ["protocolMessage", "reactionMessage", "pollUpdateMessage", "editedMessage", "keepInChatMessage", "encReactionMessage"];
const CHAVES_NEUTRAS = ["messageContextInfo", "senderKeyDistributionMessage"];
export function ehMensagemDeSistema(dados: any): boolean {
  const m = dados?.message;
  if (!m || typeof m !== "object") return false; // sem _data: decide pelo fallback normal
  const chaves = Object.keys(m).filter((k) => !CHAVES_NEUTRAS.includes(k));
  // Mensagem VAZIA (ex.: não deu para descriptografar) NÃO é descartada: entra como
  // "[mensagem nao suportada]" para o lead nunca sumir do CRM.
  if (chaves.length === 0) return false;
  return chaves.every((k) => CHAVES_SISTEMA.includes(k));
}

export function extensaoSegura(ext: unknown): string {
  const e = String(ext || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5);
  return e || "bin";
}

// Resposta (reply): mesmo formato que o whatsapp-webhook grava.
export function extrairReply(dados: any): { reply_to_message_id: string; reply_to_text: string; reply_to_type: string } | null {
  const m = dados?.message ?? {};
  const ctx = m.extendedTextMessage?.contextInfo ?? m.imageMessage?.contextInfo ?? m.videoMessage?.contextInfo ??
    m.audioMessage?.contextInfo ?? m.documentMessage?.contextInfo ?? m.stickerMessage?.contextInfo ??
    m.locationMessage?.contextInfo ?? m.contextInfo ?? null;
  const stanzaId = ctx?.stanzaId ?? ctx?.stanzaID ?? null;
  const q = ctx?.quotedMessage ?? null;
  if (!stanzaId || !q) return null;
  let tipo = "text", texto = "";
  if (q.conversation) texto = q.conversation;
  else if (q.extendedTextMessage?.text) texto = q.extendedTextMessage.text;
  else if (q.imageMessage) { tipo = "image"; texto = q.imageMessage.caption ?? ""; }
  else if (q.videoMessage) { tipo = "video"; texto = q.videoMessage.caption ?? ""; }
  else if (q.audioMessage) { tipo = "audio"; }
  else if (q.documentMessage) { tipo = "document"; texto = q.documentMessage.fileName ?? ""; }
  else if (q.stickerMessage) { tipo = "sticker"; }
  else if (q.locationMessage) { tipo = "location"; texto = (q.locationMessage.degreesLatitude ?? "") + "," + (q.locationMessage.degreesLongitude ?? ""); }
  return { reply_to_message_id: String(stanzaId), reply_to_text: texto, reply_to_type: tipo };
}

// Anúncio do Facebook/Instagram (card externalAdReply) — mesmo formato do whatsapp-webhook.
export function extrairAnuncio(dados: any): Record<string, unknown> | null {
  const m = dados?.message ?? {};
  const ctx = m.extendedTextMessage?.contextInfo ?? m.imageMessage?.contextInfo ?? m.videoMessage?.contextInfo ?? m.contextInfo ?? null;
  const ad = ctx?.externalAdReply ?? null;
  if (!ad) return null;
  return {
    titulo: ad.title ?? null, corpo: ad.body ?? null, thumbnail_url: ad.thumbnailUrl ?? ad.thumbnail ?? null,
    source_url: ad.sourceUrl ?? null, source_id: ad.sourceId ?? null, source_type: ad.sourceType ?? null, media_type: ad.mediaType ?? null,
  };
}

export function previewDe(c: Conteudo): string {
  return c.tipo === "text" ? c.texto.slice(0, 80) : "[" + c.tipo + "]";
}

export function corpoPush(c: Conteudo): string {
  if (c.tipo === "audio") return "🎤 Áudio";
  if (c.tipo === "image") return "📷 Imagem";
  if (c.tipo === "video") return "🎥 Vídeo";
  if (c.tipo === "document") return "📄 Documento";
  if (c.tipo === "sticker") return "Figurinha";
  return c.texto;
}

// Timestamp da WAHA vem em SEGUNDOS (às vezes ms). Retorna ISO.
export function quandoISO(ts: unknown, agora: Date = new Date()): string {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return agora.toISOString();
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? agora.toISOString() : d.toISOString();
}

// ---------- Mídia: só baixa da PRÓPRIA WAHA, pelo caminho /api/files/ (anti-SSRF) ----------
// Ignora o host que vem no evento (pode ser "localhost:3000") e usa o WAHA_URL configurado.
export function urlMidiaSegura(mediaUrl: unknown, wahaUrl: string): string | null {
  if (!mediaUrl || !wahaUrl) return null;
  try {
    const u = new URL(String(mediaUrl));
    if (!u.pathname.startsWith("/api/files/")) return null;
    if (u.pathname.includes("..")) return null;
    return wahaUrl.replace(/\/+$/, "") + u.pathname;
  } catch {
    return null;
  }
}

// ---------- HMAC (X-Webhook-Hmac, sha512 sobre o corpo cru) ----------
export async function hmacSha512Hex(chave: string, corpo: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(corpo));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function iguaisTempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function hmacValido(chave: string, corpo: string, recebido: string | null): Promise<boolean> {
  if (!chave || !recebido) return false;
  const esperado = await hmacSha512Hex(chave, corpo);
  return iguaisTempoConstante(esperado, String(recebido).trim().toLowerCase());
}
