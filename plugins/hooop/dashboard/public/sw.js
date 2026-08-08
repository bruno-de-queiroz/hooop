/* hooop service worker — web notifications only.
 *
 * Deliberately minimal: no caching, no offline shell. The dashboard is a live
 * view of a running sandbox, so a stale cached page is worse than no page.
 * This exists purely because a `push` event needs a service worker to receive
 * it — that is the whole point, since a backgrounded mobile tab is suspended
 * and nothing in the page is running to be told anything. (There is a fetch
 * handler below, but it's a passthrough for installability, not a cache.)
 *
 * Plain JS in public/ rather than TypeScript: a service worker is fetched as a
 * standalone script by the browser, not bundled with the app.
 */

// Take over as soon as we're installed rather than waiting for every existing
// tab to close. A user who just clicked "enable notifications" expects the next
// event to arrive, not the one after they restart their browser.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// A no-op passthrough, not a cache: some browsers' installability check (and,
// apparently, their willingness to hand out a working push subscription) still
// requires a fetch handler to exist at all, even though Chrome itself dropped
// that requirement. This intentionally does not touch caching — see the file
// header for why a stale cached page would be worse than no page.
self.addEventListener("fetch", (event) => event.respondWith(fetch(event.request)));

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    return; // Not ours / malformed — better silent than a garbage notification.
  }

  const title = payload.title || "hooop";
  const sessionId = payload.sessionId || "";
  const category = payload.category || "";

  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      // Collapse repeats per session+category so a chatty session produces one
      // updating notification instead of a stack the user has to dismiss.
      tag: `hooop:${sessionId}:${category}`,
      renotify: category === "attention",
      // The blocking categories should survive being ignored for a moment; the
      // rest can auto-dismiss.
      requireInteraction: category === "attention",
      data: { sessionId, category },
      // PNG, not the SVG that sits beside it: SVG notification icons are not
      // reliably supported (Chrome ignores them outright on Android), and a
      // silently-dropped icon looks exactly like having specified none.
      icon: "/icon-192.png",
      // Monochrome-ish small mark for the platforms that show one (Android's
      // status bar). Harmless where it isn't used.
      badge: "/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;
  // A peer is locked to one session and lands on it anyway, so the query is
  // only meaningful for the host — harmless either way.
  const target = sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      // Prefer focusing a tab that's already open over spawning another one.
      for (const w of windows) {
        if ("focus" in w) {
          if ("navigate" in w && sessionId) w.navigate(target).catch(() => {});
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
