// ============================================================
// Edge Function: waha-proxy — PONTE entre o CRM (navegador) e a WAHA.
//
// Por que existe: a chave da WAHA NUNCA vai para o navegador. O CRM chama esta função com o
// login do usuário (JWT); ela confere quem é, confere a conexão no banco e só então fala com a WAHA.
//
// Isolada da Evolution: só atende conexões com crm_conexoes.provedor = 'waha'.
// Desligada por padrão (WAHA_ENABLED != "true" -> 403 waha_desativada).
//
// Ações de sessão (SÓ admin — a tela Conexões já é só de admin):
//   criar, qr, codigo, status, reiniciar, desconectar, excluir
// Ações de mensagem (atendente, gestor_comercial, admin):
//   enviar_texto, enviar_midia, enviar_localizacao, presenca, foto_perfil
// Envio responde { ok:true, key:{ id } } — o MESMO formato que o CRM já lê da Evolution.
//
// Deploy: verify_jwt = false (o JWT é validado aqui dentro, como no zapi-send; precisa responder ao OPTIONS).
// Secrets: WAHA_ENABLED, WAHA_URL, WAHA_API_KEY, WAHA_WEBHOOK_HMAC_KEY, WAHA_CORS_ORIGIN (opcional)
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import * as L from "./logica.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WAHA_URL = (Deno.env.get("WAHA_URL") || "").replace(/\/+$/, "");
const WAHA_API_KEY = Deno.env.get("WAHA_API_KEY") || "";
const HMAC_KEY = Deno.env.get("WAHA_WEBHOOK_HMAC_KEY") || "";
const ORIGENS = (Deno.env.get("WAHA_CORS_ORIGIN") || "https://dantadvenue-byte.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);

type Cors = Record<string, string>;
function json(obj: unknown, status: number, cors: Cors): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });
}
function erro(codigo: string, status: number, cors: Cors, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: codigo, message: L.MENSAGENS_ERRO[codigo] || L.MENSAGENS_ERRO.erro_interno, ...extra }, status, cors);
}

