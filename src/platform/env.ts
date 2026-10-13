// Where Nib-E runs: the desktop app (Tauri) or a browser.
// The desktop app exposes a small, fixed set of commands (src-tauri/src/lib.rs).
// Nothing here reaches the network.

interface TauriGlobal {
  core: { invoke<T>(cmd: string, args?: unknown, opts?: { headers?: Record<string, string> }): Promise<T> };
  event: { listen<T>(name: string, fn: (e: { payload: T }) => void): Promise<() => void> };
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

export function isDesktop(): boolean {
  return !!window.__TAURI__?.core;
}

export function invoke<T>(cmd: string, args?: unknown, opts?: { headers?: Record<string, string> }): Promise<T> {
  const t = window.__TAURI__;
  if (!t) return Promise.reject(new Error('Only available in the desktop app.'));
  return t.core.invoke<T>(cmd, args, opts);
}

export function listen<T>(name: string, fn: (payload: T) => void): void {
  void window.__TAURI__?.event.listen<T>(name, (e) => fn(e.payload));
}

export function inFrame(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}
