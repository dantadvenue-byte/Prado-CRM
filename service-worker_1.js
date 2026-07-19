// Service Worker do Prado Chat
// Responsável por: (1) receber push notifications, (2) mostrar notificação, (3) abrir CRM ao clicar

const CACHE_VERSION = 'prado-v1';

self.addEventListener('install', (event) => {
  // Ativa imediatamente sem esperar refresh
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Toma controle das abas existentes
  event.waitUntil(self.clients.claim());
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