// Chamada à WAHA com timeout. Lança 'waha_indisponivel' em erro de rede/timeout.
async function waha(metodo: string, caminho: string, body?: unknown, timeoutMs = 25000): Promise<{ status: number; ok: boolean; json: any }> {
  let r: Response;
  try {
    r = await fetch(WAHA_URL + caminho, {
      method: metodo,
      headers: { "X-Api-Key": WAHA_API_KEY, "Content-Type": "application/json", "Accept": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("waha_indisponivel");
  }
  const texto = await r.text();
  let j: any = null;
  try { j = texto ? JSON.parse(texto) : null; } catch { j = { raw: texto.slice(0, 300) }; }
  return { status: r.status, ok: r.ok, json: j };
}

function sess(s: string) { return encodeURIComponent(s); }

// ---------------- Sessão ----------------
async function lerStatus(sessao: string) {
  const r = await waha("GET", `/api/sessions/${sess(sessao)}`, undefined, 15000);
  if (r.status === 404) return { existe: false, status: "desconectado", waha_status: null, telefone: null };
  if (!r.ok) throw new Error("waha_erro");
  const me = r.json?.me?.id ? L.soDigitos(String(r.json.me.id).split("@")[0]) : null;
  return { existe: true, status: L.statusParaTela(r.json?.status), waha_status: r.json?.status ?? null, telefone: me };
}

async function acaoSessao(acao: string, sessao: string, body: any, cors: Cors): Promise<Response> {
  if (acao === "criar") {
    const cfg = L.configSessao(sessao, `${SUPABASE_URL}/functions/v1/waha-webhook`, HMAC_KEY);
    const r = await waha("POST", "/api/sessions", cfg);
    if (!r.ok) {
      // Já existe? Então só garante que está rodando.
      const st = await lerStatus(sessao);
      if (!st.existe) { console.error("WAHA-PX criar", r.status, JSON.stringify(r.json).slice(0, 300)); return erro("waha_erro", 502, cors); }
      await waha("POST", `/api/sessions/${sess(sessao)}/start`);
    }
    return json({ ok: true, ...(await lerStatus(sessao)) }, 200, cors);
  }

  if (acao === "status") return json({ ok: true, ...(await lerStatus(sessao)) }, 200, cors);

  if (acao === "qr") {
    const st = await lerStatus(sessao);
    if (!st.existe) return erro("conexao_inexistente", 404, cors);
    if (st.status === "conectado") return json({ ok: true, ...st }, 200, cors);
    if (st.waha_status === "STOPPED" || st.waha_status === "FAILED") {
      // QR expirou (6 tentativas) ou sessão parada: reinicia e pede para a tela tentar de novo.
      await waha("POST", `/api/sessions/${sess(sessao)}/restart`);
      return json({ ok: true, ...st, status: "conectando", tentar_novamente: true }, 200, cors);
    }
    if (st.status !== "qr") return json({ ok: true, ...st, tentar_novamente: true }, 200, cors);
    const r = await waha("GET", `/api/${sess(sessao)}/auth/qr?format=image`, undefined, 15000);
    if (!r.ok || !r.json?.data) return json({ ok: true, ...st, tentar_novamente: true }, 200, cors);
    const mime = r.json.mimetype || "image/png";
    return json({ ok: true, ...st, base64: `data:${mime};base64,${r.json.data}` }, 200, cors);
  }

  if (acao === "codigo") {
    const tel = L.soDigitos(body?.telefone);
    if (!L.numeroValido(tel)) return erro("numero_invalido", 400, cors);
    const r = await waha("POST", `/api/${sess(sessao)}/auth/request-code`, { phoneNumber: tel });
    if (!r.ok || !r.json?.code) { console.error("WAHA-PX codigo", r.status); return erro("waha_erro", 502, cors); }
    return json({ ok: true, codigo: String(r.json.code) }, 200, cors);
  }

  const rotas: Record<string, [string, string]> = {
    reiniciar: ["POST", `/api/sessions/${sess(sessao)}/restart`],
    desconectar: ["POST", `/api/sessions/${sess(sessao)}/logout`],
    excluir: ["DELETE", `/api/sessions/${sess(sessao)}`],
  };
  const rota = rotas[acao];
  if (!rota) return erro("acao_invalida", 400, cors);
  const r = await waha(rota[0], rota[1]);
  if (!r.ok && !(acao === "excluir" && r.status === 404)) {
    console.error("WAHA-PX", acao, r.status, JSON.stringify(r.json).slice(0, 300));
    return erro("waha_erro", 502, cors);
  }
  if (acao === "excluir") return json({ ok: true, status: "desconectado" }, 200, cors);
  return json({ ok: true, ...(await lerStatus(sessao)) }, 200, cors);
}

// ---------------- Mensagens ----------------
// chatId do cliente. Conversa já existente -> o número veio do próprio WhatsApp, usa direto.
// Número novo (1º contato) -> pergunta à WAHA o chatId correto (9º dígito no Brasil, @lid).
async function resolverChatId(admin: any, sessao: string, numero: string): Promise<string> {
  const { data: conv } = await admin.from("crm_conversas").select("id").eq("instancia", sessao).eq("numero_cliente", numero).maybeSingle();
  if (conv) return `${numero}@c.us`;
  const r = await waha("GET", `/api/contacts/check-exists?phone=${numero}&session=${sess(sessao)}`, undefined, 15000);
  if (!r.ok) throw new Error("waha_erro");
  if (r.json?.numberExists !== true) throw new Error("numero_inexistente");
  const pn = typeof r.json?.pn === "string" && r.json.pn.endsWith("@c.us") ? r.json.pn : null;
  return pn || String(r.json?.chatId || `${numero}@c.us`);
}

function respostaEnvio(r: { status: number; ok: boolean; json: any }, cors: Cors): Response {
  if (!r.ok) {
    console.error("WAHA-PX envio", r.status, JSON.stringify(r.json).slice(0, 300));
    return erro("waha_erro", 502, cors);
  }
  const id = L.idDaRespostaEnvio(r.json);
  // A WAHA aceitou (2xx). Mesmo sem id, NÃO dizemos que falhou (evita reenvio duplicado pelo usuário).
  if (!id) console.error("WAHA-PX envio sem id", JSON.stringify(r.json).slice(0, 300));
  return json({ ok: true, key: { id: id || null } }, 200, cors);
}

async function acaoMensagem(acao: string, sessao: string, body: any, admin: any, cors: Cors): Promise<Response> {
  const numero = L.soDigitos(body?.numero);
  if (!L.numeroValido(numero)) return erro("numero_invalido", 400, cors);

  if (acao === "foto_perfil") {
    const r = await waha("GET", `/api/contacts/profile-picture?contactId=${numero}&session=${sess(sessao)}`, undefined, 15000);
    const url = r.ok ? (r.json?.profilePictureURL || null) : null;
    return json({ ok: true, profilePictureUrl: url }, 200, cors);
  }

  if (acao === "presenca") {
    const p = String(body?.presenca || "");
    if (!["typing", "recording", "paused"].includes(p)) return erro("entrada_invalida", 400, cors);
    await waha("POST", `/api/${sess(sessao)}/presence`, { chatId: `${numero}@c.us`, presence: p }, 10000);
    return json({ ok: true }, 200, cors);
  }

  const chatId = await resolverChatId(admin, sessao, numero);
  const replyTo = L.replyToSerializado(body?.reply, chatId);

  if (acao === "enviar_texto") {
    const texto = String(body?.texto ?? "");
    if (!texto.trim()) return erro("texto_vazio", 400, cors);
    if (texto.length > L.MAX_TEXTO) return erro("texto_grande", 400, cors);
    const b: Record<string, unknown> = { session: sessao, chatId, text: texto };
    if (replyTo) b.reply_to = replyTo;
    return respostaEnvio(await waha("POST", "/api/sendText", b), cors);
  }

  if (acao === "enviar_midia") {
    const tipo = String(body?.tipo || "");
    if (!L.TIPOS_MIDIA.includes(tipo)) return erro("tipo_invalido", 400, cors);
    if (!L.urlMidiaPermitida(body?.mediaUrl, SUPABASE_URL)) return erro("media_url_nao_permitida", 400, cors);
    const caption = String(body?.caption ?? "").slice(0, L.MAX_TEXTO);
    const m = L.montarEnvioMidia(sessao, chatId, tipo, String(body.mediaUrl), body?.mime ? String(body.mime) : null, body?.fileName ?? null, caption, replyTo);
    return respostaEnvio(await waha("POST", m.caminho, m.body, 60000), cors);
  }

  if (acao === "enviar_localizacao") {
    const lat = Number(body?.latitude), lng = Number(body?.longitude);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return erro("coordenadas_invalidas", 400, cors);
    const b: Record<string, unknown> = { session: sessao, chatId, latitude: lat, longitude: lng, title: String(body?.title || body?.address || "").slice(0, 200) };
    if (replyTo) b.reply_to = replyTo;
    return respostaEnvio(await waha("POST", "/api/sendLocation", b), cors);
  }

  return erro("acao_invalida", 400, cors);
}

// ---------------- HTTP ----------------
Deno.serve(async (req) => {
  const cors = L.corsHeaders(req.headers.get("Origin") || "", ORIGENS);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return erro("entrada_invalida", 405, cors);
  if ((Deno.env.get("WAHA_ENABLED") || "false") !== "true") return erro("waha_desativada", 403, cors);
  if (!WAHA_URL || !WAHA_API_KEY || !HMAC_KEY) return erro("configuracao_incompleta", 500, cors);

  try {
    // 1) Quem está chamando (JWT do usuário logado no CRM).
    const auth = req.headers.get("Authorization") || "";
    const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (!jwt) return erro("nao_autenticado", 401, cors);
    const authClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const { data: ud, error: ue } = await authClient.auth.getUser(jwt);
    if (ue || !ud?.user) return erro("nao_autenticado", 401, cors);

    let body: any;
    try { body = await req.json(); } catch { return erro("entrada_invalida", 400, cors); }
    const acao = String(body?.acao || "");
    const sessao = String(body?.instancia || "");
    const ehSessao = (L.ACOES_SESSAO as readonly string[]).includes(acao);
    const ehMensagem = (L.ACOES_MENSAGEM as readonly string[]).includes(acao);
    if (!ehSessao && !ehMensagem) return erro("acao_invalida", 400, cors);
    if (!L.sessaoValida(sessao)) return erro("entrada_invalida", 400, cors);

    // 2) Papel no CRM e conexão — SEMPRE conferidos no banco (nunca confia no navegador).
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const [u, c] = await Promise.all([
      admin.from("crm_usuarios").select("role").eq("id", ud.user.id).maybeSingle(),
      admin.from("crm_conexoes").select("instancia, provedor").eq("instancia", sessao).maybeSingle(),
    ]);
    if (u.error || c.error) return erro("erro_interno", 503, cors);
    const papel = String(u.data?.role || "");
    if (!L.PAPEIS_OK.includes(papel)) return erro("usuario_nao_autorizado", 403, cors);
    if (ehSessao && papel !== "admin") return erro("so_admin", 403, cors);
    if (!c.data) return erro("conexao_inexistente", 404, cors);
    if (String(c.data.provedor) !== "waha") return erro("conexao_nao_waha", 409, cors);

    // 3) Executa.
    if (ehSessao) return await acaoSessao(acao, sessao, body, cors);
    return await acaoMensagem(acao, sessao, body, admin, cors);
  } catch (e) {
    const codigo = String((e as Error)?.message || "");
    if (codigo === "waha_indisponivel") return erro(codigo, 504, cors);
    if (codigo === "waha_erro") return erro(codigo, 502, cors);
    if (codigo === "numero_inexistente") return erro(codigo, 404, cors);
    console.error("WAHA-PX erro geral", codigo);
    return erro("erro_interno", 500, cors);
  }
});
