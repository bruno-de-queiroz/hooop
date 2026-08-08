"use client";

// Module-level side effect: monkey-patches fetch as soon as this client module
// loads. Mutating requests (POST/PUT/PATCH/DELETE) carry the auth token in an
// `x-dashboard-token` header — the same value the server set as an HttpOnly,
// SameSite=Strict cookie. The middleware checks both: SameSite blocks
// cross-origin cookie attachment, and the header (synchronizer token) catches
// any case where a hostile page somehow got the cookie shipped.
//
// Reading the token from a <meta> tag instead of the cookie because the cookie
// is HttpOnly (script can't read it). Top-level execution runs once when the
// bundle first loads in the browser, before any panel's fetch fires.

if (typeof window !== "undefined" && !(window as any).__hooop_fetch_patched) {
  const meta = document.querySelector("meta[name='x-dashboard-token']");
  const token = meta?.getAttribute("content") ?? null;
  if (token) {
    const originalFetch = window.fetch;
    window.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
      const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
        return originalFetch(input, init);
      }
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set("x-dashboard-token", token);
      return originalFetch(input, { ...init, headers });
    }) as typeof window.fetch;
    (window as any).__hooop_fetch_patched = true;
  }
}

export default function AuthBootstrap() {
  return null;
}
