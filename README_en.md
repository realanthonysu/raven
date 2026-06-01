# Raven

[中文](./README.md) | English

The AI-powered English learning desktop assistant

![version](https://img.shields.io/badge/version-v1.5.0-blue)
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

### v1.5.0

Design patterns refactoring — second pass. Reusable hooks, shared UI components, centralized type registry, race condition fixes, and code review bug fixes:

- **`useAudioPlayer` Hook**: Shared TTS playback hook encapsulating AbortController lifecycle and playing/loading states. SpeakButton reduced from 79 to 42 lines.
- **`usePhaseMachine` Hook**: Generic phase-based state machine with `onEnter`/`onExit` callbacks. ExercisePage, ListeningPage, and ReviewPage phase management consolidated from scattered `useState` to explicit transitions.
- **`createCachedFetcher` Utility**: Generic async cache with Promise deduplication, FIFO eviction, and manual invalidation. Replaces hand-rolled cache logic in db.ts and tts.ts.
- **Shared UI Components**: `EmptyState`, `ErrorBanner`, `LoadingIndicator` — all 4 LLM pages now use these instead of inline markup.
- **Registry Pattern**: `DETAIL_COMPONENTS` map replaces HistoryDetailPage's 4-level ternary chain; `CATEGORY_EXERCISE_TYPE` centralized to `type-config.tsx`.
- **Race Condition Fix**: SpeedTrainerPage uses generation counter instead of `stoppedRef` + 3 `setTimeout` hacks.
- **Critical Bug Fixes**: `playAudio` Promise leak on abort (never settled); `createCachedFetcher` permanently cached failed requests (no retry); `fetchGraphData` uncancellable graph fetch race condition; `useStreamChat` options dependency causing `execute` recreation.
- **Documentation**: Added detailed JSDoc and inline comments to 10 files — SpeedTrainerPage (concurrency pattern), SettingsPage (handlers + form fields), ListeningPage (state + handlers), SpeakButton (three-state logic), tts.ts (playAudio Promise lifecycle), db.ts (11 CRUD functions), and more.
- **Vocabulary auto-enrichment**: Words added from ReadingPage now auto-fill phonetic, definition, collocations, and example via LLM. VocabularyPage adds batch enrichment button.
- **New user onboarding**: 4-step wizard on first launch — configure API Key (with OpenAI/DeepSeek presets and connection test) → feature preview → quick start guide. Skippable.
- **Expanded analytics**: Now covers all learning types — exercise score trend chart, listening score trend chart, 8 stat cards, recent sessions with colored type badges.
- **Learning streak & review reminder**: Sidebar shows "连续学习 N 天" streak counter and due review count badge. New `learning_streaks` DB table tracks daily activities across all 5 learning types.
- **Writing correction → vocabulary**: Each correction card now has an "加入生词本" button with LLM enrichment, three visual states (add/enriching/done).
- **Code Review Fixes**: Fixed ReadingPage addWord failure UI stuck, CorrectPage notes data loss, recordLearningActivity race condition, batch enrichment unmount leak, onboarding dialog dismiss bug, and more (9 issues total).
- **Pattern Compliance Fixes**: SpeedTrainerPage AbortController unmount cleanup, HistoryDetailPage/AnalyticsPage unified extractJson usage, shared components replace inline loading/empty states, fetch-utils Chinese JSDoc, ExerciseCard interface docs.
- **AI Personalized Prompts**: `buildPersonalizedContext()` queries recent error history, extracts top 3 categories with examples, injects into CorrectPage and ExercisePage prompts.
- **Daily Review Notification**: Browser Notification API on app startup. SettingsPage toggle. Notifies once per day when due reviews exist.
- **Manual Vocabulary Entry**: Collapsible form with word/phonetic/definition/level. Auto-enriches empty definitions via LLM. Duplicate detection.
- **CSV Import**: VocabularyPage supports CSV/TXT file import with auto-dedup, enrichment, progress bar, and summary.
- **Page-level Tests**: 38 new tests — ExercisePage (11), ReviewPage (12), useStreamChat (15). Shared mock utilities. 103 total tests all passing.
- **Listening Vocabulary Extraction**: After listening practice, extract key vocabulary from wrong sentences via LLM and add to vocabulary notebook with one click.
- **Daily Learning Goals & Progress**: Sidebar shows compact progress bars for each goal type. SettingsPage adds goal management with 3 presets (casual/standard/advanced).
- **Learning Profile Radar Chart**: AnalyticsPage shows 4-dimension capability radar chart (语法/词汇/句式/细节) derived from writing errors (70%) and exercise scores (30%).
- **Final Code Review Fixes**: ListeningPage retry blocked by stale error, ReadingPage language detection missing AbortSignal, useStreamChat double status emission, VocabularyPage timer leak, SpeedTrainer stale speed closure, CorrectPage addedWords closure, VocabularySection error handling, buildPersonalizedContext query optimization.

### v1.4.0

Architecture refactoring — design patterns applied to eliminate technical debt:

- **`useStreamChat` Hook**: Extracts shared LLM streaming logic (model lookup, AbortController lifecycle, task status reporting). Each of the 4 LLM pages loses ~40 lines of boilerplate.
- **`extractJson<T>()`**: Unified JSON parser with 3-level fallback (direct parse → code block extraction → brace matching). Replaces 5 scattered inline implementations.
- **`smartFetch`**: Extracts the Tauri/WebView dual-fetch strategy into a shared utility, eliminating duplication between `llm.ts` and `tts.ts`.
- **`addHistorySafe`**: Unified error handling for history writes. Fixes ReadingPage's unhandled Promise rejection.
- **TTS config caching**: SpeakButton clicks no longer trigger 4 parallel SQL queries. Cache auto-invalidates on settings change.
- **`addModel` transaction safety**: Model insert + default set is now wrapped in BEGIN/COMMIT/ROLLBACK.
- **Component extraction**: ExerciseCard and VocabularySection extracted as shared components, eliminating duplicate rendering in HistoryDetailPage.
- **`parseSections` relocated**: Moved from llm.ts to parse-utils.ts for proper responsibility alignment.
- 13 new unit tests added, 50 total tests all passing.

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
├── components/          # Shared UI (KnowledgeGraph, Layout, Sidebar, ExerciseCard, VocabularySection, page-states, OnboardingDialog, etc.)
├── hooks/               # Custom hooks (useStreamChat, useAudioPlayer, usePhaseMachine)
├── test/                # Test setup and shared mock utilities
├── lib/                 # Utilities (db, parse-utils, task-status, type-config, fetch-utils, cache)
├── pages/               # Pages (Correct, Reading, Vocabulary, Review, History, Analytics, Settings, Listening, Speed Trainer)
├── services/            # LLM streaming service, TTS audio service
├── test/                # Vitest setup
└── types/               # TypeScript interfaces

src-tauri/
├── src/lib.rs           # Tauri plugin registration
├── migrations/          # SQLite schema (001-005)
├── capabilities/        # WebView permissions
└── tauri.conf.json      # App config
```

## License

MIT © Anthony Su
