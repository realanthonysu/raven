-- 014: history 表增加 difficulty_level 列，存储每次练习生成时使用的 CEFR 级别码
-- （A2/B1/B1+/B2/B2+/C1，见前端 src/lib/levels.ts）。
-- 存量记录为 NULL —— 级别体系上线前的历史不回填。
ALTER TABLE history ADD COLUMN difficulty_level TEXT;
