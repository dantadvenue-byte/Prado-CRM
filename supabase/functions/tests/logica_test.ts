import { deepStrictEqual as assertEquals, ok as assert } from "node:assert";
import * as W from "../waha-webhook/logica.ts";
import * as P from "../waha-proxy/logica.ts";

Deno.test("idCurto: serializado da WAHA -> id curto (igual key.id da Evolution)", () => {
  assertEquals(W.idCurto("true_5591999999999@c.us_3EB0ABCDEF"), "3EB0ABCDEF");
  assertEquals(W.idCurto("false_5591999999999@c.us_ABC123_5591888888888@c.us"), "ABC123");
  assertEquals(W.idCurto("3EB0ABCDEF"), "3EB0ABCDEF");
  assertEquals(W.idCurto({ id: "true_x@c.us_ZZZ" }), "ZZZ");
  assertEquals(W.idCurto(null), "");
  assertEquals(P.idCurto("true_5591@c.us_Q1"), "Q1");
});

Deno.test("idDaRespostaEnvio: formatos possíveis da resposta de envio", () => {
  assertEquals(P.idDaRespostaEnvio({ key: { id: "K1", fromMe: true } }), "K1");
  assertEquals(P.idDaRespostaEnvio({ id: "true_55@c.us_K2" }), "K2");
  assertEquals(P.idDaRespostaEnvio({ _data: { key: { id: "K3" } } }), "K3");
  assertEquals(P.idDaRespostaEnvio({}), "");
});

Deno.test("tipoJid: ignora grupos, status, canais", () => {
  assertEquals(W.tipoJid("5591999999999@c.us"), "usuario");
  assertEquals(W.tipoJid("5591999999999@s.whatsapp.net"), "usuario");
  assertEquals(W.tipoJid("123456@lid"), "lid");
  assertEquals(W.tipoJid("1203630@g.us"), "ignorar");
  assertEquals(W.tipoJid("status@broadcast"), "ignorar");
  assertEquals(W.tipoJid("123@newsletter"), "ignorar");
  assertEquals(W.tipoJid(""), "ignorar");
});

Deno.test("numeroAlternativoDoLid: pega o número dos campos Alt/Pn", () => {
  assertEquals(W.numeroAlternativoDoLid({ key: { remoteJid: "1@lid", remoteJidAlt: "5591999999999@s.whatsapp.net" } }), "5591999999999");
  assertEquals(W.numeroAlternativoDoLid({ key: { remoteJid: "1@lid", senderPn: "5591988887777@s.whatsapp.net" } }), "5591988887777");
  assertEquals(W.numeroAlternativoDoLid({ key: { remoteJid: "1@lid" } }), "");
});

Deno.test("extrairConteudo: tipos do Baileys (NOWEB _data)", () => {
  assertEquals(W.extrairConteudo({ message: { conversation: "oi" } }, {}).texto, "oi");
  assertEquals(W.extrairConteudo({ message: { extendedTextMessage: { text: "olá" } } }, {}).tipo, "text");
  const img = W.extrairConteudo({ message: { imageMessage: { caption: "foto", mimetype: "image/jpeg" } } }, {});
  assertEquals([img.tipo, img.texto, img.extensao], ["image", "foto", "jpg"]);
  const aud = W.extrairConteudo({ message: { audioMessage: { mimetype: "audio/ogg; codecs=opus" } } }, {});
  assertEquals([aud.tipo, aud.extensao], ["audio", "ogg"]);
  const doc = W.extrairConteudo({ message: { documentMessage: { fileName: "Orçamento.PDF", mimetype: "application/pdf" } } }, {});
  assertEquals([doc.tipo, doc.texto, doc.extensao], ["document", "Orçamento.PDF", "pdf"]);
  const loc = W.extrairConteudo({ message: { locationMessage: { degreesLatitude: -2.4, degreesLongitude: -54.7 } } }, {});
  assertEquals([loc.tipo, loc.texto], ["location", "-2.4,-54.7"]);
  // embrulhada (efêmera)
  assertEquals(W.extrairConteudo({ message: { ephemeralMessage: { message: { conversation: "sumir" } } } }, {}).texto, "sumir");
  // fallback pelos campos da WAHA
  assertEquals(W.extrairConteudo({}, { body: "texto puro" }).texto, "texto puro");
  assertEquals(W.extrairConteudo({}, { hasMedia: true, media: { mimetype: "image/png" } }).tipo, "image");
  assertEquals(W.extrairConteudo({}, {}).tipo, "other");
});

