// Supabase Edge Function: archive-stale
// Triggered by a daily cron schedule — see /README.md for setup.
//
// Resurfaces `to_read` items that have sat untouched for a month
// ("still want to read this?"), and silently archives (soft-deletes) ones
// that are still untouched a grace period after being resurfaced. Uses the
// exact same isStaleToRead/needsResurface/readyToArchive logic the
// dashboard and digest read against — no separate rules reimplemented here.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { needsResurface, readyToArchive } from "../../../lib/momentum.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async (_req) => {
  try {
    const now = new Date();

    const { data: toRead, error } = await supabase
      .from("notes")
      .select("id, status, last_touched, created_at, resurfaced_at, archived_at")
      .eq("status", "to_read")
      .is("archived_at", null);
    if (error) throw error;

    const toResurface = (toRead ?? []).filter((n) => needsResurface(n, now));
    const toArchive = (toRead ?? []).filter((n) => readyToArchive(n, now));

    if (toResurface.length > 0) {
      const { error: resurfaceError } = await supabase
        .from("notes")
        .update({ resurfaced_at: now.toISOString() })
        .in("id", toResurface.map((n) => n.id));
      if (resurfaceError) throw resurfaceError;
    }

    if (toArchive.length > 0) {
      const { error: archiveError } = await supabase
        .from("notes")
        .update({ archived_at: now.toISOString() })
        .in("id", toArchive.map((n) => n.id));
      if (archiveError) throw archiveError;
    }

    return new Response(
      JSON.stringify({ resurfaced: toResurface.length, archived: toArchive.length }),
      { status: 200 }
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
