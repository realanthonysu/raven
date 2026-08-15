-- 010_repair_srs_backfill_and_index.sql
-- 1) 修复 007 升级的回填缺口；2) 恢复被 009 误删的全局时间索引。

-- ============================================================================
-- 1) 007 仅以 DEFAULT 0 新增 FSRS 列，已有复习历史的旧词因此得到
--    state=0(New)/reps=0/difficulty=0/stability=0，与 review_status/review_count 矛盾：
--    旧词下次复习会被当作新卡走 FSRS 初始参数表，历史复习次数被静默清零。
--    按 review_status 回填状态；reps 对齐 review_count；difficulty/stability 低于
--    算法下限的置为中性起步值。从未复习（review_count<=0）或已进入 FSRS 流程
--    （state>0）的行不受影响。
--    注意：SQLite 单条 UPDATE 的所有右值均取自更新前的行值，各赋值互不干扰。
UPDATE words SET
  state = CASE WHEN review_status = 'mastered' THEN 2 ELSE 1 END,
  reps = MAX(COALESCE(reps, 0), COALESCE(review_count, 0)),
  difficulty = CASE WHEN COALESCE(difficulty, 0) < 1.0 THEN 5.0 ELSE difficulty END,
  stability = CASE WHEN COALESCE(stability, 0) < 0.1 THEN 0.5 ELSE stability END
WHERE state = 0 AND COALESCE(review_count, 0) > 0;

-- ============================================================================
-- 2) 009 删除 idx_history_created 时认为复合索引 idx_history_type_date(type, created_at DESC)
--    已覆盖时间排序，但复合索引的前导列是 type，无法服务无类型过滤的查询
--    （query_history 无过滤分支 ORDER BY created_at DESC LIMIT、get_history_oldest_date
--    的 ORDER BY created_at ASC）——这些热路径退化为全表排序。恢复单列索引。
CREATE INDEX IF NOT EXISTS idx_history_created ON history(created_at DESC);
