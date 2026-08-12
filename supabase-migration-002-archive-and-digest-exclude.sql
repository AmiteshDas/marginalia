-- ============================================================
-- Migration 002: archive notes, exclude categories from digest
-- Run this in the Supabase SQL editor against an EXISTING database.
-- Additive only — safe to run once real data exists. Do not re-run
-- supabase-schema.sql on a live project; it drops and recreates tables.
-- ============================================================

-- ------------------------------------------------------------
-- Archive — notes stay append-only in content; archiving only ever
-- flips this one column, never touches the original quote/link/etc.
-- ------------------------------------------------------------
alter table notes add column if not exists archived_at timestamptz;

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
    raise exception 'notes are append-only — only archived_at may change';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists notes_immutable_except_archive_trg on notes;
create trigger notes_immutable_except_archive_trg
  before update on notes
  for each row execute function notes_immutable_except_archive();

drop policy if exists "notes_update_archive_own" on notes;
create policy "notes_update_archive_own" on notes
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ------------------------------------------------------------
-- Digest exclusion — set per category at creation time. Notes in an
-- excluded category are skipped when the weekly-digest function
-- builds its summary, but stay in the Notes list as normal.
-- ------------------------------------------------------------
alter table categories add column if not exists exclude_from_digest boolean not null default false;
