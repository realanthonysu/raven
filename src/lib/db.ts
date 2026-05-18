import Database from "@tauri-apps/plugin-sql";
import type { Word, HistoryRecord, ModelConfig } from "@/types";

let db: Database | null = null;

async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.load("sqlite:raven.db");
  }
  return db;
}

// --- 生词本 ---
export async function addWord(word: Omit<Word, "id" | "created_at">) {
  const db = await getDb();
  return db.execute(
    "INSERT INTO words (word, phonetic, definition, level, source_type, source_text, notes, review_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [word.word, word.phonetic, word.definition, word.level, word.source_type, word.source_text, word.notes, word.review_status ?? "new"]
  );
}

export async function getWords(): Promise<Word[]> {
  const db = await getDb();
  return db.select<Word[]>("SELECT * FROM words ORDER BY created_at DESC");
}

export async function deleteWord(id: number) {
  const db = await getDb();
  return db.execute("DELETE FROM words WHERE id = $1", [id]);
}

export async function updateWordLevel(id: number, level: string) {
  const db = await getDb();
  return db.execute("UPDATE words SET level = $1 WHERE id = $2", [level, id]);
}

// --- 历史记录 ---
export async function addHistory(record: Omit<HistoryRecord, "id" | "created_at">) {
  const db = await getDb();
  return db.execute(
    "INSERT INTO history (type, input_text, result) VALUES ($1, $2, $3)",
    [record.type, record.input_text, record.result]
  );
}

export async function getHistory(type?: string): Promise<HistoryRecord[]> {
  const db = await getDb();
  if (type) {
    return db.select<HistoryRecord[]>(
      "SELECT * FROM history WHERE type = $1 ORDER BY created_at DESC",
      [type]
    );
  }
  return db.select<HistoryRecord[]>("SELECT * FROM history ORDER BY created_at DESC");
}

export async function deleteHistory(id: number) {
  const db = await getDb();
  return db.execute("DELETE FROM history WHERE id = $1", [id]);
}

// --- 模型配置 ---
export async function getModels(): Promise<ModelConfig[]> {
  const db = await getDb();
  return db.select<ModelConfig[]>("SELECT * FROM models ORDER BY is_default DESC");
}

export async function addModel(model: Omit<ModelConfig, "id">) {
  const db = await getDb();
  if (model.is_default) {
    await db.execute("UPDATE models SET is_default = 0");
  }
  return db.execute(
    "INSERT INTO models (name, api_key, base_url, model_name, is_default) VALUES ($1, $2, $3, $4, $5)",
    [model.name, model.api_key, model.base_url, model.model_name, model.is_default]
  );
}

export async function deleteModel(id: number) {
  const db = await getDb();
  return db.execute("DELETE FROM models WHERE id = $1", [id]);
}

export async function getDefaultModel(): Promise<ModelConfig | null> {
  const db = await getDb();
  const rows = await db.select<ModelConfig[]>(
    "SELECT * FROM models WHERE is_default = 1 LIMIT 1"
  );
  return rows[0] ?? null;
}