Deno.test("ehMensagemDeSistema: reação/edição/chaves não viram mensagem", () => {
  assert(W.ehMensagemDeSistema({ message: { reactionMessage: { text: "👍" } } }));
  assert(W.ehMensagemDeSistema({ message: { protocolMessage: { type: 0 }, messageContextInfo: {} } }));
  assert(!W.ehMensagemDeSistema({ message: { senderKeyDistributionMessage: {} } })); // vazia/ilegível: NÃO descarta
  assert(!W.ehMensagemDeSistema({ message: { conversation: "oi", messageContextInfo: {} } }));
  assert(!W.ehMensagemDeSistema({ message: { contactMessage: {} } }));
  assert(!W.ehMensagemDeSistema({}));
});

Deno.test("extrairReply / extrairAnuncio", () => {
  const r = W.extrairReply({ message: { extendedTextMessage: { text: "sim", contextInfo: { stanzaId: "ORIG1", quotedMessage: { conversation: "quer?" } } } } });
  assertEquals(r, { reply_to_message_id: "ORIG1", reply_to_text: "quer?", reply_to_type: "text" });
  assertEquals(W.extrairReply({ message: { conversation: "x" } }), null);
  const a = W.extrairAnuncio({ message: { extendedTextMessage: { contextInfo: { externalAdReply: { title: "Promo", sourceUrl: "https://fb.me/x" } } } } });
  assertEquals(a?.titulo, "Promo");
});

Deno.test("status: sessão e ack", () => {
  assertEquals(W.statusConexao("WORKING"), "conectado");
  assertEquals(W.statusConexao("SCAN_QR_CODE"), "conectando");
  assertEquals(W.statusConexao("FAILED"), "desconectado");
  assertEquals(W.statusAck(1), "sent");
  assertEquals(W.statusAck(2), "delivered");
  assertEquals(W.statusAck(3), "read");
  assertEquals(W.statusAck(4), "read");
  assertEquals(W.statusAck(0), null);
  assertEquals(W.statusAck(-1), null);
  assertEquals(P.statusParaTela("SCAN_QR_CODE"), "qr");
});

Deno.test("quandoISO: segundos e milissegundos", () => {
  assertEquals(W.quandoISO(1763340000), new Date(1763340000 * 1000).toISOString());
  assertEquals(W.quandoISO(1763340000123), new Date(1763340000123).toISOString());
  const agora = new Date("2026-11-16T00:00:00Z");
  assertEquals(W.quandoISO(null, agora), agora.toISOString());
});

Deno.test("urlMidiaSegura: só /api/files/ da própria WAHA (anti-SSRF)", () => {
  const base = "http://2.25.87.147:32768";
  assertEquals(W.urlMidiaSegura("http://localhost:3000/api/files/default/ABC.jpeg", base), base + "/api/files/default/ABC.jpeg");
  assertEquals(W.urlMidiaSegura("http://evil.com/api/files/x.jpg", base), base + "/api/files/x.jpg"); // host ignorado
  assertEquals(W.urlMidiaSegura("http://evil.com/api/sessions", base), null);
  assertEquals(W.urlMidiaSegura("http://x/api/files/../sessions", base), null);
  assertEquals(W.urlMidiaSegura("nao-e-url", base), null);
});

Deno.test("urlMidiaPermitida: só Storage público do próprio Supabase", () => {
  const sbu = "https://szwicrigzibryakmjqkk.supabase.co";
  assert(P.urlMidiaPermitida(sbu + "/storage/v1/object/public/crm-midia/a.jpg", sbu));
  assert(!P.urlMidiaPermitida("http://szwicrigzibryakmjqkk.supabase.co/storage/v1/object/public/crm-midia/a.jpg", sbu));
  assert(!P.urlMidiaPermitida("https://evil.com/storage/v1/object/public/a.jpg", sbu));
  assert(!P.urlMidiaPermitida(sbu + "/rest/v1/crm_usuarios", sbu));
});

