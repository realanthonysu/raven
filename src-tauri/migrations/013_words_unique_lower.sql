-- words 表缺少 lower(word) 唯一索引：add_word 每次插入都做全表扫幂等检查。
-- 先去重，再建表达式唯一索引。
-- 此后 add_word 的 lower(word)=lower(?) 检查走索引 seek，不再是 O(n) 扫描。
--
-- 去重幸存者按"学习进度最深"选取（review_count DESC, stability DESC, id ASC），
-- 而非 MIN(id)：历史版本允许同词重复行，被删行可能携带复习进度
-- （review_count/FSRS 列，见 003/007/010），保留进度最深的行避免静默清零。

DELETE FROM words
WHERE id NOT IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY lower(word)
             ORDER BY review_count DESC, COALESCE(stability, 0) DESC, id ASC
           ) AS rn
    FROM words
  )
  WHERE rn = 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_words_word_lower ON words(lower(word));
