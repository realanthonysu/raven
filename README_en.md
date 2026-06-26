# Raven

[中文](./README.md) | English

![version](https://img.shields.io/badge/version-v1.8.1-blue)
![platform](https://img.shields.io/badge/platform-Windows-blue)
![built with](https://img.shields.io/badge/built%20with-Tauri%202-orange)

**AI-powered English learning desktop assistant** — designed around the four core skills of listening, speaking, reading, and writing. Built with Tauri v2 + React + TypeScript.

Supports two types of models: **text models** (LLM, powering all analysis and generation) and **voice models** (TTS for speech synthesis + ASR for speech recognition), forming a complete learning loop from input to output.

## Table of Contents

- [Features](#features)
- [Security](#security)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Development Commands](#development-commands)
- [Project Structure](#project-structure)
- [Testing](#testing)
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
- **Data management** — export CSV/Anki format, database backup (SQLite backup API with destination existence check)
- **System tray** — minimize to tray on window close instead of exiting; left-click tray icon restores window
- **Review queue persistence** — ReviewPage persists current review queue to localStorage for interruption recovery
- **Analytics time range filter** — AnalyticsPage supports 7/30/90 day time range toggle
- **Structured errors** — backend `AppError` carries `category` (database/credential/export/io) and `message` fields, enabling frontend branching by category

## Security

### API Key Storage

API Keys are no longer stored in SQLite as plaintext or Base64 — they are written to the **OS Keychain** via the `keyring` crate:

- Windows: Credential Manager
- macOS: Keychain
- Linux: Secret Service (GNOME Keyring / KWallet)

Each model's API Key is stored under the `raven` service with account name `model_{id}`; the TTS API Key uses account name `tts`. Even if the database file leaks, attackers cannot obtain API Keys.

The model list endpoint (`get_models`) **does not return the `api_key` field**; a dedicated `get_model_api_key` command reads it on demand when editing a model.

### HTTP Permissions

WebView HTTP request permissions (`capabilities/default.json`) use a layered strategy:

- **HTTPS remains open** (`https://**`) — users can configure any OpenAI-compatible endpoint (Mistral / Groq / Together AI / self-hosted LLM, etc.)
- **HTTP restricted to loopback** (`127.0.0.1` / `localhost`) — prevents SSRF to internal HTTP services (routers, cloud metadata services), while preserving local deployment support (Ollama, etc.)

### Export Sanitization

- **CSV export** — formula injection defense for user-controlled fields: cells starting with `=` `+` `-` `@` are prefixed with a single quote `'`, preventing Excel/LibreOffice from interpreting them as executable formulas
- **Anki export** — HTML special characters (`&` `<` `>`) are escaped to prevent Anki card rendering issues or XSS; Tab/newline are replaced with spaces to prevent field misalignment

### Database Integrity

- `PRAGMA foreign_keys=ON` is enabled during connection initialization
- Model add/update uses a "commit DB transaction first, then write Keychain" strategy: if Keychain write fails, the just-inserted DB row is deleted as compensation, avoiding orphan records without keys
- Backup destination path existence check prevents overwriting existing files
- Backend enum fields (`review_status` / `record_type` / `goal_type`) are validated against allowed values before insertion, preventing front-end-supplied illegal enums from corrupting query semantics

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Tauri v2 |
| Frontend | React 19, TypeScript, Vite |
| UI | shadcn/ui v4, Tailwind CSS v3, lucide-react |
| Text Model | OpenAI-compatible LLM API (configurable) |
| Voice Model | TTS + ASR (OpenAI-compatible API, configurable) |
| Graph | Cytoscape.js |
| Database | SQLite (rusqlite + r2d2 connection pool, WAL mode) |
| Credential Storage | OS Keychain (`keyring` crate) |
| Structured Logging | `tracing` + `tracing-subscriber` (env-filter) |
| Schema Validation | Zod v4 (runtime validation of LLM JSON responses) |
| Error Handling | `AppError` structured error type + `thiserror` |
| Charts | recharts |
| Frontend Testing | Vitest (231 tests) |
| Rust Testing | `#[cfg(test)]` inline unit tests (34 tests) |
| Linting | Biome |
| Git Hooks | Lefthook (pre-commit: large file check + Rust fmt/clippy + Biome; pre-push: full test suite) |

## Getting Started

### System Requirements

- Windows 10 and above

### Installation

Download the latest release from the [Releases](https://github.com/anthonysu/raven/releases) page:

- `Raven_1.8.1_x64-setup.exe` — Standard installer (recommended)
- `Raven_1.8.1_x64_en-US.msi` — MSI package

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
├── hooks/               # Custom hooks (useStreamChat, useAudioPlayer, usePhaseMachine, useRecording, useAbortable, useLatestRef, etc.)
├── lib/                 # Utilities (db, parse-utils, task-status, type-config, fetch-utils, cache, Zod schemas)
├── pages/               # Pages (Dashboard, Writing, Reading, Speaking, Listening, Vocabulary, Review, History, Analytics, Settings, Exercise)
├── prompts/             # LLM prompt templates (writing, reading, exercise, listening, speaking; graph prompts are inline in their hooks)
├── services/            # LLM streaming service, TTS audio service, ASR speech recognition service, review notification service
├── test/                # Vitest setup and shared mock utilities
└── types/               # TypeScript interfaces

src-tauri/
├── src/
│   ├── commands/        # Tauri Command handlers (split into 7 domain submodules)
│   │   ├── models.rs    # Model config (CRUD + default + Keychain integration)
│   │   ├── words.rs     # Vocabulary (CRUD + review stats + FSRS update)
│   │   ├── history.rs   # History records (CRUD + graph data update)
│   │   ├── settings.rs  # Generic settings + TTS config
│   │   ├── learning.rs  # Learning streak + daily goals
│   │   ├── fsrs.rs      # FSRS spaced repetition algorithm entry
│   │   ├── export.rs    # CSV/Anki export + DB backup
│   │   ├── shared.rs    # Shared DTO types
│   │   └── mod.rs        # Submodule re-exports
│   ├── credentials.rs   # OS Keychain credential storage (keyring crate wrapper)
│   ├── db.rs            # SQLite connection pool (r2d2) + migration runner + WAL mode
│   ├── error.rs         # AppError structured error type + From conversions
│   ├── fsrs.rs          # FSRS algorithm implementation (FsrsState enum + unit tests)
│   ├── repository.rs    # Data access layer (SQL queries + enum validation + CSV/Anki sanitization)
│   ├── lib.rs           # App entrypoint (plugin registration + DB init + system tray + tracing logging)
│   └── main.rs          # Tauri binary entrypoint
├── migrations/          # SQLite schema migrations (001-008)
├── capabilities/        # WebView permissions (HTTP domain whitelist, etc.)
└── tauri.conf.json      # App config
```

## Testing

### Frontend Tests (Vitest)

```bash
npm test                # Run all tests
npm run test:watch      # Watch mode
```

Currently covers **231 tests** across 12 test files:

- `src/lib/parse-utils.test.ts` — JSON parsing, answer matching, section splitting, `extractJsonSafe` Zod schema validation
- `src/lib/fetch-utils.test.ts` — `smartFetch` dual-channel fetch + timeout + AbortSignal
- `src/lib/cache.test.ts` — `createCachedFetcher` cache + FIFO eviction + invalidation
- `src/lib/type-config.test.ts` — Error category → exercise type mapping
- `src/lib/task-status.test.ts` — Background task state machine
- `src/hooks/use-abortable.test.ts` — `useAbortable` cancellable async hook
- `src/hooks/use-stream-chat.test.ts` — LLM streaming hook
- `src/hooks/use-llm-stream-page.test.ts` — LLM streaming page integration
- `src/hooks/use-phase-machine.test.ts` — Phase state machine
- `src/pages/ExercisePage.test.tsx` — Weak point training page
- `src/pages/ReviewPage.test.tsx` — Review flashcard page
- `src/services/llm.test.ts` — LLM service layer

### Rust Tests

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Inline `#[cfg(test)]` modules cover pure-function logic (no DB / Keychain dependencies), currently **34 tests**:

- `repository::tests` — enum validation (`validate_review_status` / `validate_record_type` / `validate_goal_type`), CSV formula injection defense (`sanitize_csv_cell`), Anki HTML escaping (`sanitize_anki_cell`)
- `error::tests` — `From<io::Error>` / `From<rusqlite::Error>` / `From<keyring::Error>` conversions, `Display` output, `Serialize` structure (`category` + `message` two fields)
- `fsrs::tests` — FSRS first-review state transitions, lapse counting, stability growth, `next_review_at` local timezone, status string mapping, `FsrsState` enum bidirectional conversion

> **Windows developers note**: `build.rs` wraps `tauri_build::build()` in `std::panic::catch_unwind` to catch the Windows Resource Compiler (rc.exe) `std::process` pipe race panic (`Os { code: 0 }`). This panic does not affect library compilation — it only skips the icon/manifest embedding step. When running `cargo test`, you will see a `cargo:warning` message; this is expected and tests will run normally.

### Type Checking & Lint

```bash
npx tsc --noEmit                   # TypeScript type check
cargo check --manifest-path src-tauri/Cargo.toml   # Rust type check
npm run lint                       # Biome lint
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for full history (bilingual).

## License

MIT © Anthony Su
