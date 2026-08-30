-- ============================================================
-- Migration 004: split notes vs. shelf items by `kind`, and let a note
-- optionally reference the shelf item it came from.
-- Run this in the Supabase SQL editor against an EXISTING database.
-- Additive only — safe to run once real data exists.
-- ============================================================

-- ------------------------------------------------------------
-- kind — 'note' (a recorded quote, immutable, always status='done') vs.
-- 'shelf' (a reading-queue placeholder with no real quote, whose status
-- moves to_read -> reading -> done). Same table, same RLS/triggers/
-- realtime — this one column is what stops a shelf placeholder ("Alcohol
-- Substitution Playbook", no quote yet) from showing up in the Notes list
-- once it's marked done, since status alone can't tell the two apart.
-- ------------------------------------------------------------
alter table notes add column if not exists kind text not null default 'note'
  check (kind in ('note', 'shelf'));

-- Backfill existing rows by the only reliable signal available: the Notes
-- capture form has always set status to 'done' (or predates the reading
-- lifecycle entirely, backfilled 'done' by migration 003), while the
-- Shelf form always sets to_read. A shelf item manually marked "done"
-- before this migration would be misclassified as a note here — there's
-- no way to distinguish that case after the fact; fix it by hand in the
-- SQL editor if it applies to your data (`update notes set kind = 'shelf'
-- where id = '...'`).
update notes set kind = 'shelf' where status in ('to_read', 'reading');

-- ------------------------------------------------------------
-- source_item_id — optional self-reference from a note to the shelf item
-- it came from ("this quote is from that book on your shelf"). Nullable:
-- most notes won't have one. Set only at capture time, never edited after
-- (notes stay append-only) — no trigger change needed since the
-- immutability trigger only guards UPDATE, not INSERT.
-- ------------------------------------------------------------
alter table notes add column if not exists source_item_id uuid references notes(id) on delete set null;

create index if not exists notes_user_kind_idx on notes (user_id, kind);
create index if not exists notes_source_item_idx on notes (source_item_id) where source_item_id is not null;

-- ------------------------------------------------------------
-- Views purely for a cleaner mental model when browsing in Supabase
-- Studio or writing ad hoc SQL — same underlying table, same RLS (views
-- inherit the base table's row security), no duplicated policies or
-- triggers. The app itself queries `notes` directly with `kind` filters.
-- ------------------------------------------------------------
create or replace view notes_view as
  select id, user_id, quote, link, source_type, category_id, context,
         source_used_at, created_at, archived_at, source_item_id, client_id
  from notes
  where kind = 'note';

create or replace view shelf_view as
  select id, user_id, quote as title, link, source_type, category_id, context,
         status, last_touched, resurfaced_at, created_at, archived_at
  from notes
  where kind = 'shelf';
