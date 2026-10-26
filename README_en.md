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

### Level Placement & Progression

A CEFR ruler (A2 / B1 / B1+ / B2 / B2+ / C1) with Chinese exam anchors for display (中考 / 高考 / CET-4 / CET-6 / TEM-4 / TEM-8 / IELTS·TOEFL) provides one difficulty standard across all training:

- **Level selection** — self-report during onboarding, adjustable anytime under Settings → English Level; changes take effect immediately, while history keeps the level used at generation time
- **AI placement test** — 12 single-choice questions of increasing difficulty (six bands × 2 each), scored locally by rule (cumulative low→high correctness ≥60% determines the highest passed band), with per-band accuracy and a one-click "apply as current level"
- **Difficulty gradient** — writing correction, reading analysis, and weak-point exercises inject level-specific vocabulary range, sentence length, grammar scope, and passage length into their prompts; speaking/listening difficulty options are derived from the current level (one step down / standard / challenge)
- **Writing level estimate** — every correction includes an estimated band (e.g. B2) with a one-sentence rationale, also shown on the history detail page
- **Passive estimation** — deterministically estimates per-skill levels (writing / reading / exercise / listening / speaking) from real practice data (recency-weighted, score-adjusted), with confidence and sample size; estimates are recommendations only and never auto-apply
- **Vocabulary levels** — the notebook auto-tags words with an 11-value exam level and shows per-level mastery stats

### Writing Copilot

Paste English text for grammar correction and writing suggestions.

- Error identification with categories (subject-verb agreement, tense, articles, spelling, etc.)
- Writing improvement tips
- One-click copy corrected text or replace input
- Corrections can be added to vocabulary notebook with auto LLM enrichment
- Correction baseline and advice focus follow the current level, plus a level estimate with rationale for each piece

### Reading Copilot

Paste an English article for deep reading analysis with six dimensions:

1. **Translation** — full Chinese translation
2. **Key Vocabulary** — 5-8 words with phonetics, collocations, and examples
3. **Sentence Breakdown** — complex sentence structure analysis (max 10)
4. **Grammar Analysis** — grammar point extraction (max 10)
5. **Background & Techniques** — domain context + translation techniques
6. **Extended Thinking** — critical thinking and open questions

Vocabulary rarity, complex-sentence selection, and grammar depth follow the current level.

Plus an interactive **knowledge graph** (Cytoscape.js) with bilingual toggle and fullscreen mode. After analysis, click the "New Article" button to reset and start a new reading.

### Speaking Practice

Read-along sentence practice with AI scoring:

- LLM generates sentences — difficulty derives from the current level (one step down / standard / challenge) and can be switched freely; topics include daily conversation, business English, travel, technology, campus life, and interview self-introduction
- Record and read along — record sentence by sentence, ASR transcribes your speech
- AI scoring — LLM compares the original with your transcription, scores on accuracy, fluency, and pronunciation, with improvement suggestions

### Listening Practice

TTS plays sentences, user dictates, AI auto-scores:

- LLM generates sentences — difficulty follows the current level by default, switchable between one step down / standard / challenge; topic selectable
- TTS playback — multiple voices and speed settings
- Dictation input — type what you hear
- Auto scoring — word-level comparison between original and dictation, precise scoring
- Vocabulary extraction — extract key words from wrong sentences and add to notebook with one click

### Vocabulary Notebook

Save words from reading/writing/listening assistants by clicking or via the "Add to notebook" button. Words carry an exam-level tag (小学 / 中考 / 高考 / CET-4 / CET-6 / 考研 / TEM-4 / TEM-8 / IELTS / TOEFL / beyond-syllabus), auto-tagged by the LLM during enrichment and manually editable; auto-tagging never overwrites a manual tag.

- Manual vocabulary entry (auto LLM enrichment for phonetic, definition, collocations, example)
- CSV/TXT batch import (RFC 4180 quoted fields, auto-dedup, auto-enrichment)
- Export as CSV or Anki import format (Tab-separated)
- Single/batch enrichment for missing data
- Per-level mastery stats — word counts and new/learning/mastered distribution by level

