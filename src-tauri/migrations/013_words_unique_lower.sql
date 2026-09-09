-- words 表缺少 lower(word) 唯一索引：add_word 每次插入都做全表扫幂等检查。
-- 先去重（保留最早插入的 id，即 MIN(id)），再建表达式唯一索引。
-- 此后 add_word 的 lower(word)=lower(?) 检查走索引 seek，不再是 O(n) 扫描。

DELETE FROM words
WHERE id NOT IN (
  SELECT MIN(id) FROM words GROUP BY lower(word)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_words_word_lower ON words(lower(word));
