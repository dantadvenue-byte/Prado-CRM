// Service Worker do Prado Chat
// Estratégia de produção:
//  - Precache FIXO só dos assets estáticos do PWA (casca do app).
//  - HTML: network-first (nunca fica preso numa versão velha do GitHub Pages).
//  - Assets estáticos conhecidos: cache-first (lista fixa, não cresce).
//  - QUALQUER outra coisa (Supabase, Evolution, WhatsApp, mídia, APIs, auth,
//    fontes, CDN, dados dinâmicos): NÃO é interceptada nem cacheada.
//  - Nada de cache.put() genérico. O Cache Storage não cresce indefinidamente.
//
// >>> Só mude SW_VERSION quando MEXER neste arquivo. Ao ativar uma versão nova,
//     os caches antigos são apagados automaticamente.
const SW_VERSION = 'sw-4';
const CACHE_VERSION = 'prado-' + SW_VERSION;

// Únicos arquivos estáticos que o PWA realmente precisa (mesmo domínio).
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  // Pré-cacheia só os estáticos (reserva pra offline). Lista fixa.
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        // Apaga TODOS os caches que não sejam o atual (limpa o inchaço antigo)
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((clientes) => {
        clientes.forEach((c) => { try { c.postMessage({ tipo: 'VERSAO_NOVA', versao: SW_VERSION }); } catch (e) {} });
      })
  );
});

// O index.html manda ATIVAR_AGORA quando detecta um SW novo (auto-update sem espera)
self.addEventListener('message', (event) => {
  if (event.data && event.data.tipo === 'ATIVAR_AGORA') {
    self.skipWaiting();
  }
});

// É o HTML principal (a casca do app)?
function ehPaginaHTML(request, url) {
  if (request.mode === 'navigate') return true;
  if (request.destination === 'document') return true;
  const p = url.pathname;
  if (p === '/' || p.endsWith('/')) return true;
  if (p.endsWith('index.html')) return true;
  return false;
}

// É um asset estático do PWA? Lista EXPLÍCITA — só estes arquivos são cacheados.
function ehAssetEstatico(url) {
  const p = url.pathname;
  return p.endsWith('/manifest.json')
      || p.endsWith('/icon-192.png')
      || p.endsWith('/icon-512.png');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Só GET. POST/PUT/etc. (envios, APIs) passam direto, sem tocar.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // NUNCA intercepta cross-origin: Supabase (banco/storage/auth), Evolution,
  // WhatsApp (mídia), fontes do Google, jsPDF (CDN)... tudo passa direto.
  if (url.origin !== self.location.origin) return;

  // === HTML: NETWORK-FIRST ===
  // Sempre busca a versão nova. Guarda 1 cópia (chave fixa) só pra reserva offline.
  if (ehPaginaHTML(request, url)) {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put('./index.html', clone));
          }
          return resp;
        })
        .catch(() => caches.match('./index.html').then((c) => c || caches.match('./')))
    );
    return;
  }

  // === Assets estáticos do PWA: CACHE-FIRST (lista fixa, não cresce) ===
  if (ehAssetEstatico(url)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request))
    );
    return;
  }

  // === Qualquer outro GET do domínio: NÃO intercepta e NÃO cacheia ===
  // (deixa o navegador cuidar; nada de cache.put genérico)
});

// ============================================================
// PUSH NOTIFICATIONS — preservado exatamente como estava
// ============================================================
self.addEventListener('push', (event) => {
  let data = { titulo: 'Nova mensagem', mensagem: '', url: './' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.mensagem = event.data.text();
    }
  }
  const options = {
    body: data.mensagem || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: data.conversa_id ? ('conv-' + data.conversa_id) : undefined, // agrupa por conversa
    renotify: true, // vibra mesmo se agrupar
    requireInteraction: false,
    data: {
      url: data.url || './',
      conversa_id: data.conversa_id || null
    }
  };
  event.waitUntil(self.registration.showNotification(data.titulo, options));
});

// Ao clicar na notificação, abre o CRM (ou traz pra frente se já estiver aberto)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Se tem uma janela aberta, foca ela
      for (const client of clientList) {
        if (client.url.indexOf(self.registration.scope) === 0) {
          return client.focus();
        }
      }
      // Senão, abre uma nova
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

// Handler pra unsubscribe (quando subscription expira)
self.addEventListener('pushsubscriptionchange', (event) => {
  // Aqui poderíamos renovar automaticamente, mas por simplicidade
  // deixamos o usuário reativar manualmente no CRM
  console.log('Push subscription expirou');
});
