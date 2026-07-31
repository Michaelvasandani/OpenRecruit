import type { UpdaterState } from "@shared/updater";
import { useEffect, useState } from "react";

/**
 * Renderer-side access to the app updater, which lives in the Electron MAIN
 * process (not the host) and is exposed on `window.__opentradeUpdater` by the
 * preload. `useUpdater` seeds from the current state, subscribes to pushes, and
 * hands back `check()` (force a check) and `install()` (accept the available
 * update → download if needed → relaunch immediately). User-in-charge: nothing
 * downloads or installs until `install()` is called.
 */
declare global {
  interface Window {
    __opentradeUpdater?: {
      check: () => Promise<UpdaterState>;
      getState: () => Promise<UpdaterState>;
      install: () => Promise<void>;
      subscribe: (cb: (state: UpdaterState) => void) => () => void;
    };
  }
}

export function useUpdater(): {
  state: UpdaterState | null;
  check: () => void;
  install: () => void;
} {
  const [state, setState] = useState<UpdaterState | null>(null);

  useEffect(() => {
    const bridge = window.__opentradeUpdater;
    if (!bridge) return;
    let alive = true;
    bridge.getState().then((s) => {
      if (alive) setState(s);
    });
    const unsubscribe = bridge.subscribe((s) => setState(s));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const check = () => {
    // Fire-and-forget: the resulting status arrives via the subscription above, so we
    // don't setState on the invoke result (which could race a faster push) or need a catch.
    window.__opentradeUpdater?.check();
  };

  const install = () => {
    window.__opentradeUpdater?.install();
  };

  return { state, check, install };
}