Deno.test("HMAC sha512: confere com implementação de referência e rejeita adulteração", async () => {
  // Referência calculada com openssl: printf '{"a":1}' | openssl dgst -sha512 -hmac segredo
  const ref = Deno.env.get("HMAC_REF") || "";
  const h = await W.hmacSha512Hex("segredo", '{"a":1}');
  if (ref) assertEquals(h, ref);
  assert(await W.hmacValido("segredo", '{"a":1}', h));
  assert(await W.hmacValido("segredo", '{"a":1}', h.toUpperCase()));
  assert(!(await W.hmacValido("segredo", '{"a":2}', h)));
  assert(!(await W.hmacValido("outro", '{"a":1}', h)));
  assert(!(await W.hmacValido("segredo", '{"a":1}', null)));
  assert(!(await W.hmacValido("", '{"a":1}', h)));
});

Deno.test("replyToSerializado e montarEnvioMidia", () => {
  assertEquals(P.replyToSerializado({ id: "ABC", fromMe: false }, "5591@c.us"), "false_5591@c.us_ABC");
  assertEquals(P.replyToSerializado({ id: "ABC", fromMe: true }, "5591@c.us"), "true_5591@c.us_ABC");
  assertEquals(P.replyToSerializado({ id: "a b" }, "5591@c.us"), null);
  assertEquals(P.replyToSerializado(null, "5591@c.us"), null);
  const v = P.montarEnvioMidia("teste", "5591@c.us", "audio", "https://x/a.webm", null, null, "", null);
  assertEquals(v.caminho, "/api/sendVoice");
  assertEquals((v.body as any).convert, true);
  const d = P.montarEnvioMidia("teste", "5591@c.us", "document", "https://x/a.pdf", "application/pdf", "Orçamento final.pdf", "seg", "false_5591@c.us_X");
  assertEquals(d.caminho, "/api/sendFile");
  assertEquals((d.body as any).file.filename, "Orcamento_final.pdf");
  assertEquals((d.body as any).reply_to, "false_5591@c.us_X");
});

Deno.test("sessaoValida e configSessao", () => {
  assert(P.sessaoValida("waha_teste"));
  assert(!P.sessaoValida("Waha Teste"));
  assert(!P.sessaoValida("../x"));
  const c = P.configSessao("waha_teste", "https://x/functions/v1/waha-webhook", "k");
  assertEquals(c.config.webhooks[0].events, ["message.any", "message.ack", "session.status"]);
  assertEquals(c.config.noweb.store.enabled, true);
});

Deno.test("mimeCoerente e janelaSincronizar", () => {
  assertEquals(P.mimeCoerente("image", "image/png"), "image/png");
  assertEquals(P.mimeCoerente("image", "application/octet-stream"), null);
  assertEquals(P.mimeCoerente("image", "video/mp4"), null);
  assertEquals(P.mimeCoerente("document", "application/pdf"), "application/pdf");
  const agora = Date.parse("2026-11-17T18:00:00Z");
  assertEquals(P.janelaSincronizar("2026-11-17T14:50:00Z", null, agora), { gte: Date.parse("2026-11-17T14:50:00Z")/1000, lte: agora/1000 });
  assertEquals(P.janelaSincronizar("2026-11-10T00:00:00Z", null, agora), null); // mais de 3 dias
  assertEquals(P.janelaSincronizar("lixo", null, agora), null);
});

