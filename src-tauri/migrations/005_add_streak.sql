-- 学习连续打卡记录表。
-- 每天一条记录，activities 字段存储 JSON 格式的活动计数，
-- 如 {"writing": 2, "exercise": 1, "review": 1, "reading": 0, "listening": 0}。
-- 用于计算连续学习天数和展示今日学习统计。
CREATE TABLE IF NOT EXISTS learning_streaks (
  date TEXT PRIMARY KEY,
  activities TEXT NOT NULL DEFAULT '{}'
);
