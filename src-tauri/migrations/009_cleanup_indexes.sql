-- Drop redundant single-column indexes superseded by composite indexes from 008.
--
-- idx_history_type_date(type, created_at DESC) from migration 008 covers both
-- type-only and type+date queries, making the standalone idx_history_type unnecessary.
-- idx_history_created is redundant since the composite index provides date ordering.
DROP INDEX IF EXISTS idx_history_type;
DROP INDEX IF EXISTS idx_history_created;
