-- 为 models 表添加创建时间字段，用于排序和展示模型添加顺序。
-- SQLite 的 ALTER TABLE ADD COLUMN 不支持 DEFAULT 约束（5.39.0 前），
-- 所以先加列再用 UPDATE 回填已有记录的时间戳。
ALTER TABLE models ADD COLUMN created_at DATETIME;
UPDATE models SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;
