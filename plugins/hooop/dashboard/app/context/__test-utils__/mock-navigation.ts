import { vi } from "vitest";
import { useSyncExternalStore } from "react";

// Minimal reactive store for the mock URL. Subscribers (one per mounted
// `useSearchParams` / `usePathname` call) are notified whenever the URL
// changes via `setMockUrl` OR via the mocked router. This is what the
// real Next.js navigation layer does internally; without it, calling
// `setSelected` inside a test never causes the provider tree to
// re-render under the new search params.
let currentUrl = new URL("http://localhost/");
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function setMockUrl(href: string) {
  currentUrl = new URL(href, currentUrl.href);
  notify();
}

export function getMockUrl(): URL {
  return new URL(currentUrl.href);
}

export const mockRouterReplace = vi.fn((href: string) => {
  currentUrl = new URL(href, currentUrl.href);
  notify();
});
export const mockRouterPush = vi.fn((href: string) => {
  currentUrl = new URL(href, currentUrl.href);
  notify();
});

function getSearch(): string {
  return currentUrl.search;
}
function getPath(): string {
  return currentUrl.pathname;
}

export function installMockNavigation() {
  currentUrl = new URL("http://localhost/");
  listeners.clear();
  mockRouterReplace.mockClear();
  mockRouterPush.mockClear();

  vi.doMock("next/navigation", () => ({
    useRouter: () => ({
      replace: mockRouterReplace,
      push: mockRouterPush,
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    }),
    usePathname: () => useSyncExternalStore(subscribe, getPath, getPath),
    useSearchParams: () => {
      const search = useSyncExternalStore(subscribe, getSearch, getSearch);
      return new URLSearchParams(search);
    },
  }));
}
