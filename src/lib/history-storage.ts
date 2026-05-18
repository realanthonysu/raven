import type { HistoryRecord } from "@/types";

const STORAGE_KEY = "raven-history";

export function getHistory(type?: string): HistoryRecord[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const records: HistoryRecord[] = JSON.parse(raw);
    if (type) {
      return records.filter((r) => r.type === type);
    }
    return records;
  } catch {
    return [];
  }
}

export function addHistory(record: Omit<HistoryRecord, "id" | "created_at">) {
  const records = getHistory();
  const newRecord: HistoryRecord = {
    ...record,
    id: Date.now(),
    created_at: new Date().toISOString(),
  };
  records.unshift(newRecord);
  // Keep last 100 records
  if (records.length > 100) records.length = 100;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

export function deleteHistory(id: number) {
  const records = getHistory().filter((r) => r.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}
