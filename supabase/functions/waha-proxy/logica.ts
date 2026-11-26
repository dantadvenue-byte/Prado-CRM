// ============================================================
// waha-proxy — LÓGICA PURA (sem rede, sem banco). Testável isoladamente.
// ============================================================

export const ACOES_SESSAO = ["criar", "qr", "codigo", "status", "reiniciar", "desconectar", "excluir", "sincronizar"] as const;
// Ações de sessão que qualquer usuário do CRM pode usar (só leitura). As demais são só de admin.
export const ACOES_SESSAO_LEITURA = ["status"];
export const ACOES_MENSAGEM = ["enviar_texto", "enviar_midia", "enviar_localizacao", "presenca", "foto_perfil", "verificar_numero"] as const;
export const PAPEIS_OK = ["atendente", "gestor_comercial", "admin"];
export const TIPOS_MIDIA = ["image", "video", "audio", "document"];
export const MAX_TEXTO = 4096;

export function soDigitos(s: unknown): string {
  return String(s ?? "").replace(/\D/g, "");
}

// Igual ao waha-webhook: guarda só o id curto (o que a Evolution chama de key.id).
export function idCurto(valor: unknown): string {
  if (valor == null) return "";
  if (typeof valor === "object") {
    const o = valor as Record<string, unknown>;
    if (typeof o.id === "string" && o.id) return idCurto(o.id);
    if (o._serialized) return idCurto(o._serialized);
    return "";
  }
  const s = String(valor).trim();
  const partes = s.split("_");
  if (partes.length >= 3 && (partes[0] === "true" || partes[0] === "false")) return partes[2];
  return s;
}

// Extrai o id da resposta de envio da WAHA (NOWEB devolve a mensagem do Baileys: { key: { id } }).
export function idDaRespostaEnvio(j: any): string {
  if (!j || typeof j !== "object") return "";
  if (j.key?.id) return String(j.key.id);
  if (j._data?.key?.id) return String(j._data.key.id);
  if (j.id) return idCurto(j.id);
  if (j.message?.key?.id) return String(j.message.key.id);
  return "";
}

// Nome de sessão = crm_conexoes.instancia (mesma regra que a tela já usa: a-z 0-9 _ -).
export function sessaoValida(s: unknown): boolean {
  return typeof s === "string" && /^[a-z0-9_-]{2,40}$/.test(s);
}

export function numeroValido(n: string): boolean {
  return n.length >= 10 && n.length <= 15;
}

// v150: celular brasileiro com e sem o 9 extra (55 DD 9XXXX-XXXX <-> 55 DD XXXX-XXXX).
// O WhatsApp guarda muitos números antigos SEM o 9; o cadastro do CRM costuma ter COM o 9.
export function numeroAlternativoBR(n: string): string | null {
  const d = soDigitos(n);
  if (/^55\d{11}$/.test(d) && d.charAt(4) === "9") return d.slice(0, 4) + d.slice(5);
  if (/^55\d{10}$/.test(d)) return d.slice(0, 4) + "9" + d.slice(4);
  return null;
}

// v150: número (só dígitos) de um chatId da WAHA; null para @lid/grupos (não é número de telefone).
export function numeroDoChatId(chatId: unknown): string | null {
  const s = String(chatId || "");
  if (s.endsWith("@c.us") || s.endsWith("@s.whatsapp.net")) {
    const d = soDigitos(s.split("@")[0]);
    return d.length >= 10 && d.length <= 15 ? d : null;
  }
  return null;
}

// v150: a WAHA recusou o envio porque o número não está no WhatsApp (GOWS: "recipient is not on WhatsApp"/"no LID found").
export function erroNaoEstaNoWhatsApp(r: { status: number; ok: boolean; json: any }): boolean {
  if (r.ok) return false;
  const t = JSON.stringify(r.json || "").toLowerCase();
  return t.includes("not on whatsapp") || t.includes("no lid found") || t.includes("not registered");
}

// Status da sessão WAHA -> status que a tela entende (+ 'qr' quando está esperando escanear).
export function statusParaTela(statusWaha: unknown): string {
  const s = String(statusWaha || "").toUpperCase();
  if (s === "WORKING") return "conectado";
  if (s === "SCAN_QR_CODE") return "qr";
  if (s === "STARTING" || s === "PASSKEY_REQUIRED" || s === "PASSKEY_CONFIRMATION_REQUIRED") return "conectando";
  return "desconectado";
}

// reply_to da WAHA usa o id serializado "<fromMe>_<chatId>_<id>".
export function replyToSerializado(reply: any, chatId: string): string | null {
  if (!reply || typeof reply !== "object") return null;
  const id = String(reply.id || "").trim();
  if (!id || !/^[A-Za-z0-9]+$/.test(id)) return null;
  return (reply.fromMe === true ? "true" : "false") + "_" + chatId + "_" + id;
}

