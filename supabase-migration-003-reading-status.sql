-- ============================================================
-- Migration 003: reading lifecycle (status, last_touched, resurfacing)
-- Run this in the Supabase SQL editor against an EXISTING database.
-- Additive only — safe to run once real data exists.
-- ============================================================

-- ------------------------------------------------------------
-- status — to_read / reading / done. Deliberately no "abandoned" value:
-- items that stall get silently archived (see resurfaced_at below and
-- supabase/functions/archive-stale/), never explicitly marked abandoned.
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'reading_status') then
    create type reading_status as enum ('to_read', 'reading', 'done');
  end if;
end $$;

alter table notes add column if not exists status reading_status not null default 'to_read';

-- last_touched — the single source of truth for both momentum (reading
-- items) and stale-item archiving (to_read items). Updated whenever the
-- user starts an item, opens it, or marks progress — never inferred.
alter table notes add column if not exists last_touched timestamptz;

-- resurfaced_at — set the one time a stale to_read item is flagged
-- ("still want to read this?"). If it's still untouched after that, the
-- archive job silently archives it. Not exposed as a user-facing status —
-- just internal bookkeeping so resurfacing only happens once.
alter table notes add column if not exists resurfaced_at timestamptz;

-- Backfill: rows captured before this migration represent things already
-- read/used (that's what the capture form was for until now) — mark them
-- done and seed last_touched from created_at so the to_read archiving
-- lifecycle doesn't retroactively sweep up existing history.
update notes set status = 'done', last_touched = created_at where last_touched is null;

alter table notes alter column last_touched set default now();
alter table notes alter column last_touched set not null;

-- topic_tags reuses the existing categories mechanism (category_id / the
-- Category pills in the Capture form) — no second tagging table or UI.

create index if not exists notes_user_status_idx on notes (user_id, status);
create index if not exists notes_user_last_touched_idx on notes (user_id, last_touched);

-- ------------------------------------------------------------
-- Widen the append-only trigger: status/last_touched/resurfaced_at may
-- now change (reading-lifecycle updates), alongside the existing
-- archived_at. Everything else about a note stays immutable.
-- ------------------------------------------------------------
create or replace function notes_immutable_except_archive()
returns trigger as $$
begin
  if new.quote           is distinct from old.quote
     or new.link          is distinct from old.link
     or new.source_type   is distinct from old.source_type
     or new.context       is distinct from old.context
     or new.source_used_at is distinct from old.source_used_at
     or new.category_id   is distinct from old.category_id
     or new.client_id     is distinct from old.client_id
     or new.user_id       is distinct from old.user_id
     or new.created_at    is distinct from old.created_at
  then
    raise exception 'notes are append-only — only archived_at, status, last_touched, resurfaced_at may change';
  end if;
  return new;
end;
$$ language plpgsql;
-- Trigger already exists and points at this function by name — no need
-- to drop/recreate it, replacing the function body is enough.
