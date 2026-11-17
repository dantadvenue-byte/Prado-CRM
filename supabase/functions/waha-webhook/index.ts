// ============================================================
// Edge Function: waha-webhook — RECEBIMENTO da WAHA (motor NOWEB) no Prado Chat.
//
// Isolada da Evolution: o whatsapp-webhook atual NÃO é tocado. Esta função só grava
// para conexões com crm_conexoes.provedor = 'waha' cuja instancia = nome da sessão.
//
// Segurança:
//  - Desligada por padrão (WAHA_ENABLED != "true" -> ignora tudo, responde 200).
//  - Exige assinatura HMAC-SHA512 (X-Webhook-Hmac) com o segredo WAHA_WEBHOOK_HMAC_KEY.
//  - Mídia só é baixada da própria WAHA (WAHA_URL + /api/files/...), nunca de URL arbitrária.
//
// Eventos tratados: message.any (mensagens), message.ack (tiques), session.status (conexão).
// Grava no MESMO formato do whatsapp-webhook (crm_conversas / crm_mensagens / crm-midia / enviar_push).
//
// Deploy: verify_jwt = false (a WAHA não manda JWT; a autenticação é o HMAC).
// Secrets: WAHA_ENABLED, WAHA_URL, WAHA_API_KEY, WAHA_WEBHOOK_HMAC_KEY
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import * as L from "./logica.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const WAHA_URL = (Deno.env.get("WAHA_URL") || "").replace(/\/+$/, "");
const WAHA_API_KEY = Deno.env.get("WAHA_API_KEY") || "";
const MAX_MIDIA_BYTES = 40 * 1024 * 1024; // 40 MB
// Mensagens que o PRÓPRIO CRM enviou (source=api) já são gravadas pelo navegador com o mesmo
// message_id. Esperamos um pouco antes de tentar gravar, para não disputar com o navegador.
const ESPERA_SAIDA_API_MS = 4000;

function novoId() {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}
function resp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function wahaGet(caminho: string): Promise<Response> {
  return await fetch(WAHA_URL + caminho, {
    headers: { "X-Api-Key": WAHA_API_KEY, "Accept": "application/json" },
    signal: AbortSignal.timeout(15000),
  });
}

// @lid -> número real, pela API da WAHA (requer Store do NOWEB ligado na sessão).
async function resolverLid(sessao: string, lid: string): Promise<string> {
  try {
    const r = await wahaGet(`/api/${encodeURIComponent(sessao)}/lids/${encodeURIComponent(lid)}`);
    if (!r.ok) return "";
    const j = await r.json().catch(() => ({}));
    const pn = typeof j?.pn === "string" ? j.pn : "";
    return L.tipoJid(pn) === "usuario" ? L.soDigitos(pn.split("@")[0]) : "";
  } catch {
    return "";
  }
}

// Baixa a mídia da WAHA e sobe no bucket crm-midia (os links da WAHA exigem chave e expiram).
async function salvarMidia(mediaUrl: unknown, mime: string | null, ext: string | null, messageId: string): Promise<string | null> {
  const url = L.urlMidiaSegura(mediaUrl, WAHA_URL);
  if (!url || !ext) return null;
  try {
    const r = await fetch(url, { headers: { "X-Api-Key": WAHA_API_KEY }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) { console.error("WAHA-WH midia http", r.status); return null; }
    const tam = Number(r.headers.get("content-length") || "0");
    if (tam > MAX_MIDIA_BYTES) { console.error("WAHA-WH midia grande", tam); return null; }
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > MAX_MIDIA_BYTES) { console.error("WAHA-WH midia grande", bytes.length); return null; }
    const nomeArq = `waha-${Date.now()}-${messageId.slice(-8).replace(/[^A-Za-z0-9]/g, "")}.${ext}`;
    const up = await sb.storage.from("crm-midia").upload(nomeArq, bytes, {
      contentType: mime ?? r.headers.get("content-type") ?? "application/octet-stream",
      upsert: false,
    });
    if (up.error) { console.error("WAHA-WH upload", up.error.message); return null; }
    return sb.storage.from("crm-midia").getPublicUrl(nomeArq).data.publicUrl;
  } catch (e) {
    console.error("WAHA-WH midia erro", String(e));
    return null;
  }
}

// ---------------- session.status ----------------
async function tratarStatusSessao(instancia: string, body: any) {
  const p = body?.payload ?? {};
  const status = L.statusConexao(p.status);
  const upd: Record<string, unknown> = { status };
  const meId = body?.me?.id ?? p?.me?.id ?? null;
  if (status === "conectado" && typeof meId === "string") {
    const tel = L.soDigitos(meId.split("@")[0]);
    if (tel) upd.telefone = tel;
  }
  const { error } = await sb.from("crm_conexoes").update(upd).eq("instancia", instancia).eq("provedor", "waha");
  if (error) { console.error("WAHA-WH status conexao", error.message); return resp(500, { ok: false }); }
  return resp(200, { ok: true, tipo: "session.status", status });
}

