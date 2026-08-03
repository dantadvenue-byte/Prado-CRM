// Service Worker do Prado Chat
// Responsável por: (1) receber push notifications, (2) mostrar notificação,
// (3) abrir CRM ao clicar, (4) cache-first pra abrir rápido

const CACHE_VERSION = 'prado-v2';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  // Pré-cacheia os assets essenciais
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Limpa caches antigos + toma controle
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// Cache-first pro HTML/assets (abre rápido), network-first pro resto
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Só cacheia GET do próprio domínio (não Supabase/Evolution)
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  // Não cacheia chamadas de API
  if (url.pathname.indexOf('/rest/') >= 0 || url.pathname.indexOf('/functions/') >= 0) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      // Serve do cache imediatamente, atualiza em background (stale-while-revalidate)
      const fetchPromise = fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
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
