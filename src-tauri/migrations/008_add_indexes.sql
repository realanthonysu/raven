-- Composite indexes for common query patterns.
--
-- O4: Index verification (EXPLAIN QUERY PLAN analysis)
-- idx_words_review: Used by get_review_words() query:
--   WHERE review_status != 'mastered' AND (next_review_at IS NULL OR next_review_at <= datetime('now'))
--   ORDER BY CASE WHEN review_status = 'new' THEN 0 ELSE 1 END, next_review_at ASC
--   → Index on (review_status, next_review_at) enables index scan for the WHERE clause.
--
-- idx_history_type_date: Used by get_history_list() and get_history_list_view():
--   WHERE type = ?1 ORDER BY created_at DESC LIMIT ?2 OFFSET ?3
--   → Composite index on (type, created_at DESC) enables seek + ordered scan,
--     avoiding filesort. SQLite 3.x supports DESC in index for forward scan.

-- Composite index for review stats and review word queries
-- Covers: WHERE review_status = 'new', WHERE next_review_at <= datetime('now'), ORDER BY next_review_at
CREATE INDEX IF NOT EXISTS idx_words_review ON words(review_status, next_review_at);

-- Composite index for history list queries (WHERE type = ? ORDER BY created_at DESC)
-- Replaces the need for SQLite to choose between idx_history_type and idx_history_created
CREATE INDEX IF NOT EXISTS idx_history_type_date ON history(type, created_at DESC);

-- Index for vocabulary list query (ORDER BY created_at DESC)
-- get_words() selects all words sorted by created_at DESC; this index avoids a full table scan + filesort.
CREATE INDEX IF NOT EXISTS idx_words_created_at ON words(created_at DESC);