### Spaced Repetition Review

Flip-card interface with FSRS (Free Spaced Repetition Scheduler) algorithm:

- Front: word + phonetic; Back: definition, collocations, example
- Four-level self-assessment: "Don't know", "Vague", "Know", "Easy" (mapped to FSRS Again/Hard/Good/Easy ratings)
- Auto-promotion to `mastered` once review count thresholds are met ("Easy" fast-tracks promotion)
- FSRS algorithm dynamically computes review intervals based on memory stability and difficulty
- Only shows words due for review

### Weak Point Training

Automatically identifies weak areas from writing correction data and generates targeted exercises:

- Smart recommendation — analyzes recent correction sessions to identify high-frequency error categories
- Diverse question types — fill-in-the-blank (tense/SVA/plurals), error correction (articles/prepositions), sentence rewriting (word choice/syntax)
- Unified review — shows all answers with correct answers and detailed explanations after completion
- Level-aware authoring — question vocabulary and grammar points follow the current level
- History tracking — exercise results persisted and viewable from history

### History & Analytics

- All learning records saved to SQLite with type filtering (Writing/Reading/Speaking/Listening/Exercise)
- Paginated loading (20 per page), detail page with expandable cards and knowledge graph
- Analytics dashboard: error category distribution, trend charts, score trends, learning profile radar chart, weak area recommendations, and a **per-skill level radar** (confidence, sample size, average score, and upgrade suggestions)

### Other Features

- **New user onboarding** — 6-step wizard on first launch: welcome → configure MiMo text API (with connection test) → select English level → configure voice (TTS/ASR) → feature preview → finish
- **Daily review notification** — checks due review count on app startup, sends a native system notification (Tauri notification plugin)
- **Learning streak** — sidebar shows consecutive learning days and due review count badge
- **Daily learning goals** — sidebar shows progress bars for each goal type (review/weak-point training/reading/writing/listening/speaking)
- **Background tasks** — Writing Copilot and Reading Copilot stay mounted across navigation, status bar shows task state
- **Data management** — CSV/Anki export and database backup go through a native save dialog (any location), with a one-click backup to the default Documents/Raven location; database restore from a backup file is supported (auto snapshot before restore, app state auto-reloaded after)
- **System tray** — minimize to tray on window close instead of exiting; left-click tray icon restores window
- **Review queue persistence** — ReviewPage persists current review queue to localStorage for interruption recovery
- **Analytics time range filter** — AnalyticsPage supports 7/30/90 day / all-time range toggle
- **Structured errors** — backend `AppError` carries `category` (database/validation/credential/network/export/io) and `message` fields, enabling frontend branching by category

## Security

### API Key Storage

API Keys are no longer stored in SQLite as plaintext or Base64 — they are written to the **OS Keychain** via the `keyring` crate:

- Windows: Credential Manager
- macOS: Keychain
- Linux: Secret Service (GNOME Keyring / KWallet)

Each model's API Key is stored under the `raven` service with account name `model_{id}`; the TTS API Key uses account name `tts`. Even if the database file leaks, attackers cannot obtain API Keys.

To minimize exposure, the model list endpoint (`get_models`) does not return API keys. When editing a single model, the API key is fetched on demand from the Keychain via `get_model_api_key` and pre-filled, with plaintext/ciphertext toggle display.

### HTTP Permissions & LLM Proxy

