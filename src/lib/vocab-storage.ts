import type { Word } from "@/types";

const STORAGE_KEY = "raven-vocabulary";

export function getWords(): Word[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function addWord(word: Omit<Word, "id" | "created_at">): Word {
  const words = getWords();
  const newWord: Word = {
    ...word,
    id: Date.now(),
    created_at: new Date().toISOString(),
  };
  words.unshift(newWord);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(words));
  return newWord;
}

export function deleteWord(id: number) {
  const words = getWords().filter((w) => w.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(words));
}

export function updateWordLevel(id: number, level: string) {
  const words = getWords();
  const word = words.find((w) => w.id === id);
  if (word) {
    word.level = level as Word["level"];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(words));
  }
}
