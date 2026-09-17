// O "carteiro" do app de Alertas.
//
// Roda por trás, mesmo com o app fechado: é ele que recebe a notificação do servidor e
// mostra no celular. Sem este arquivo o iPhone não tem onde entregar o aviso.
//
// De propósito NÃO guarda a página em cache pra funcionar offline. Um painel de "o
// sistema está bem?" que abre sem internet mostrando o estado de ontem é pior do que
// um que não abre: daria um "tudo rodando" falso justo quando não dá pra conferir.

self.addEventListener('install', () => self.skipWaiting());

// SEMPRE buscar a página nova ao abrir o app.
//
// O GitHub Pages manda o navegador guardar a página por 10 minutos, e o iPhone respeita
// isso mesmo fechando o app. Em 17/09/2026 o botão "Apagar pergunta" foi publicado e o
// Matheus fechou e abriu o app várias vezes sem ver — era a cópia guardada. Aqui a
// abertura do app pede a página pulando essa cópia; sem internet, usa a guardada.
self.addEventListener('fetch', (evento) => {
  if (evento.request.mode !== 'navigate') return;
  evento.respondWith(fetch(evento.request, { cache: 'no-store' }).catch(() => fetch(evento.request)));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (evento) => {
  let dados = {};
  try { dados = evento.data ? evento.data.json() : {}; } catch (_e) {
    dados = { titulo: 'Sistema de Estoque', mensagem: evento.data ? evento.data.text() : '' };
  }
  const titulo = dados.titulo || 'Sistema de Estoque';
  evento.waitUntil(self.registration.showNotification(titulo, {
    body: dados.mensagem || '',
    icon: 'icone-192.png',
    badge: 'icone-192.png',
    // A mesma tag substitui o aviso anterior do mesmo assunto em vez de empilhar:
    // "robô desligado" seguido de "robô de volta" vira uma notificação só.
    tag: dados.tag || undefined,
    renotify: !!dados.tag,
    data: { url: dados.url || './' },
  }));
});

// Tocar na notificação abre o app — ou traz pra frente, se já estiver aberto.
self.addEventListener('notificationclick', (evento) => {
  evento.notification.close();
  const alvo = (evento.notification.data && evento.notification.data.url) || './';
  evento.waitUntil((async () => {
    const abertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of abertas) {
      if (c.url.indexOf('/alertas/') !== -1 && 'focus' in c) { c.navigate(alvo); return c.focus(); }
    }
    return self.clients.openWindow(alvo);
  })());
});
