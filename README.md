# Raven

English | [中文](./README_zh.md)

The AI-powered English learning desktop assistant

![version](https://img.shields.io/badge/version-v1.0.1-blue)
![platform](https://img.shields.io/badge/platform-Windows-blue)
![built with](https://img.shields.io/badge/built%20with-Tauri%202-orange)

An AI-powered English learning desktop assistant. Built with Tauri v2 + React + TypeScript.

## Features

### Writing Copilot

Paste English text for grammar correction and writing suggestions.

- Error identification with categories (subject-verb agreement, tense, articles, spelling, etc.)
- Writing improvement tips
- One-click copy corrected text or replace input

### Reading Copilot

Paste an English article for deep reading analysis with six dimensions:

1. **Translation** — full Chinese translation
2. **Key Vocabulary** — 5-8 words with phonetics, collocations, and examples
3. **Sentence Breakdown** — complex sentence structure analysis (max 10)
4. **Grammar Analysis** — grammar point extraction (max 10)
5. **Background & Techniques** — domain context + translation techniques
6. **Extended Thinking** — critical thinking and open questions

Plus an interactive **knowledge graph** (Cytoscape.js) with bilingual toggle and fullscreen mode.

### Vocabulary Notebook

Save words from Reading Copilot by clicking or via the "Add to notebook" button. Tag with difficulty levels (CET-4/6, TEM-4/8).

### Spaced Repetition Review

Flip-card interface with spaced repetition scheduling:

- Front: word + phonetic; Back: definition, collocations, example
- Self-assessment: "Don't know" (reset to 1 day), "Vague" (keep interval), "Know" (double interval, max 30 days)
- Auto-promotion to `mastered` after 3 consecutive "Know" ratings
- Smart scheduling — only shows words due for review

### History & Analytics

- All analyses saved to SQLite with type filtering (Writing/Reading)
- Detail page with expandable cards and knowledge graph
- Analytics dashboard: error category distribution, trend charts, session summaries

### Background Tasks

- CorrectPage and ReadingPage stay mounted across navigation
- Status bar shows running/completed tasks
- Task notifications persist until viewed

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Tauri v2 |
| Frontend | React 19, TypeScript, Vite |
| UI | shadcn/ui v4, Tailwind CSS v3, lucide-react |
| LLM | OpenAI-compatible API (configurable) |
| Graph | Cytoscape.js |
| Database | SQLite (tauri-plugin-sql) |
| Charts | recharts |
| Testing | Vitest |
| Linting | ESLint v10 |

## Getting Started

```bash
npm install
npm run tauri dev        # Full dev (Vite + Rust + desktop window)
npm run dev              # Frontend only (port 5173)
npm run tauri build      # Build desktop app
npm run lint             # Lint check
npm run test             # Run tests
```

## Project Structure

```
src/
├── components/          # Shared UI (KnowledgeGraph, Layout, Sidebar, etc.)
├── lib/                 # Utilities (db, parse-utils, task-status, type-config)
├── pages/               # Pages (Correct, Reading, Vocabulary, Review, History, Analytics, Settings)
├── services/            # LLM streaming service
├── test/                # Vitest setup
└── types/               # TypeScript interfaces

src-tauri/
├── src/lib.rs           # Tauri plugin registration
├── migrations/          # SQLite schema (001-004)
├── capabilities/        # WebView permissions
└── tauri.conf.json      # App config
```

## License

MIT © Anthony Su
