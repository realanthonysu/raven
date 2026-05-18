export interface ModelConfig {
  id: number;
  name: string;
  api_key: string;
  base_url: string;
  model_name: string;
  is_default: boolean;
}

export type WordLevel = "CET-4" | "CET-6" | "TEM-4" | "TEM-8";

export interface Word {
  id: number;
  word: string;
  phonetic: string | null;
  definition: string;
  level: WordLevel | null;
  source_type: string | null;
  source_text: string | null;
  notes: string | null;
  review_status: string;
  created_at: string;
}

export interface HistoryRecord {
  id: number;
  type: "translate" | "correct" | "reading";
  input_text: string;
  result: string;
  created_at: string;
}