Deno.test("v146 GOWS: reply pela mensagem crua (_data.Message) e pelo replyTo normalizado", () => {
  // GOWS: _data.Message com stanzaID (caixa diferente) e citação de imagem
  const g = W.extrairReply({ Info: { PushName: "Ana" }, Message: { extendedTextMessage: { text: "Dessa", contextInfo: { stanzaID: "3EB0AA", quotedMessage: { imageMessage: { caption: "Scooter A16" } } } } } });
  assertEquals(g, { reply_to_message_id: "3EB0AA", reply_to_text: "Scooter A16", reply_to_type: "image" });
  // replyTo string serializada
  const s = W.extrairReply({}, { replyTo: "false_5591@c.us_ABC9" });
  assertEquals(s, { reply_to_message_id: "ABC9", reply_to_text: "", reply_to_type: "text", incompleto: true });
  // replyTo objeto com body
  const o = W.extrairReply({}, { replyTo: { id: "true_5591@c.us_XY1", body: "qual modelo?" } });
  assertEquals(o, { reply_to_message_id: "XY1", reply_to_text: "qual modelo?", reply_to_type: "text", incompleto: true });
  // replyTo objeto com _data da citada
  const d = W.extrairReply({}, { replyTo: { id: "XY2", _data: { imageMessage: { caption: "foto" } } } });
  assertEquals(d, { reply_to_message_id: "XY2", reply_to_text: "foto", reply_to_type: "image" });
  // stanza sem quotedMessage: completa pelo banco
  assertEquals(W.extrairReply({ message: { extendedTextMessage: { text: "x", contextInfo: { stanzaId: "Q1" } } } })?.incompleto, true);
  // sem resposta
  assertEquals(W.extrairReply({ Message: { conversation: "oi" } }, { body: "oi" }), null);
});

Deno.test("v146 GOWS: reação, sistema e conteúdo pela _data.Message", () => {
  assertEquals(W.extrairReacao({ Message: { reactionMessage: { text: "❤️", key: { ID: "M1" } } } }, {}), { alvo: "M1", emoji: "❤️" });
  assertEquals(W.extrairReacao({ message: { reactionMessage: { text: "", key: { id: "M2" } } } }, {}), { alvo: "M2", emoji: "" });
  assertEquals(W.extrairReacao({}, { reaction: { text: "👍", messageId: "true_55@c.us_M3" } }), { alvo: "M3", emoji: "👍" });
  assertEquals(W.extrairReacao({ Message: { conversation: "oi" } }, {}), null);
  assert(W.ehMensagemDeSistema({ Message: { protocolMessage: { type: 0 } } }));
  assert(!W.ehMensagemDeSistema({ Message: { conversation: "oi" } }));
  // conteúdo: payload sem body/mídia mas com _data.Message reconhecível
  assertEquals(W.extrairConteudo({ Message: { locationMessage: { degreesLatitude: 1, degreesLongitude: 2 } } }, {}).tipo, "location");
  // NOWEB continua igual
  assertEquals(W.extrairConteudo({ message: { conversation: "oi" } }, {}).texto, "oi");
});

Deno.test("v150 proxy: número com/sem 9, chatId e erro 'não está no WhatsApp'", () => {
  assertEquals(P.numeroAlternativoBR("5588981888841"), "558881888841");
  assertEquals(P.numeroAlternativoBR("558881888841"), "5588981888841");
  assertEquals(P.numeroAlternativoBR("5511987654321"), "551187654321");
  assertEquals(P.numeroAlternativoBR("14155550123"), null); // não é Brasil
  assertEquals(P.numeroDoChatId("558881888841@c.us"), "558881888841");
  assertEquals(P.numeroDoChatId("558881888841@s.whatsapp.net"), "558881888841");
  assertEquals(P.numeroDoChatId("123456@lid"), null);
  assert(P.erroNaoEstaNoWhatsApp({ status: 500, ok: false, json: { exception: { message: "2 UNKNOWN: recipient is not on WhatsApp: no LID found for 5588981888841@s.whatsapp.net from server" } } }));
  assert(!P.erroNaoEstaNoWhatsApp({ status: 500, ok: false, json: { exception: { message: "timeout" } } }));
  assert(!P.erroNaoEstaNoWhatsApp({ status: 200, ok: true, json: {} }));
  assert((P.ACOES_MENSAGEM as readonly string[]).includes("verificar_numero"));
});