- **LLM requests go through the Rust proxy** (`commands/proxy.rs`) — uses `reqwest` for SSE streaming; API keys are read from the OS Keychain and never reach the WebView. Tokens are pushed back via a Tauri `Channel`. Business errors (timeouts, network failures, API 4xx/5xx) are also delivered over the Channel, and the command returns `Ok(())` to avoid race conditions with `invoke` reject.
- **TTS/ASR requests go through the Rust proxy with server-side config** (`commands/proxy.rs`) — formal TTS/ASR requests (`fetch_tts_audio` / `transcribe_audio`) have their config (base_url/model/voice) and keys read server-side by the proxy command (DB `settings` table + OS Keychain); the frontend no longer passes base_url. The TTS preview command `test_tts_audio` accepts an unsaved base_url and a form-entered key from the frontend (validated against private-network ranges) for verifying new settings on the settings page.
- **Explicit key-exposure exemption list** — the following three commands deliberately return plaintext keys to the frontend (documented in the `commands/proxy.rs` module doc): `get_model_api_key` (edit-form prefill of a stored key), `db_get_tts_config` (settings-form prefill of the saved key, used only for form display and the TTS preview path — preview may pass a form-entered key or read from the Keychain server-side), and `db_get_default_model` (default-model lookup fills in the key: the WebView fallback request path needs it for the Authorization header, and the frontend treats a non-empty key as "model configured"). Any new command returning a key must be added to that list.
- **WebView HTTP restricted to local loopback** (`capabilities/default.json`: `http://127.0.0.1` / `http://localhost`) — the frontend no longer connects directly to arbitrary HTTPS endpoints (LLM, TTS, ASR, and connection testing have all migrated to the Rust proxy). Only the fallback path (when the proxy is unavailable) and local loopback capabilities are retained, preventing SSRF to internal HTTP services (routers, cloud metadata services) while preserving local deployment support (Ollama, etc.).

### Export Sanitization

- **CSV export** — formula injection defense for user-controlled fields: cells starting with `=` `+` `-` `@` are prefixed with a single quote `'`, preventing Excel/LibreOffice from interpreting them as executable formulas
- **Anki export** — HTML special characters (`&` `<` `>`) are escaped to prevent Anki card rendering issues or XSS; Tab/newline are replaced with spaces to prevent field misalignment

### Database Integrity

- `PRAGMA foreign_keys=ON` is enabled during connection initialization
- Model creation uses a "commit DB transaction first, then write Keychain" strategy: if the Keychain write fails, the just-inserted DB row is deleted as compensation, avoiding orphan records without keys. Model updates wrap the existence check and UPDATE statements in a single `BEGIN IMMEDIATE` transaction (race-free); if the Keychain write fails after commit, an error is returned prompting the user to re-edit
- SQLite errors are sanitized in the `From<rusqlite::Error>` conversion: the full error is logged in the main process only, while the frontend receives a generic message without SQL fragments or table names
- Backup destinations are created atomically (`create_new`): an existing file is an error (closing the TOCTOU window between an exists-check and creation), preventing overwrites and data loss
- Backend enum fields (`review_status` / `record_type` / `goal_type`) are validated against allowed values before insertion, preventing front-end-supplied illegal enums from corrupting query semantics
- Settings table keys are validated against a unified whitelist on both read and write (`db_get_setting` / `db_set_setting`), preventing the frontend from reading or writing arbitrary key-value pairs

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Tauri v2 |
| Frontend | React 19, TypeScript, Vite |
| UI | shadcn/ui v4, Tailwind CSS v4, lucide-react |
| Text Model | **MiMo** (recommended, mimo-v2.5 / mimo-v2.5-pro) · also OpenAI / DeepSeek / Ollama |
| Voice Model | **MiMo TTS + ASR** (mimo-v2.5-tts / mimo-v2.5-asr) · also OpenAI-compatible TTS |
| Graph | Cytoscape.js |
| Database | SQLite (rusqlite + r2d2 connection pool, WAL mode) |
| Credential Storage | OS Keychain (`keyring` crate) |
| Structured Logging | `tracing` + `tracing-subscriber` (env-filter) |
| Schema Validation | Zod v4 (runtime validation of LLM JSON responses) |
| Error Handling | `AppError` structured error type + `thiserror` |
| Charts | recharts |
| Frontend Testing | Vitest (1516 tests across 102 test files, ~84% statement coverage, thresholds in vite.config.ts) |
| Rust Testing | `#[cfg(test)]` inline unit + integration tests (255 tests) |
| Linting | Biome |
| Git Hooks | Lefthook (pre-commit: large file check + Rust fmt/clippy + Biome; pre-push: tsc typecheck + full frontend test suite + Rust tests) |
| CI | GitHub Actions (Biome + tsc + Vitest coverage + cargo fmt/clippy/test) |

