import { useEffect } from "react";
import { trpc } from "../lib/trpc";

/** Recruiting Scout read projection. The renderer never imports the database
 * schema; reconnects invalidate the query after the host sends a resync envelope. */
export function useScouts() {
  const query = trpc.recruiting.scouts.useQuery();
  const utils = trpc.useUtils();
  trpc.recruiting.onChanged.useSubscription(undefined, {
    onData: (event) => {
      if (event.reason === "resync" || event.kind === "scout" || event.kind === "review") {
        void utils.recruiting.scouts.invalidate();
      }
    },
  });
  useEffect(() => {
    if (query.error) console.error("recruiting Scouts projection failed", query.error);
  }, [query.error]);
  return query.data ?? [];
}
