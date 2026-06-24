# Raven

[中文](./README.md) | English

![version](https://img.shields.io/badge/version-v1.6.0-blue)
![platform](https://img.shields.io/badge/platform-Windows-blue)
![built with](https://img.shields.io/badge/built%20with-Tauri%202-orange)

**AI-powered English learning desktop assistant** — designed around the four core skills of listening, speaking, reading, and writing. Built with Tauri v2 + React + TypeScript.

Supports two types of models: **text models** (LLM, powering all analysis and generation) and **voice models** (TTS for speech synthesis + ASR for speech recognition), forming a complete learning loop from input to output.

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Development Commands](#development-commands)
- [Project Structure](#project-structure)
- [Changelog](#changelog)
- [License](#license)

## Features

### Dashboard

The app homepage with proactive learning guidance:

- Due review vocabulary summary (new / learning / mastered)
- Weak area analysis based on recent writing error categories
- Quick entry points (writing / reading / listening / speaking / vocabulary review)
- Recent learning timeline

### Writing Copilot

Paste English text for grammar correction and writing suggestions.

- Error identification with categories (subject-verb agreement, tense, articles, spelling, etc.)
- Writing improvement tips
- One-click copy corrected text or replace input
- Corrections can be added to vocabulary notebook with auto LLM enrichment

### Reading Copilot

Paste an English article for deep reading analysis with six dimensions:

1. **Translation** — full Chinese translation
2. **Key Vocabulary** — 5-8 words with phonetics, collocations, and examples
3. **Sentence Breakdown** — complex sentence structure analysis (max 10)
4. **Grammar Analysis** — grammar point extraction (max 10)
5. **Background & Techniques** — domain context + translation techniques
6. **Extended Thinking** — critical thinking and open questions

Plus an interactive **knowledge graph** (Cytoscape.js) with bilingual toggle and fullscreen mode. After analysis, click the "New Article" button to reset and start a new reading.

### Speaking Practice

Read-along sentence practice with AI scoring:

- LLM generates sentences — choose difficulty (beginner/intermediate/advanced) and topic (daily conversation, business English, travel, etc.)
- Record and read along — record sentence by sentence, ASR transcribes your speech
- AI scoring — LLM compares the original with your transcription, scores on accuracy, fluency, and pronunciation, with improvement suggestions

### Listening Practice

TTS plays sentences, user dictates, AI auto-scores:

- LLM generates sentences — selectable difficulty and topic
- TTS playback — multiple voices and speed settings
- Dictation input — type what you hear
- Auto scoring — word-level comparison between original and dictation, precise scoring
- Vocabulary extraction — extract key words from wrong sentences and add to notebook with one click

### Vocabulary Notebook

Save words from reading/writing/listening assistants by clicking or via the "Add to notebook" button. Tag with difficulty levels (CET-4/6, TEM-4/8).

- Manual vocabulary entry (auto LLM enrichment for phonetic, definition, collocations, example)
- CSV/TXT batch import (RFC 4180 quoted fields, auto-dedup, auto-enrichment)
- Export as CSV or Anki import format (Tab-separated)
- Single/batch enrichment for missing data

### Spaced Repetition Review

Flip-card interface with FSRS (Free Spaced Repetition Scheduler) algorithm:

- Front: word + phonetic; Back: definition, collocations, example
- Self-assessment: "Don't know" (reset to 1 day), "Vague" (keep interval), "Know" (double interval, max 30 days)
- Auto-promotion to `mastered` after 3 consecutive "Know" ratings
- FSRS algorithm dynamically computes review intervals based on memory stability and difficulty
- Only shows words due for review

### Weak Point Training

Automatically identifies weak areas from writing correction data and generates targeted exercises:

- Smart recommendation — analyzes recent 10 correction sessions to identify high-frequency error categories
- Diverse question types — fill-in-the-blank (tense/SVA/plurals), error correction (articles/prepositions), sentence rewriting (word choice/syntax)
- Unified review — shows all answers with correct answers and detailed explanations after completion
- History tracking — exercise results persisted and viewable from history

### History & Analytics

- All learning records saved to SQLite with type filtering (Writing/Reading/Speaking/Listening/Exercise)
- Paginated loading (20 per page), detail page with expandable cards and knowledge graph
- Analytics dashboard: error category distribution, trend charts, score trends, learning profile radar chart, weak area recommendations

### Other Features

- **New user onboarding** — 4-step wizard on first launch: configure API Key → test connection → feature preview → quick start guide
- **Daily review notification** — checks due review count on app startup, sends browser Notification API alert
- **Learning streak** — sidebar shows consecutive learning days and due review count badge
- **Daily learning goals** — sidebar shows progress bars for each goal type (review/exercise/reading/writing/listening)
- **Background tasks** — Writing Copilot and Reading Copilot stay mounted across navigation, status bar shows task state
- **Data management** — export CSV/Anki format, database backup (SQLite backup API)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Tauri v2 |
| Frontend | React 19, TypeScript, Vite |
| UI | shadcn/ui v4, Tailwind CSS v3, lucide-react |
| Text Model | OpenAI-compatible LLM API (configurable) |
| Voice Model | TTS + ASR (OpenAI-compatible API, configurable) |
| Graph | Cytoscape.js |
| Database | SQLite (tauri-plugin-sql) |
| Charts | recharts |
| Testing | Vitest |
| Linting | Biome |
| Git Hooks | Lefthook (pre-commit: large file check + Rust fmt/clippy + Biome; pre-push: full test suite) |

## Getting Started

### System Requirements

- Windows 10 and above

### Installation

Download the latest release from the [Releases](https://github.com/anthonysu/raven/releases) page:

- `Raven_1.6.0_x64-setup.exe` — Standard installer (recommended)
- `Raven_1.6.0_x64_en-US.msi` — MSI package

Double-click the downloaded installer and follow the setup wizard. On first launch, a guided setup will walk you through configuring API keys for both the text model and voice model.

## Development Commands

```bash
# Frontend only (Vite dev server on port 5173)
npm run dev

# Full Tauri dev (starts Vite + compiles Rust + opens desktop window)
npm run tauri dev

# Build frontend
npm run build

# Build full desktop app
npm run tauri build

# Lint
npm run lint

# Run tests
npm run test

# Add shadcn/ui components
npx shadcn@latest add <component>
```

Rust backend changes require `npm run tauri dev` (not just `npm run dev`).

## Project Structure

```
src/
├── components/          # Shared UI (KnowledgeGraph, Layout, Sidebar, ExerciseCard, VocabularySection, OnboardingDialog, etc.)
├── hooks/               # Custom hooks (useStreamChat, useAudioPlayer, usePhaseMachine, useRecording, etc.)
├── lib/                 # Utilities (db, parse-utils, task-status, type-config, fetch-utils, cache)
├── pages/               # Pages (Dashboard, Writing, Reading, Speaking, Listening, Vocabulary, Review, History, Analytics, Settings, Exercise)
├── prompts/             # LLM prompt templates (writing, reading, exercise, listening; speaking and graph prompts are inline in their pages/hooks)
├── services/            # LLM streaming service, TTS audio service, ASR speech recognition service, review notification service
├── test/                # Vitest setup and shared mock utilities
└── types/               # TypeScript interfaces

src-tauri/
├── src/                 # Rust backend (database, FSRS algorithm, export, backup)
├── migrations/          # SQLite schema (001-008)
├── capabilities/        # WebView permissions
└── tauri.conf.json      # App config
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for full history (bilingual).

## License

MIT © Anthony Su
