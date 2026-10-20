// Supabase Edge Function: criar_usuario
// Cria um usuário no Supabase Auth e o registro em public.crm_usuarios.
// Segurança: valida a SESSÃO do solicitante e exige que ele seja 'admin' em crm_usuarios.
// A chave service_role NUNCA vai ao navegador — fica apenas aqui, via variável de ambiente.
//
// Deploy:
//   supabase functions deploy criar_usuario --no-verify-jwt
//   (o --no-verify-jwt é porque validamos o JWT manualmente abaixo, lendo o header Authorization)
// Variáveis de ambiente necessárias (Supabase > Edge Functions > Secrets):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   (as duas primeiras já existem por padrão no runtime; a service_role você adiciona como secret)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// CORS: por padrão "*" (não quebra o fluxo atual). Para restringir, defina o secret
// ALLOWED_ORIGINS com uma lista separada por vírgula (ex.: "https://seu-dominio.com,https://www.seu-dominio.com").
// Quando definido, só essas origens recebem o cabeçalho; as demais não passam no preflight do navegador.
// Observação: CORS é defesa adicional (vale só no navegador). A proteção REAL é JWT + checagem de admin.
const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") || "").split(",").map((s) => s.trim()).filter(Boolean);

// Origem permitida? Regras:
//  - ALLOWED vazio  => sem restrição de CORS (padrão "*").
//  - ALLOWED definido + requisição COM Origin => precisa estar na lista, senão REJEITA (403).
//  - ALLOWED definido + requisição SEM Origin (ex.: server-to-server, não-navegador) => CORS não
//    se aplica; NÃO bloqueia aqui — a autorização real (JWT + admin) é quem decide.
// CORS é defesa de navegador; nunca substitui autenticação/autorização.
function originPermitida(req: Request): boolean {
  if (ALLOWED.length === 0) return true;
  const origin = req.headers.get("Origin");
  if (!origin) return true;
  return ALLOWED.includes(origin);
}
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (ALLOWED.length === 0) {
    h["Access-Control-Allow-Origin"] = "*";
  } else if (origin && ALLOWED.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;  // ecoa só origem autorizada
    h["Vary"] = "Origin";
  }
  // origem não autorizada => sem cabeçalho ACAO => o navegador bloqueia (e também rejeitamos abaixo)
  return h;
}

function json(body: unknown, status = 200, req?: Request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...(req ? corsHeaders(req) : {}), "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  // Rejeição explícita de origem não autorizada (quando ALLOWED_ORIGINS está definido).
  if (!originPermitida(req)) {
    return new Response(JSON.stringify({ error: "Origem não autorizada" }), {
      status: 403, headers: { "Content-Type": "application/json" },
    });
  }
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405, req);

  const URL = Deno.env.get("SUPABASE_URL")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!URL || !ANON || !SERVICE) return json({ error: "Função mal configurada (variáveis ausentes)" }, 500, req);

  // 1) Identifica o solicitante pelo JWT do header Authorization
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Sessão ausente" }, 401, req);

  const asUser = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data: userData, error: userErr } = await asUser.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Sessão inválida" }, 401, req);
  const solicitanteId = userData.user.id;

  // 2) Confirma no servidor que o solicitante é admin (fonte da verdade = crm_usuarios)
  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
  const { data: perfil, error: perfilErr } = await admin
    .from("crm_usuarios").select("role").eq("id", solicitanteId).single();
  if (perfilErr || !perfil || perfil.role !== "admin") {
    return json({ error: "Apenas administradores podem cadastrar usuários" }, 403, req);
  }

  // 3) Valida a entrada
  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "Corpo inválido" }, 400, req); }
  const nome = (payload?.nome || "").toString().trim();
  const email = (payload?.email || "").toString().trim().toLowerCase();
  const senha = (payload?.senha || "").toString();
  let role = (payload?.role || "atendente").toString();
  if (role !== "admin" && role !== "atendente") role = "atendente";
  if (!nome || !email || !senha) return json({ error: "Informe nome, e-mail e senha" }, 400, req);
  if (senha.length < 6) return json({ error: "A senha precisa de ao menos 6 caracteres" }, 400, req);

  // 4) Cria no Auth (email já confirmado) — NÃO afeta a sessão do admin
  const { data: novo, error: createErr } = await admin.auth.admin.createUser({
    email, password: senha, email_confirm: true, user_metadata: { name: nome },
  });
  if (createErr || !novo?.user) {
    const msg = (createErr?.message || "").includes("already") ? "E-mail já cadastrado" : (createErr?.message || "Falha ao criar conta");
    return json({ error: msg }, 400, req);
  }

  // 5) Cria o registro em crm_usuarios (service_role ignora RLS com segurança, pois já validamos o admin).
  //    O trigger crm_usuarios_guard() reconhece este contexto como CONFIÁVEL pelo papel do JWT
  //    (request.jwt.claims.role = 'service_role') e grava o papel enviado ('admin'/'atendente')
  //    sem a trava de "papel mínimo" aplicada ao auto-cadastro do navegador (anon/authenticated).
  const { error: insErr } = await admin.from("crm_usuarios").insert({
    id: novo.user.id, nome, email, role, criado_em: new Date().toISOString(),
  });
  if (insErr) {
    // rollback: remove o usuário do Auth para não deixar conta órfã
    await admin.auth.admin.deleteUser(novo.user.id);
    return json({ error: "Falha ao gravar perfil: " + insErr.message }, 400, req);
  }

  return json({ ok: true, id: novo.user.id, email, nome, role }, 200, req);
});
