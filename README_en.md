# Raven

[中文](./README.md) | English

The AI-powered English learning desktop assistant

![version](https://img.shields.io/badge/version-v1.3.0-blue)
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

- All analyses saved to SQLite with type filtering (Writing/Reading/Exercise)
- Detail page with expandable cards and knowledge graph
- Analytics dashboard: error category distribution, trend charts, session summaries

### Weak Point Training

Automatically identifies weak areas from writing correction data and generates targeted exercises:

- Smart recommendation — analyzes recent 10 correction sessions to identify high-frequency error categories
- Diverse question types — fill-in-the-blank (tense/SVA/plurals), error correction (articles/prepositions), sentence rewriting (word choice/syntax)
- Unified review — shows all answers with correct answers and detailed explanations after completion
- History tracking — exercise results persisted and viewable from history

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

## Download & Installation

### System Requirements

- Windows 10 and above

### Windows Users

Download the latest release from the [Releases](https://github.com/anthonysu/raven/releases) page:

- `Raven_1.3.0_x64-setup.exe` — Standard installer (recommended)
- `Raven_1.3.0_x64_en-US.msi` — MSI package

Double-click the downloaded installer and follow the setup wizard to complete installation.

## Changelog

### v1.3.0

- **TTS integration**: supports OpenAI-compatible TTS API with independent config for URL, key, voice, and speed
- **Vocabulary pronunciation**: speaker button on every word in vocabulary notebook and review flashcards
- **Reading read-aloud**: sentence-by-sentence playback with synchronized highlighting of the current sentence
- **Writing compare-speak**: listen to both the original wrong text and the corrected version for each correction
- **Listening practice**: new feature — LLM generates sentences, TTS plays them, user dictates, auto-scoring
- **Speed trainer**: new feature — paste English text and play at 5 speed levels (0.5x–1.5x) with single/full loop modes
- Settings page now includes TTS configuration card with a test button

### v1.2.1

- Enhanced weak point training: smart answer matching by question type (exact for fill-in-the-blank, normalized for correction/rewriting)
- Loading timeout hint: shows "regenerate" button when LLM takes over 30 seconds
- Save failure feedback: displays warning banner when exercise results fail to persist
- Task status bar integration: weak point training now shows loading/completion in the global status bar
- Code quality: comprehensive comments added, new unit tests (32 test cases)

### v1.1.0

- Weak point training: automatically identifies weak areas from writing correction data and generates targeted exercises
- Analytics dashboard: new weak category recommendation with direct training access
- History detail supports exercise record review

## Project Structure

```
src/
├── components/          # Shared UI (KnowledgeGraph, Layout, Sidebar, etc.)
├── lib/                 # Utilities (db, parse-utils, task-status, type-config)
├── pages/               # Pages (Correct, Reading, Vocabulary, Review, History, Analytics, Settings, Listening, Speed Trainer)
├── services/            # LLM streaming service, TTS audio service
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
