-- 为生词本添加间隔重复（Spaced Repetition）支持所需的字段。
-- review_count：累计复习次数，用于判断单词是否达到"已掌握"标准（3次"认识"即升级）。
-- next_review_at：下次复习时间，算法根据掌握程度动态调整间隔（不认识→1天，认识→翻倍，最大30天）。
ALTER TABLE words ADD COLUMN review_count INTEGER DEFAULT 0;
ALTER TABLE words ADD COLUMN next_review_at DATETIME;
