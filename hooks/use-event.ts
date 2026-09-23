import { EventRow, getEvent, resolveEventId } from "@/lib/db";
import { toAppError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Resolves the `[eventId]` route param to a real event.
 *
 * Two things make this less trivial than a `getEvent(id)` call, and all
 * four event screens need both — hence one hook rather than four copies:
 *
 *  1. An admin who creates an event offline navigates to a *temporary*
 *     local id. Once sync reconciles it the row is renamed to the
 *     server's id, and the screen's route param is suddenly pointing at
 *     nothing. `resolveEventId` follows the rename.
 *  2. The event's course/year scoping can change on the server while a
 *     screen is open, so it is reloaded on focus rather than once on
 *     mount.
 */
export function useEvent() {
  const params = useLocalSearchParams<{ eventId: string }>();
  const routeId = typeof params.eventId === "string" ? params.eventId : "";

  const [eventId, setEventId] = useState(routeId);
  const [event, setEvent] = useState<EventRow | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    if (!routeId) {
      setLoading(false);
      return;
    }
    try {
      const resolved = await resolveEventId(routeId);
      const row = await getEvent(resolved);
      if (!mounted.current) return;
      setEventId(resolved);
      setEvent(row);
    } catch (err) {
      log.warn("couldn't load event", { message: toAppError(err).message });
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [routeId]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload])
  );

  return { eventId, event, loading, reload };
}
