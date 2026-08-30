-- ============================================================
-- Migration 005: add 'paper' (Long-form Paper) to source_type
-- Additive only.
-- ============================================================

alter type source_type add value if not exists 'paper';
