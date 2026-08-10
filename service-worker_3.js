// Service Worker do Prado Chat
// Responsável por: (1) receber push notifications, (2) mostrar notificação,
// (3) abrir CRM ao clicar, (4) SEMPRE baixar o index.html novo (network-first)
//     e usar cache só como reserva quando estiver offline.
//
// >>> Só mude SW_VERSION quando MEXER neste arquivo. No dia a dia, quando você
//     só edita o index.html, NÃO precisa mexer aqui: o network-first já entrega
//     a versão nova do index.html logo na primeira vez que você abre o app.
const SW_VERSION = 'sw-3';
const CACHE_VERSION = 'prado-' + SW_VERSION;
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  // Pré-cacheia os assets essenciais (reserva pra offline)
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(ASSETS).catch(() => {}))
  );
  // Ativa este SW imediatamente, sem esperar as abas antigas fecharem
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => {
        // Avisa as abas abertas que uma versão nova ficou ativa
        return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
          .then((clientes) => {
            clientes.forEach((c) => {
              try { c.postMessage({ tipo: 'VERSAO_NOVA', versao: SW_VERSION }); } catch (e) {}
            });
          });
      })
  );
});

// Se o index.html detectar um SW novo, ele manda ATIVAR_AGORA pra não ter que esperar
self.addEventListener('message', (event) => {
  if (event.data && event.data.tipo === 'ATIVAR_AGORA') {
    self.skipWaiting();
  }
});

// Detecta se o pedido é do HTML principal (a "casca" do app)
function ehPaginaHTML(request, url) {
  if (request.mode === 'navigate') return true;
  if (request.destination === 'document') return true;
  const p = url.pathname;
  if (p === '/' || p.endsWith('/')) return true;
  if (p.endsWith('index.html')) return true;
  return false;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Só mexe em GET do próprio domínio (nunca Supabase/Evolution/APIs externas)
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  // Não intercepta chamadas de API
  if (url.pathname.indexOf('/rest/') >= 0 || url.pathname.indexOf('/functions/') >= 0) return;

  // === HTML (a casca do app): NETWORK-FIRST ===
  // Sempre tenta baixar a versão NOVA. Só usa o cache se estiver sem internet.
  if (ehPaginaHTML(request, url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then((c) => c || caches.match('./index.html')))
    );
    return;
  }

  // === Resto (ícones, manifest, etc.): stale-while-revalidate ===
  // Serve rápido do cache e atualiza no fundo. Esses arquivos quase nunca mudam.
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// Recebe push do servidor (Edge Function do Supabase)
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
