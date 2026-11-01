// Service worker: shows alerts for staff even when the staff page is closed.
self.addEventListener('push', e => {
    let d = {}; try { d = e.data.json(); } catch (x) {}
    e.waitUntil(self.registration.showNotification(d.title || 'Groco', { body: d.body || '', icon: '/image/favicon.png', badge: '/image/favicon.png', data: { url: d.url || '/staff.html' }, vibrate: [200, 100, 200], tag: d.tag || undefined }));
});
self.addEventListener('notificationclick', e => {
    e.notification.close();
    e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => { for (const c of list) if (c.url.includes('/staff.html') && 'focus' in c) return c.focus(); return clients.openWindow(e.notification.data.url); }));
});