// Mídia só de URL pública do PRÓPRIO Storage do Supabase (anti-SSRF: a WAHA vai buscar essa URL).
export function urlMidiaPermitida(url: unknown, supabaseUrl: string): boolean {
  try {
    const u = new URL(String(url));
    const base = new URL(supabaseUrl);
    return u.protocol === "https:" && u.host === base.host && u.pathname.startsWith("/storage/v1/object/public/");
  } catch {
    return false;
  }
}

export function nomeArquivoSeguro(nome: unknown, padrao: string): string {
  const s = String(nome || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return s || padrao;
}

// Content-Type real do arquivo (ex.: vindo de um HEAD no Storage) — só aceita tipos coerentes com o envio.
export function mimeCoerente(tipo: string, contentType: string | null): string | null {
  const ct = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (!ct || ct === "application/octet-stream") return null;
  if (tipo === "image" && ct.startsWith("image/")) return ct;
  if (tipo === "video" && ct.startsWith("video/")) return ct;
  if (tipo === "audio" && ct.startsWith("audio/")) return ct;
  if (tipo === "document") return ct;
  return null;
}

// Janela do "sincronizar" (recuperar mensagens): segundos Unix; no máximo 3 dias para trás.
export function janelaSincronizar(desde: unknown, ate: unknown, agoraMs = Date.now()): { gte: number; lte: number } | null {
  const d = Date.parse(String(desde || ""));
  if (!isFinite(d)) return null;
  const a = ate ? Date.parse(String(ate)) : agoraMs;
  if (!isFinite(a) || a <= d) return null;
  if (agoraMs - d > 3 * 24 * 3600 * 1000) return null;
  return { gte: Math.floor(d / 1000), lte: Math.floor(a / 1000) };
}

export function mimePadrao(tipo: string): string {
  if (tipo === "image") return "image/jpeg";
  if (tipo === "video") return "video/mp4";
  if (tipo === "audio") return "audio/ogg; codecs=opus";
  return "application/octet-stream";
}

// Monta a chamada de envio de mídia para a WAHA.
export function montarEnvioMidia(sessao: string, chatId: string, tipo: string, url: string, mime: string | null, fileName: string | null, caption: string, replyTo: string | null) {
  const file: Record<string, unknown> = { url, mimetype: mime || mimePadrao(tipo) };
  let caminho: string;
  const body: Record<string, unknown> = { session: sessao, chatId };
  if (tipo === "image") { caminho = "/api/sendImage"; file.filename = nomeArquivoSeguro(fileName, "imagem.jpg"); body.caption = caption; }
  else if (tipo === "video") { caminho = "/api/sendVideo"; file.filename = nomeArquivoSeguro(fileName, "video.mp4"); body.caption = caption; body.convert = false; }
  else if (tipo === "audio") { caminho = "/api/sendVoice"; body.convert = true; } // converte qualquer áudio para OGG/OPUS (nota de voz)
  else { caminho = "/api/sendFile"; file.filename = nomeArquivoSeguro(fileName, "arquivo"); body.caption = caption; }
  body.file = file;
  if (replyTo) body.reply_to = replyTo;
  return { caminho, body };
}

// Configuração da sessão ao criar: webhook com HMAC + Store do NOWEB (necessário p/ resolver @lid).
export function configSessao(nome: string, webhookUrl: string, hmacKey: string) {
  return {
    name: nome,
    start: true,
    config: {
      metadata: { "crm.instancia": nome },
      webhooks: [{
        url: webhookUrl,
        events: ["message.any", "message.ack", "session.status"],
        hmac: { key: hmacKey },
        retries: { policy: "exponential", delaySeconds: 2, attempts: 6 },
      }],
      noweb: { store: { enabled: true, fullSync: false } },
    },
  };
}

// CORS por lista (sem curinga).
export function corsHeaders(origin: string, permitidas: string[]): Record<string, string> {
  const o = origin && permitidas.includes(origin) ? origin : (permitidas[0] || "null");
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export const MENSAGENS_ERRO: Record<string, string> = {
  waha_desativada: "Integração WAHA desativada.",
  nao_autenticado: "Faça login novamente.",
  usuario_nao_autorizado: "Usuário sem permissão.",
  so_admin: "Só administradores podem gerenciar conexões.",
  acao_invalida: "Ação inválida.",
  entrada_invalida: "Requisição inválida.",
  conexao_inexistente: "Conexão não encontrada.",
  conexao_nao_waha: "Esta conexão não é WAHA.",
  numero_invalido: "Número inválido.",
  numero_inexistente: "Este número não tem WhatsApp.",
  texto_vazio: "Mensagem vazia.",
  texto_grande: "Mensagem muito longa.",
  tipo_invalido: "Tipo de mídia inválido.",
  media_url_nao_permitida: "Arquivo de mídia não permitido.",
  coordenadas_invalidas: "Localização inválida.",
  waha_indisponivel: "Servidor WAHA não respondeu.",
  waha_erro: "O servidor WAHA recusou a operação.",
  sem_message_id: "Envio não confirmado pela WAHA.",
  configuracao_incompleta: "Integração WAHA não configurada.",
  erro_interno: "Erro ao processar.",
};
