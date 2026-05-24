-- ============================================================================
-- 001_init.sql — 初始化数据库表结构
-- 这是 Raven 应用的第一个迁移，创建了四个核心表。
-- 使用 IF NOT EXISTS 保证迁移的幂等性（重复执行不会报错）。
-- ============================================================================

-- 生词本：用户在阅读过程中收藏的单词
-- 设计为独立于历史记录的主表，因为单词有独立的复习生命周期
CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL,              -- 英文单词原形
  phonetic TEXT,                   -- 音标，可为空（部分来源无音标）
  definition TEXT NOT NULL,        -- 中文释义
  level TEXT,                      -- 用户自定义分级（如 CET-4/六级/考研），用于分类筛选
  source_type TEXT,                -- 来源类型：'reading'（阅读页）或 'manual'（手动添加）
  source_text TEXT,                -- 来源上下文原文，帮助用户回忆单词出现的语境
  notes TEXT,                      -- 用户个人笔记
  review_status TEXT DEFAULT 'new',-- 复习状态：'new'（新词）/ 'learning'（学习中）/ 'mastered'（已掌握）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 操作历史：记录每次"写作批改"和"阅读分析"的完整会话
-- type 字段区分功能（'correct' 或 'reading'），统一存储简化查询
-- result 以 JSON 字符串存储 LLM 返回的结构化结果，避免为每种结果类型设计独立表
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,              -- 功能类型：'correct'（写作批改）/ 'reading'（阅读分析）
  input_text TEXT NOT NULL,        -- 用户输入的原始文本
  result TEXT NOT NULL,            -- LLM 返回的结果（JSON 字符串或 Markdown）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 键值设置表：存储用户偏好设置
-- 使用简单的 K-V 结构而非 JSON 列，便于单个设置项的原子读写
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,            -- 设置项名称（如 'theme'、'language'）
  value TEXT NOT NULL              -- 设置值（统一为字符串，前端自行解析类型）
);

-- LLM 模型配置表：支持用户配置多个 AI 服务商
-- 用户可添加多个模型配置（如 OpenAI、DeepSeek、本地 Ollama），并切换默认模型
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,              -- 用户自定义名称（如 "GPT-4o"、"DeepSeek V3"）
  api_key TEXT NOT NULL,           -- API 密钥（注意：明文存储，生产环境应考虑加密）
  base_url TEXT NOT NULL,          -- API 基础地址，支持自定义端点（兼容 OpenAI 格式的第三方服务）
  model_name TEXT NOT NULL,        -- 实际模型标识符（如 "gpt-4o"、"deepseek-chat"）
  is_default BOOLEAN DEFAULT 0    -- 是否为默认模型，应用中只能有一个默认值
);

-- 索引设计说明：
-- idx_words_level：按分级筛选生词是高频操作（词汇页按级别分组展示）
-- idx_history_type：历史页按类型（批改/阅读）筛选
-- idx_history_created：历史页默认按时间倒序排列，此索引加速排序
CREATE INDEX IF NOT EXISTS idx_words_level ON words(level);
CREATE INDEX IF NOT EXISTS idx_history_type ON history(type);
CREATE INDEX IF NOT EXISTS idx_history_created ON history(created_at);
