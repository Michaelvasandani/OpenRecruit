import type { ConnectionConfig, ConnectionStatus, ConnectionTestResult } from "@shared/connection";
import { useEffect, useState } from "react";

/**
 * Renderer side of the launcher's connection bridge (`window.__opentradeConnection`,
 * exposed by the preload; contract in shared/connection.ts). Absent outside Electron.
 */
declare global {
  interface Window {
    __opentradeConnection?: {
      status: () => Promise<ConnectionStatus>;
      test: (sshTarget: string) => Promise<ConnectionTestResult>;
      apply: (config: ConnectionConfig) => Promise<void>;
    };
  }
}

/** The launcher's boot-time connection status; undefined until it arrives (or forever
 *  when there is no bridge). */
export function useConnectionStatus(): ConnectionStatus | undefined {
  const [status, setStatus] = useState<ConnectionStatus>();
  useEffect(() => {
    let alive = true;
    window.__opentradeConnection?.status().then((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
    };
  }, []);
  return status;
}
