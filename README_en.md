# Raven

[中文](./README.md) | English

![version](https://img.shields.io/badge/version-v1.9.0-blue)
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
- Four-level self-assessment: "Don't know", "Vague", "Know", "Easy" (mapped to FSRS Again/Hard/Good/Easy ratings)
- Auto-promotion to `mastered` once review count thresholds are met ("Easy" fast-tracks promotion)
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
- **Daily learning goals** — sidebar shows progress bars for each goal type (review/weak-point training/reading/writing/listening/speaking)
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

To minimize exposure, the model list endpoint (`get_models`) does not return API keys. When editing a single model, the API key is fetched on demand from the Keychain via `db_get_model_api_key` and pre-filled, with plaintext/ciphertext toggle display.

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
- Settings table keys are validated against a unified whitelist on both read and write (`db_get_setting` / `db_set_setting`), preventing the frontend from reading or writing arbitrary key-value pairs

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
| Frontend Testing | Vitest (874 tests, 50%+ coverage) |
| Rust Testing | `#[cfg(test)]` inline unit + integration tests (142 tests) |
| Linting | Biome |
| Git Hooks | Lefthook (pre-commit: large file check + Rust fmt/clippy + Biome; pre-push: full test suite) |
| CI | GitHub Actions (Biome + tsc + Vitest coverage + cargo fmt/clippy/test) |

## Getting Started

### System Requirements

- Windows 10 and above

### Installation

Download the latest release from the [Releases](https://github.com/anthonysu/raven/releases) page:

- `Raven_1.9.0_x64-setup.exe` — Standard installer (recommended)
- `Raven_1.9.0_x64_en-US.msi` — MSI package

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

# Run tests with coverage report
npm run test:coverage

# Add shadcn/ui components
npx shadcn@latest add <component>
```

Rust backend changes require `npm run tauri dev` (not just `npm run dev`).

## Project Structure

```
src/
├── components/          # Shared UI (KnowledgeGraph, Layout, Sidebar, ExerciseCard, VocabularySection, OnboardingDialog, MarkdownContent, etc.)
├── contexts/            # React contexts (GoalsContext for shared learning goals state)
├── hooks/               # Custom hooks (useStreamChat, useAudioPlayer, usePhaseMachine, useRecording, useAbortable, useLatestRef, etc.)
├── lib/                 # Utilities (db/ data access layer, parse-utils, task-status, type-config, fetch-utils, cache, Zod schemas)
├── pages/               # Pages (Dashboard, Writing, Reading, Speaking, Listening, Vocabulary, Review, History, Analytics, Settings, Exercise; practice page reducers extracted into *-reducer.ts pure-function modules)
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
│   ├── repository/      # Data access layer (8 submodules: models/words/history/settings/learning/export/traits/mod)
│   ├── lib.rs           # App entrypoint (plugin registration + DB init + system tray + tracing logging)
│   └── main.rs          # Tauri binary entrypoint
├── migrations/          # SQLite schema migrations (001-009)
├── capabilities/        # WebView permissions (HTTP domain whitelist, etc.)
└── tauri.conf.json      # App config
```

## Testing

### Frontend Tests (Vitest)

```bash
npm test                # Run all tests
npm run test:watch      # Watch mode
```

Currently covers **874 tests** across 60 test files, with **50%+** statement coverage:

- `src/lib/parse-utils.test.ts` — JSON parsing, answer matching, section splitting, `extractJsonSafe` Zod schema validation
- `src/lib/fetch-utils.test.ts` — `smartFetch` dual-channel fetch + timeout + AbortSignal + `delayWithAbort`
- `src/lib/cache.test.ts` — `createCachedFetcher` cache + FIFO eviction + invalidation
- `src/lib/db.test.ts` — Database utility functions (`getLocalDate`, `aggregateCorrections`, `countStreak`)
- `src/lib/error-utils.test.ts` — Error message extraction
- `src/lib/schemas.test.ts` — Zod schema runtime validation (LLM JSON responses)
- `src/lib/type-config.test.ts` — Error category → exercise type mapping
- `src/lib/task-status.test.ts` — Background task state machine
- `src/lib/utils.test.ts` — Utility functions (`cn`, `getScoreColor`, `getScoreBgColor`)
- `src/lib/word-utils.test.ts` — Word utility functions
- `src/lib/csv-utils.test.ts` — CSV parsing utilities
- `src/lib/analytics.test.ts` — Analytics utility functions
- `src/lib/db/models.test.ts` — Model DB operations
- `src/lib/db/words.test.ts` — Vocabulary DB operations
- `src/lib/db/history.test.ts` — History DB operations
- `src/lib/db/learning.test.ts` — Learning DB operations
- `src/lib/db/review.test.ts` — Review DB operations
- `src/lib/db/settings.test.ts` — Settings DB operations
- `src/lib/db/tts.test.ts` — TTS DB operations
- `src/hooks/use-abortable.test.ts` — `useAbortable` cancellable async hook
- `src/hooks/use-stream-chat.test.ts` — LLM streaming hook
- `src/hooks/use-llm-stream-page.test.ts` — LLM streaming page integration
- `src/hooks/use-phase-machine.test.ts` — Phase state machine
- `src/hooks/use-recording.test.ts` — Microphone recording hook
- `src/hooks/use-theme.test.tsx` — Theme toggle hook
- `src/hooks/use-add-to-vocabulary.test.ts` — Vocabulary hook
- `src/contexts/GoalsContext.test.tsx` — Learning goals context (goalsToRecord + provider behavior)
- `src/pages/DashboardPage.test.tsx` — Dashboard page
- `src/pages/ExercisePage.test.tsx` — Weak point training page
- `src/pages/CorrectPage.test.tsx` — Writing training page
- `src/pages/ReadingPage.test.tsx` — Reading training page
- `src/pages/SpeakingPage.test.tsx` — Speaking training page
- `src/pages/SpeakingReducer.test.ts` — Speaking reducer pure functions
- `src/pages/ListeningPage.test.tsx` — Listening training page
- `src/pages/ListeningReducer.test.ts` — Listening reducer pure functions
- `src/pages/HistoryPage.test.tsx` — History page
- `src/pages/VocabularyPage.test.tsx` — Vocabulary notebook page
- `src/pages/ReviewPage.test.tsx` — Review flashcard page
- `src/pages/SettingsPage.test.tsx` — Settings page
- `src/pages/settings/ModelCard.test.tsx` — Text model settings
- `src/pages/settings/VoiceCard.test.tsx` — Voice model settings
- `src/pages/settings/GoalCard.test.tsx` — Learning goals settings
- `src/pages/settings/ThemeCard.test.tsx` — Appearance settings
- `src/pages/settings/AboutCard.test.tsx` — About page
- `src/pages/settings/BackupCard.test.tsx` — Data backup
- `src/pages/settings/NotificationCard.test.tsx` — Notification settings
- `src/pages/settings/voice-reducer.test.ts` — Voice settings reducer
- `src/components/Sidebar.test.tsx` — Sidebar navigation
- `src/components/Layout.test.tsx` — Layout component
- `src/components/OnboardingDialog.test.tsx` — New user onboarding wizard
- `src/components/PersistentRoutes.test.tsx` — Persistent routing
- `src/components/SpeakButton.test.tsx` — Read-aloud button
- `src/components/InlineErrorBoundary.test.tsx` — Inline error boundary
- `src/components/analytics/StatCard.test.tsx` — Stat card
- `src/prompts/speaking.test.ts` — Speaking prompt templates
- `src/prompts/listening.test.ts` — Listening prompt templates
- `src/services/llm.test.ts` — LLM service layer
- `src/services/notifications.test.ts` — Review notification service
- `src/services/tts.test.ts` — TTS speech synthesis service
- `src/services/asr.test.ts` — ASR speech recognition service (WAV encoding + transcription)

### Rust Tests

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Inline `#[cfg(test)]` modules cover pure-function logic and database integration tests (via in-memory SQLite), currently **142 tests**:

- `repository::words` — Vocabulary CRUD, input validation, review stats, FSRS atomic update (20 tests)
- `repository::history` — History CRUD, type filtering, pagination, clamping (14 tests)
- `repository::settings` — Key-value CRUD, TTS config queries (7 tests)
- `repository::learning` — Learning streaks, goals, sidebar aggregation, streak computation (19 tests)
- `repository::models` — Model config CRUD, default model management (9 tests)
- `repository::export` — CSV/Anki sanitization functions, CSV/Anki export integration tests (17 tests)
- `repository::mod` — Enum validation (`validate_review_status` / `validate_record_type` / `validate_goal_type`) (10 tests)
- `error::tests` — `From` conversions, `Display` output, `Serialize` structure (7 tests)
- `fsrs::tests` — FSRS state transitions, lapse counting, stability growth, enum conversions (6 tests)
- `db::tests` — Base64 decoding, test DB creation and isolation (5 tests)
- `commands::*` — Command layer unit tests (routing, mocks, input validation) (28 tests)

> **Windows developers note**: `build.rs` wraps `tauri_build::build()` in `std::panic::catch_unwind` to catch the Windows Resource Compiler (rc.exe) `std::process` pipe race panic (`Os { code: 0 }`). This panic does not affect library compilation — it only skips the icon/manifest embedding step. When running `cargo test`, you will see a `cargo:warning` message; this is expected and tests will run normally.

### Type Checking & Lint

```bash
npx tsc -b                         # TypeScript type check (project references, matches build/CI)
cargo check --manifest-path src-tauri/Cargo.toml   # Rust type check
npm run lint                       # Biome lint
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for full history (bilingual).

## License

MIT © Anthony Su
