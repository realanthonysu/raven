-- Upgrade spaced repetition system from simple interval-doubling to FSRS
-- (Free Spaced Repetition Scheduler).
--
-- New columns store per-card FSRS state:
--   stability     — memory stability in days (how long the memory lasts)
--   difficulty    — inherent card difficulty, 0-10 scale
--   elapsed_days  — days elapsed since last review
--   scheduled_days — interval scheduled for this review
--   reps          — total number of successful reviews (replaces review_count for FSRS)
--   lapses        — number of times rated "again" (forgetting events)
--   state         — FSRS state enum: 0=new, 1=learning, 2=review, 3=relearning
ALTER TABLE words ADD COLUMN stability REAL DEFAULT 0;
ALTER TABLE words ADD COLUMN difficulty REAL DEFAULT 0;
ALTER TABLE words ADD COLUMN elapsed_days INTEGER DEFAULT 0;
ALTER TABLE words ADD COLUMN scheduled_days INTEGER DEFAULT 0;
ALTER TABLE words ADD COLUMN reps INTEGER DEFAULT 0;
ALTER TABLE words ADD COLUMN lapses INTEGER DEFAULT 0;
ALTER TABLE words ADD COLUMN state INTEGER DEFAULT 0;
