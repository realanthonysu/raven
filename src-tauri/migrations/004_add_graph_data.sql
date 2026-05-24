-- 为历史记录添加知识图谱数据列。
-- 阅读分析页面会额外生成知识图谱（实体+关系的 JSON），
-- 此列存储 Cytoscape.js 格式的图数据，避免单独建表增加查询复杂度。
-- 对于写作批改记录，此列为 NULL。
ALTER TABLE history ADD COLUMN graph_data TEXT;