## Getting Started

### System Requirements

- Windows 10 and above

### Installation

Download the latest release from the [Releases](https://github.com/anthonysu/raven/releases) page:

- `Raven_1.9.0_x64-setup.exe` — Standard installer (recommended)
- `Raven_1.9.0_x64_en-US.msi` — MSI package

Double-click the downloaded installer and follow the setup wizard. On first launch, a 6-step guide walks you through setup:

1. **Configure the text model (MiMo recommended)** — Sign up / sign in at the [MiMo Open Platform](https://platform.xiaomimimo.com) and copy your API Key. In the guide, pick the **MiMo** preset (`https://api.xiaomimimo.com/v1`, model `mimo-v2.5` or `mimo-v2.5-pro`), paste the key, then click **Test connection**.
2. **Select your English level** — pick the exam/stage you recognize (primary/middle school, 高考, CET-4, CET-6, TEM-4, TEM-8/IELTS·TOEFL); all training content adjusts to it. Skippable — change later under **Settings → English Level**.
3. **Configure voice (TTS/ASR)** — The same key works for both. Recommended: TTS `mimo-v2.5-tts` (voices such as "冰糖" / "Mia") + ASR `mimo-v2.5-asr`. You can skip this and finish later under **Settings → Voice**.
4. **Preview / Finish** — Review the feature tour and start learning.

Non-MiMo users can choose the OpenAI / DeepSeek presets, or Ollama (`http://localhost:11434/v1`).

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
├── components/          # Shared UI (KnowledgeGraph, Layout, Sidebar, ExerciseCard, VocabularySection, OnboardingDialog, MarkdownContent, LevelEstimateBadge; analytics/LevelProgressCard, placement/PlacementTestDialog, etc.)
├── contexts/            # React contexts (GoalsContext for shared learning goals state)
├── hooks/               # Custom hooks (useStreamChat, useLLMStreamPage, useAudioPlayer, usePhaseMachine, useRecording, useAbortable, useReadAloud, useGraphData, useStaleGuard, etc.; level system: useProficiencyLevel / useLevelEstimation / usePlacementTest / useEffectivePracticeLevel; useAnalytics/ subfolder with an index entry + 6 analytics sub-hooks)
├── lib/                 # Utilities (db/ data access layer, parse-utils, task-status, type-config, fetch-utils, cache, Zod schemas, CSV utils, exercise stats, history presentation registry; level system: levels ruler, level-estimation engine, level-estimation-samples normalization core)
├── pages/               # Pages (Dashboard, Writing, Reading, Speaking, Listening, Vocabulary, Review, History, Analytics, Settings, Exercise; practice page reducers extracted into *-reducer.ts pure-function modules; settings/ subfolder with 9 settings cards; speaking/ and vocabulary/ subfolders for the per-sentence session pipeline and vocabulary import logic)
├── prompts/             # LLM prompt templates (writing, reading (incl. language detection / knowledge graph / summary), exercise, listening, speaking, vocabulary enrichment, placement test)
├── services/            # LLM streaming service, TTS audio service, ASR speech recognition service, vocabulary enrichment service (vocabulary-enrichment), review notification service
├── test/                # Vitest setup and shared mock utilities
└── types/               # TypeScript interfaces

src-tauri/
├── src/
│   ├── commands/        # Tauri Command handlers (split into 12 files: 7 domain modules + sse/proxy/ssrf/shared/mod)
│   │   ├── models.rs    # Model config (CRUD + default + Keychain integration)
│   │   ├── words.rs     # Vocabulary (CRUD + review stats + FSRS update)
│   │   ├── history.rs   # History records (CRUD + graph data update)
│   │   ├── settings.rs  # Generic settings + TTS config
│   │   ├── learning.rs  # Learning streak + daily goals
│   │   ├── fsrs.rs      # FSRS spaced repetition algorithm entry
│   │   ├── export.rs    # CSV/Anki export + DB backup/restore (incl. native-dialog paths)
│   │   ├── proxy.rs     # LLM/TTS/ASR request proxy (reqwest + post_json transport helper, keys stay in the main process)
│   │   ├── sse.rs       # SSE streaming parser engine (line splitting + multi-byte UTF-8 cross-chunk decoding)
│   │   ├── ssrf.rs      # SSRF validation (private-range reject / loopback allow, IPv4-embeddable IPv6 prefixes, DNS-rebinding recheck)
│   │   ├── shared.rs    # Shared DTO types + row mappers + with_db!/with_db_read! macros
│   │   └── mod.rs        # Submodule re-exports
│   ├── credentials.rs   # OS Keychain credential storage (keyring crate wrapper)
│   ├── db.rs            # SQLite connection pool (r2d2) + migration runner + WAL mode
│   ├── error.rs         # AppError structured error type + From conversions
│   ├── fsrs.rs          # FSRS algorithm implementation (FsrsState enum + unit tests)
│   ├── repository/      # Data access layer (7 submodules: models/words/history/settings/learning/export/mod)
│   ├── lib.rs           # App entrypoint (plugin registration + DB init + system tray + tracing logging)
│   └── main.rs          # Tauri binary entrypoint
├── migrations/          # SQLite schema migrations (001-014)
├── capabilities/        # WebView permissions (loopback-only HTTP allowlist, etc.)
└── tauri.conf.json      # App config
```

## Testing

### Frontend Tests (Vitest)

```bash
npm test                # Run all tests
npm run test:watch      # Watch mode
```

Currently covers **1516 tests** across 102 test files, with **~84%** statement coverage:

- `src/lib/parse-utils.test.ts` — JSON parsing, answer matching, section splitting, `extractJsonSafe` Zod schema validation
- `src/lib/fetch-utils.test.ts` — `smartFetch` dual-channel fetch + timeout + AbortSignal + `delayWithAbort`
- `src/lib/request-utils.test.ts` — Request guards (`guardedInvoke` timeout/abort boilerplate, `raceWithAbort` per-waiter abort bridge)
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
- `src/lib/exercise-stats.test.ts` — Exercise stats (mastery weighting, missed-word extraction)
- `src/lib/history-presentation.test.ts` — History presentation registry (type → summary/score copy)
- `src/lib/vocabulary-parser.test.ts` — Vocabulary entry parsing utilities
- `src/lib/levels.test.ts` — Level ruler (code validation, spec completeness, practice option derivation, prompt spec block)
- `src/lib/practice-options.test.ts` — Practice difficulty label formatting (level code ≈ exam-anchor dual annotation, legacy passthrough)
- `src/lib/level-estimation.test.ts` — Level estimation engine (recency decay, score adjustment, confidence, suggestions, placement scoring)
- `src/lib/db/models.test.ts` — Model DB operations
- `src/lib/db/words.test.ts` — Vocabulary DB operations
- `src/lib/db/history.test.ts` — History DB operations
- `src/lib/db/learning.test.ts` — Learning DB operations
- `src/lib/db/review.test.ts` — Review DB operations
- `src/lib/db/settings.test.ts` — Settings DB operations
- `src/lib/db/tts.test.ts` — TTS DB operations
- `src/lib/db/utils.test.ts` — Data-access layer shared pure functions and DTO types
- `src/hooks/use-abortable.test.ts` — `useAbortable` cancellable async hook
- `src/hooks/use-stream-chat.test.ts` — LLM streaming hook
- `src/hooks/use-llm-stream-page.test.ts` — LLM streaming page integration
- `src/hooks/use-phase-machine.test.ts` — Phase state machine
- `src/hooks/use-recording.test.ts` — Microphone recording hook
- `src/hooks/use-audio-player.test.ts` — TTS audio playback hook (AbortController + state management)
- `src/hooks/use-theme.test.tsx` — Theme toggle hook
- `src/hooks/use-add-to-vocabulary.test.ts` — Vocabulary hook
- `src/hooks/use-hidden-effect.test.tsx` — Persistent-page hidden-state hook
- `src/hooks/use-level-estimation.test.ts` — Passive level estimation (normalization, level fallback, defensive sorting, suggestions)
- `src/hooks/use-placement-test.test.ts` — AI placement test lifecycle (generation, invalid-question filtering, score persistence, apply)
- `src/hooks/use-proficiency-level.test.ts` — Global level reactive store (hydration and manual-set precedence)
- `src/hooks/use-effective-practice-level.test.ts` — Listening/speaking level derivation and submit-time pinning
- `src/hooks/use-stale-guard.test.ts` — Stale-response guard (late results from an older submission are dropped)
- `src/hooks/use-graph-data.test.ts` — Knowledge graph data loading
- `src/hooks/use-language-detection.test.ts` — Language detection
- `src/hooks/use-analytics/index.test.ts` — useAnalytics entry hook
- `src/hooks/use-analytics/use-exercise-analytics.test.ts` — Exercise analytics sub-hook
- `src/hooks/use-analytics/use-writing-analytics.test.ts` — Writing correction analytics sub-hook
- `src/hooks/use-analytics/use-level-analytics.test.ts` — Per-skill level estimation sub-hook
- `src/hooks/use-analytics/use-listening-speaking-analytics.test.ts` — Listening/speaking score trends
- `src/hooks/use-analytics/use-recent-sessions.test.ts` — Recent learning session aggregation
- `src/contexts/GoalsContext.test.tsx` — Learning goals context (goalsToRecord + provider behavior)
- `src/pages/DashboardPage.test.tsx` — Dashboard page
- `src/pages/ExercisePage.test.tsx` — Weak point training page
- `src/pages/ExerciseReducer.test.ts` — Weak point training reducer pure functions
- `src/pages/CorrectPage.test.tsx` — Writing training page
- `src/pages/ReadingPage.test.tsx` — Reading training page
- `src/pages/SpeakingPage.test.tsx` — Speaking training page
- `src/pages/SpeakingReducer.test.ts` — Speaking reducer pure functions
- `src/pages/ListeningPage.test.tsx` — Listening training page
- `src/pages/ListeningReducer.test.ts` — Listening reducer pure functions
- `src/pages/speaking/use-speaking-session.test.ts` — Speaking per-sentence media pipeline hook
- `src/pages/vocabulary/use-add-word.test.ts` — Manual word addition (level pass-through)
- `src/pages/vocabulary/use-batch-enrich.test.ts` — Batch enrichment (failure counting and summary downgrade)
- `src/pages/vocabulary/use-batch-runner.test.ts` — Batch run skeleton (single-flight mutex)
- `src/pages/vocabulary/use-vocabulary-import.test.ts` — CSV/TXT import (full dedup and failure counting)
- `src/pages/HistoryPage.test.tsx` — History page
- `src/pages/HistoryDetailPage.test.tsx` — History detail page
- `src/pages/VocabularyPage.test.tsx` — Vocabulary notebook page
- `src/pages/ReviewPage.test.tsx` — Review flashcard page
- `src/pages/SettingsPage.test.tsx` — Settings page
- `src/pages/AnalyticsPage.test.tsx` — Analytics dashboard page
- `src/pages/settings/ModelCard.test.tsx` — Text model settings
- `src/pages/settings/VoiceCard.test.tsx` — Voice model settings
- `src/pages/settings/GoalCard.test.tsx` — Learning goals settings
- `src/pages/settings/ReviewCard.test.tsx` — Review settings
- `src/pages/settings/ThemeCard.test.tsx` — Appearance settings
- `src/pages/settings/AboutCard.test.tsx` — About page
- `src/pages/settings/BackupCard.test.tsx` — Data backup
- `src/pages/settings/NotificationCard.test.tsx` — Notification settings
- `src/pages/settings/LevelCard.test.tsx` — English level settings (self-report, passive estimates, AI placement test entry)
- `src/pages/settings/voice-reducer.test.ts` — Voice settings reducer
- `src/components/Sidebar.test.tsx` — Sidebar navigation
- `src/components/Layout.test.tsx` — Layout component
- `src/components/OnboardingDialog.test.tsx` — New user onboarding wizard
- `src/components/placement/PlacementTestDialog.test.tsx` — AI placement test dialog (intro → testing → result wizard)
- `src/components/PersistentRoutes.test.tsx` — Persistent routing
- `src/components/SpeakButton.test.tsx` — Read-aloud button
- `src/components/InlineErrorBoundary.test.tsx` — Inline error boundary
- `src/components/KnowledgeGraph.test.tsx` — Knowledge graph component
- `src/components/analytics/StatCard.test.tsx` — Stat card
- `src/components/analytics/LevelProgressCard.test.tsx` — Per-skill level radar card (radar data, confidence, suggestions)
- `src/prompts/speaking.test.ts` — Speaking prompt templates
- `src/prompts/listening.test.ts` — Listening prompt templates
- `src/prompts/correct.test.ts` — Writing correction prompt template (level spec, estimate field)
- `src/prompts/reading.test.ts` — Reading prompt template (six sections, level spec)
- `src/prompts/exercise.test.ts` — Exercise prompt template (level spec and backward compatibility)
- `src/prompts/placement.test.ts` — Placement test authoring prompt template
- `src/prompts/enrichment.test.ts` — Vocabulary enrichment prompt template
- `src/services/llm.test.ts` — LLM service layer
- `src/services/notifications.test.ts` — Review notification service
- `src/services/tts.test.ts` — TTS speech synthesis service
- `src/services/asr.test.ts` — ASR speech recognition service (WAV encoding + transcription)
- `src/services/vocabulary-enrichment.test.ts` — Vocabulary enrichment service (model-keyed cache)

### Rust Tests

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Inline `#[cfg(test)]` modules cover pure-function logic and database integration tests (via in-memory SQLite), currently **255 tests**:

- `repository::words` — Vocabulary CRUD, input validation, duplicate-add idempotency, review stats, FSRS atomic update, level whitelist and enrichment write (38 tests)
- `repository::history` — History CRUD, type filtering, pagination, clamping, difficulty-level persistence (27 tests)
- `repository::models` — Model config CRUD, default model management, base URL validation (20 tests)
- `repository::learning` — Learning streaks, goals, sidebar aggregation, streak computation (19 tests, unit + integration)
- `repository::export` — CSV/Anki sanitization functions, CSV/Anki export integration tests (17 tests)
- `db::tests` — Base64 decoding, test DB creation and isolation, migration checksum recording and legacy backfill, migration-list completeness (19 tests)
- `commands::proxy` — Proxy request body building (TTS/ASR/connection test), URL joining (append only when missing), stream-URL derivation, loopback detection (20 tests)
- `commands::sse` — SSE line parsing, line splitting, multi-byte UTF-8 cross-chunk decoding, per-event size cap, done marker dispatched exactly once (14 tests)
- `commands::ssrf` — SSRF validation (private/link-local reject, loopback allow, IPv4-embeddable IPv6 prefix reject, per-IP recheck after DNS resolution) (5 tests)
- `fsrs::tests` — FSRS state transitions, lapse counting, stability growth & ordering (incl. difficulty-capped growth), enum conversions, retention parsing (12 tests)
- `commands::settings` — Settings command layer: enum key validation, TTS batch writes (single transaction + Keychain routing), TTS config building (9 tests)
- `repository::tests` — Enum and write validation (`validate_review_status` / `validate_record_type` / `validate_goal_type` / `validate_difficulty_level` / `validate_word_level`) (17 tests)
- `error::tests` — `From` conversions (rusqlite/keyring/io error mapping and sanitization), `Display` output, `Serialize` structure (8 tests)
- `repository::settings` — Key-value CRUD, TTS config queries (7 tests)
- `credentials::tests` — Keychain read cache (expired miss, stale read not overwriting concurrent write, absent-entry fill) (4 tests)
- `dto` — DTO row mapping and key sanitization, learning-activity enum whitelist consistency (4 tests)
- `commands::models` — Model command layer: default model resolution (in-memory DB fallback chain) (3 tests)
- `commands::export` — Export command layer: write-path whitelist validation, native-save-dialog export, DB backup (dialog/default location) and restore (10 tests)
- `commands::history` — History command layer: lightweight columns and type filtering (in-memory DB) (2 tests)

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
