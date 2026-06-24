-- Composite indexes for common query patterns.

-- Composite index for review stats and review word queries
-- Covers: WHERE review_status = 'new', WHERE next_review_at <= datetime('now'), ORDER BY next_review_at
CREATE INDEX IF NOT EXISTS idx_words_review ON words(review_status, next_review_at);

-- Composite index for history list queries (WHERE type = ? ORDER BY created_at DESC)
-- Replaces the need for SQLite to choose between idx_history_type and idx_history_created
CREATE INDEX IF NOT EXISTS idx_history_type_date ON history(type, created_at DESC);