// ---------------- message.ack ----------------
async function tratarAck(instancia: string, body: any) {
  const p = body?.payload ?? {};
  const mid = L.idCurto(p.id);
  const novo = L.statusAck(p.ack);
  if (!mid || !novo) return resp(200, { ok: true, ignored: "ack_sem_dados" });
  // Nunca "rebaixa" o tique (ex.: um 'entregue' atrasado depois do 'lido').
  let q = sb.from("crm_mensagens").update({ status: novo }).eq("message_id", mid).eq("instancia", instancia);
  if (novo === "sent") q = q.is("status", null);
  else if (novo === "delivered") q = q.or("status.is.null,status.eq.sent");
  const { error } = await q;
  if (error) { console.error("WAHA-WH ack", error.message); return resp(500, { ok: false }); }
  return resp(200, { ok: true, tipo: "ack", status: novo });
}

// ---------------- message.any ----------------
async function tratarMensagem(instancia: string, body: any) {
  const p = body?.payload ?? {};
  const dados = p?._data ?? {};
  const fromMe = p?.fromMe === true || dados?.key?.fromMe === true;
  const messageId = L.idCurto(dados?.key?.id || p?.id);
  if (!messageId) return resp(200, { ok: true, ignored: "sem_id" });
  if (L.ehMensagemDeSistema(dados)) return resp(200, { ok: true, ignored: "mensagem_de_sistema" });

  // Chat: no NOWEB o _data.key.remoteJid é o chat; senão usa from/to.
  const chat: string = String(dados?.key?.remoteJid || (fromMe ? p?.to : p?.from) || "");
  const tj = L.tipoJid(chat);
  if (tj === "ignorar") return resp(200, { ok: true, ignored: "chat_ignorado" });

  let numero = "";
  if (tj === "usuario") numero = L.soDigitos(chat.split("@")[0]);
  else numero = L.numeroAlternativoDoLid(dados) || await resolverLid(instancia, chat);
  if (!numero) {
    // Sem número real não dá para casar com conversa/contato. Registrado no log para análise.
    console.error("WAHA-WH LID_SEM_NUMERO", JSON.stringify({ instancia, chat, messageId, fromMe }));
    return resp(200, { ok: true, ignored: "lid_sem_numero" });
  }

  // Mensagem enviada pelo próprio CRM: o navegador grava; só completamos se ele não gravou.
  if (fromMe && p?.source === "api") {
    await dormir(ESPERA_SAIDA_API_MS);
    const { data: ja } = await sb.from("crm_mensagens").select("id").eq("message_id", messageId).eq("instancia", instancia).maybeSingle();
    if (ja) return resp(200, { ok: true, ignored: "ja_gravada_pelo_crm" });
  }

  const conteudo = L.extrairConteudo(dados, p);
  const anuncio = L.extrairAnuncio(dados);
  const reply = L.extrairReply(dados);
  const ts = L.quandoISO(p?.timestamp ?? dados?.messageTimestamp);
  const nomeCliente: string | null = fromMe ? null : (dados?.pushName ?? p?._data?.notifyName ?? null);

  // Mídia (só se a WAHA baixou o arquivo).
  let midia_url: string | null = null;
  if (p?.hasMedia && p?.media?.url && conteudo.extensao) {
    midia_url = await salvarMidia(p.media.url, conteudo.midia_mime, conteudo.extensao, messageId);
  }
  if (p?.hasMedia && p?.media?.error) console.error("WAHA-WH media.error", JSON.stringify(p.media.error));

  // Conversa: get-or-create (UNIQUE instancia+numero_cliente garante que não duplica).
  let conversaId: number;
  let naoLidas = 0;
  const sel = await sb.from("crm_conversas").select("id, nao_lidas").eq("instancia", instancia).eq("numero_cliente", numero).maybeSingle();
  if (sel.error) { console.error("WAHA-WH conv select", sel.error.message); return resp(500, { ok: false }); }
  let conversaNova = false;
  if (sel.data) {
    conversaId = sel.data.id; naoLidas = sel.data.nao_lidas ?? 0;
  } else {
    conversaId = novoId();
    const ins = await sb.from("crm_conversas").insert({
      id: conversaId, instancia, numero_cliente: numero, nome_cliente: nomeCliente,
      ultima_mensagem: L.previewDe(conteudo), ultima_hora: ts, nao_lidas: 0,
    });
    if (ins.error) {
      // Outra requisição criou ao mesmo tempo -> relê.
      const again = await sb.from("crm_conversas").select("id, nao_lidas").eq("instancia", instancia).eq("numero_cliente", numero).maybeSingle();
      if (!again.data) { console.error("WAHA-WH conv insert", ins.error.message); return resp(500, { ok: false }); }
      conversaId = again.data.id; naoLidas = again.data.nao_lidas ?? 0;
    } else {
      conversaNova = true;
    }
  }

  // Mensagem: grava SÓ se ainda não existe (UNIQUE message_id+instancia).
  const msg: Record<string, unknown> = {
    id: novoId(), conversa_id: conversaId, instancia, message_id: messageId, de_mim: fromMe,
    tipo: conteudo.tipo, texto: conteudo.texto, midia_url, midia_mime: conteudo.midia_mime,
    timestamp_msg: ts, status: fromMe ? "sent" : null,
  };
  if (anuncio) msg.anuncio = anuncio;
  if (reply) Object.assign(msg, reply);
  const insMsg = await sb.from("crm_mensagens").upsert(msg, { onConflict: "message_id,instancia", ignoreDuplicates: true }).select("id");
  if (insMsg.error) { console.error("WAHA-WH msg insert", insMsg.error.message); return resp(500, { ok: false }); }
  const gravou = Array.isArray(insMsg.data) && insMsg.data.length > 0;
  if (!gravou) return resp(200, { ok: true, deduped: true });

  // Atualiza a conversa (só depois de gravar a mensagem, para duplicata não contar 2x).
  const updConv: Record<string, unknown> = { ultima_mensagem: L.previewDe(conteudo), ultima_hora: ts };
  if (!fromMe) updConv.nao_lidas = naoLidas + 1;
  if (nomeCliente) updConv.nome_cliente = nomeCliente;
  await sb.from("crm_conversas").update(updConv).eq("id", conversaId);

  // Push (só recebidas) — mesmo fluxo do whatsapp-webhook.
  if (!fromMe) {
    try {
      let titulo: string | null = nomeCliente;
      const { data: cv } = await sb.from("crm_conversas").select("nome_cliente, contato_id").eq("id", conversaId).maybeSingle();
      if (cv?.contato_id) {
        const { data: ct } = await sb.from("crm_contatos").select("nome").eq("id", cv.contato_id).maybeSingle();
        if (ct?.nome) titulo = ct.nome;
      }
      if (!titulo && cv?.nome_cliente) titulo = cv.nome_cliente;
      await fetch(`${SUPABASE_URL}/functions/v1/enviar_push`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({ titulo, mensagem: L.corpoPush(conteudo), conversa_id: conversaId, url: "/" }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      console.error("WAHA-WH push", String(e));
    }
  }
  return resp(200, { ok: true, conversaId, nova: conversaNova, fromMe, tipo: conteudo.tipo, midia: !!midia_url });
}

// ---------------- HTTP ----------------
Deno.serve(async (req) => {
  if ((Deno.env.get("WAHA_ENABLED") || "false") !== "true") return resp(200, { ok: true, ignored: "waha_desativada" });
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });

  const chave = Deno.env.get("WAHA_WEBHOOK_HMAC_KEY") || "";
  if (!chave || !WAHA_URL || !WAHA_API_KEY) return resp(500, { ok: false, erro: "configuracao_incompleta" });

  const corpo = await req.text();
  if (!(await L.hmacValido(chave, corpo, req.headers.get("x-webhook-hmac")))) {
    return resp(401, { ok: false, erro: "assinatura_invalida" });
  }

  let body: any;
  try { body = JSON.parse(corpo); } catch { return resp(400, { ok: false, erro: "json_invalido" }); }

  const evento = String(body?.event || "");
  const sessao = String(body?.session || "");
  if (!sessao) return resp(200, { ok: true, ignored: "sem_sessao" });

  try {
    // Só sessões cadastradas como WAHA no CRM.
    const { data: cx, error } = await sb.from("crm_conexoes").select("instancia").eq("instancia", sessao).eq("provedor", "waha").maybeSingle();
    if (error) { console.error("WAHA-WH mapeamento", error.message); return resp(500, { ok: false }); }
    if (!cx) return resp(200, { ok: true, ignored: "sessao_nao_mapeada" });

    if (evento === "session.status") return await tratarStatusSessao(cx.instancia, body);
    if (evento === "message.ack") return await tratarAck(cx.instancia, body);
    if (evento === "message.any") return await tratarMensagem(cx.instancia, body);
    return resp(200, { ok: true, ignored: evento || "sem_evento" });
  } catch (e) {
    console.error("WAHA-WH erro geral", String(e));
    return resp(500, { ok: false });
  }
});
