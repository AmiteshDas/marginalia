// Shared reading-lifecycle logic — momentum, staleness, resurfacing.
//
// This is the single source of truth for how `status` + `last_touched`
// translate into momentum tags and archiving decisions. Both the frontend
// (app.js, browser ESM, no bundler) and the Supabase Edge Functions (Deno)
// import this exact file by relative path — do not fork a copy into either
// runtime, or the dashboard and the digest/archive job will drift apart.
//
// Plain JS only (no browser or Deno-specific APIs) so it runs unmodified
// in both environments.

export const MOMENTUM = { FRESH: "fresh", WARM: "warm", COLD: "cold" };

const DAY_MS = 24 * 60 * 60 * 1000;

// `to_read` items with no last_touched update in this many days get
// resurfaced once ("still want to read this?").
export const STALE_TO_READ_DAYS = 30;

// After being resurfaced, an untouched `to_read` item is silently archived
// once this many additional days pass with no update.
export const ARCHIVE_GRACE_DAYS = 7;

export function daysSince(timestamp, now = new Date()) {
  if (!timestamp) return Infinity;
  return Math.floor((now.getTime() - new Date(timestamp).getTime()) / DAY_MS);
}

// Momentum only applies to `status: reading` items — 0-5 days fresh,
// 6-21 warm, 21+ cold. Not to be confused with the separate 1-month
// to_read resurface window below, even though both read off last_touched.
export function computeMomentum(lastTouched, now = new Date()) {
  const days = daysSince(lastTouched, now);
  if (days <= 5) return MOMENTUM.FRESH;
  if (days <= 21) return MOMENTUM.WARM;
  return MOMENTUM.COLD;
}

export function isColdReadingItem(item, now = new Date()) {
  return item.status === "reading" && computeMomentum(item.last_touched, now) === MOMENTUM.COLD;
}

export function isStaleToRead(item, now = new Date()) {
  if (item.status !== "to_read" || item.archived_at) return false;
  const reference = item.last_touched || item.created_at;
  return daysSince(reference, now) >= STALE_TO_READ_DAYS;
}

// True the run a stale to_read item first crosses the 1-month mark and
// hasn't been flagged yet — the dashboard/digest should ask "still want
// to read this?" for it, and the archive job should stamp resurfaced_at.
export function needsResurface(item, now = new Date()) {
  return isStaleToRead(item, now) && !item.resurfaced_at;
}

// True once a resurfaced item has sat untouched for the grace period —
// the archive job should silently set archived_at (soft-delete).
export function readyToArchive(item, now = new Date()) {
  if (item.status !== "to_read" || item.archived_at || !item.resurfaced_at) return false;
  const touchedSinceResurface =
    item.last_touched && new Date(item.last_touched) > new Date(item.resurfaced_at);
  if (touchedSinceResurface) return false;
  return daysSince(item.resurfaced_at, now) >= ARCHIVE_GRACE_DAYS;
}

// Source types precise enough to track by page number. Everything else
// (article, podcast, video, other) uses the coarser milestone chips
// instead — asking for a page count on a podcast doesn't mean anything.
export const PAGE_TRACKED_SOURCE_TYPES = ["book", "paper"];

export function usesPageTracking(sourceType) {
  return PAGE_TRACKED_SOURCE_TYPES.includes(sourceType);
}

// Milestone labels map to a rough percent purely for the progress bar —
// the label itself, not the number, is what the user ever picks.
export const MILESTONES = {
  started: 10,
  partway: 40,
  nearly_there: 75,
  finished: 100,
};

// A single 0-100 percent regardless of which input produced it (page
// count vs. milestone chip), so the dashboard renders one consistent
// progress bar either way. Null when there's not enough to compute from
// yet (no pages set, or no milestone picked).
export function computeProgressPercent(item) {
  if (usesPageTracking(item.source_type)) {
    if (!item.total_pages || !item.current_page) return null;
    return Math.max(0, Math.min(100, Math.round((item.current_page / item.total_pages) * 100)));
  }
  if (item.milestone && MILESTONES[item.milestone] != null) return MILESTONES[item.milestone];
  return null;
}
