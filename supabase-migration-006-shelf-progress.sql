-- ============================================================
-- Migration 006: granular progress tracking on shelf items
-- Additive only.
-- ============================================================

-- Page tracking — book / paper only (see lib/momentum.js
-- PAGE_TRACKED_SOURCE_TYPES). Both editable directly on the Currently
-- Reading card; total_pages can also be set up front on the Add to Shelf
-- form if known.
alter table notes add column if not exists current_page int check (current_page is null or current_page >= 0);
alter table notes add column if not exists total_pages int check (total_pages is null or total_pages > 0);

-- Milestone chips — everything else (article/podcast/video/other), where
-- a page count doesn't mean anything. A coarse "how far along" pick
-- instead of an estimated percent.
alter table notes add column if not exists milestone text
  check (milestone is null or milestone in ('started', 'partway', 'nearly_there', 'finished'));

-- Widen the append-only trigger to also allow these three progress
-- columns to change, alongside the existing status/last_touched/
-- resurfaced_at/archived_at.
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
     or new.kind          is distinct from old.kind
     or new.source_item_id is distinct from old.source_item_id
  then
    raise exception 'notes are append-only — only archived_at, status, last_touched, resurfaced_at, current_page, total_pages, milestone may change';
  end if;
  return new;
end;
$$ language plpgsql;
