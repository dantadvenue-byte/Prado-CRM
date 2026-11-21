import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.39.0";

const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT")!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Verifica se um texto é só número (ex: "559391621718")
function ehSoNumero(txt: string | null | undefined): boolean {
  if (!txt) return true;
  return /^[\d\s+\-()]+$/.test(txt.trim());
}

// Busca o melhor nome disponível pra uma conversa
async function buscarNomeConversa(conversaId: any): Promise<string | null> {
  if (!conversaId) return null;
  try {
    const { data: conv } = await supabase
      .from("crm_conversas")
      .select("id, nome_cliente, numero_cliente, contato_id")
      .eq("id", conversaId)
      .maybeSingle();
    if (!conv) return null;
    if (conv.contato_id) {
      const { data: contato } = await supabase
        .from("crm_contatos")
        .select("nome")
        .eq("id", conv.contato_id)
        .maybeSingle();
      if (contato?.nome && !ehSoNumero(contato.nome)) return contato.nome;
    }
    if (conv.nome_cliente && !ehSoNumero(conv.nome_cliente)) return conv.nome_cliente;
    if (conv.numero_cliente) return formatarNumero(conv.numero_cliente);
  } catch (e) {
    console.error("Erro buscando nome:", e);
  }
  return null;
}

// Formata número pra ficar mais legível: 559391621718 -> +55 93 9162-1718
function formatarNumero(num: string): string {
  const n = String(num).replace(/\D/g, "");
  if (n.length >= 12) {
    const ddi = n.slice(0, 2);
    const ddd = n.slice(2, 4);
    const resto = n.slice(4);
    if (resto.length === 9) return `+${ddi} ${ddd} ${resto.slice(0,5)}-${resto.slice(5)}`;
    if (resto.length === 8) return `+${ddi} ${ddd} ${resto.slice(0,4)}-${resto.slice(4)}`;
  }
  return "+" + n;
}

// PRIVACIDADE: conversa com responsável -> só o responsável, admins e gestores comerciais recebem.
// Conversa sem responsável (fila) ou aviso sem conversa -> todos os aparelhos (como antes).
// Aparelho ainda não ligado a um usuário (user_id nulo) só recebe avisos da fila.
async function filtrarDestinatarios(subs: any[], conversaId: any): Promise<any[]> {
  if (!conversaId) return subs;
  const { data: conv, error } = await supabase.from("crm_conversas").select("assigned_user_id").eq("id", conversaId).maybeSingle();
  if (error || !conv || !conv.assigned_user_id) return subs;
  const { data: chefes } = await supabase.from("crm_usuarios").select("id").in("role", ["admin", "gestor_comercial"]);
  const podem = new Set<string>([String(conv.assigned_user_id), ...((chefes || []).map((u: any) => String(u.id)))]);
  return subs.filter((s) => s.user_id && podem.has(String(s.user_id)));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    let { titulo, mensagem, url, conversa_id } = body;

    if (conversa_id && (ehSoNumero(titulo) || !titulo)) {
      const nomeReal = await buscarNomeConversa(conversa_id);
      if (nomeReal) titulo = nomeReal;
    }
    if (!titulo) titulo = "Nova mensagem";

    const { data: todas, error } = await supabase
      .from("crm_push_subscriptions")
      .select("*");

    if (error) throw error;
    const subs = await filtrarDestinatarios(todas || [], conversa_id);
    if (!subs || subs.length === 0) {
      return new Response(JSON.stringify({ enviadas: 0, total: (todas || []).length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = JSON.stringify({
      titulo: titulo,
      mensagem: mensagem || "",
      url: url || "/",
      conversa_id: conversa_id || null,
    });

    let enviadas = 0;
    let removidas = 0;

    for (const s of subs) {
      const subscription = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      };
      try {
        await webpush.sendNotification(subscription, payload);
        enviadas++;
        await supabase
          .from("crm_push_subscriptions")
          .update({ ultimo_uso: new Date().toISOString() })
          .eq("id", s.id);
      } catch (err) {
        const statusCode = (err as any).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await supabase.from("crm_push_subscriptions").delete().eq("id", s.id);
          removidas++;
        }
      }
    }

    return new Response(JSON.stringify({ enviadas, removidas, total: (todas || []).length, destinatarios: subs.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ erro: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
