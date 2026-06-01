# Changelog

## v1.5.0

Design patterns refactoring — second pass. Introduced reusable hooks, shared UI components, centralized type registry, fixed race conditions, comprehensive documentation, and 5 product improvements.

### New

- **`useAudioPlayer` hook** (`src/hooks/use-audio-player.ts`) — shared hook encapsulating TTS playback with AbortController lifecycle, playing/loading states, and `play`/`stop`/`toggle` API. Replaces manual AbortController management in SpeakButton, ReadingPage, and ListeningPage.
- **`usePhaseMachine` hook** (`src/hooks/use-phase-machine.ts`) — generic phase-based state machine with `onEnter`/`onExit` callbacks, `transition` for callback-aware phase changes, and `setPhase` for direct jumps (error recovery). Used by ExercisePage, ListeningPage, and ReviewPage.
- **`createCachedFetcher` utility** (`src/lib/cache.ts`) — generic async cache with Promise deduplication, FIFO eviction, `onEvict` cleanup, and manual invalidation. Replaces hand-rolled cache implementations in db.ts and tts.ts.
- **`EmptyState` component** (`src/components/page-states.tsx`) — centered icon + title + subtitle for empty page states.
- **`ErrorBanner` component** (`src/components/page-states.tsx`) — red-bordered alert for error display.
- **`LoadingIndicator` component** (`src/components/page-states.tsx`) — spinner + text for loading states.
- **`DETAIL_COMPONENTS` registry** (`src/pages/HistoryDetailPage.tsx`) — map-based dispatch replacing 4-level ternary chain for history type → detail component resolution.
- 15 new unit tests for `usePhaseMachine` (transition callbacks, setPhase bypass, isPhase, callback stability).
- Total: 65 tests across 3 test files, all passing.

### Changed

- SpeakButton refactored from 79 to 42 lines — all manual AbortController/state management replaced by `useAudioPlayer`.
- ReadingPage's read-aloud feature uses `useAudioPlayer` for per-sentence TTS playback.
- ListeningPage uses `useAudioPlayer` for sentence playback and `usePhaseMachine` for phase management.
- ExercisePage uses `usePhaseMachine` — `handleRetry` simplified by consolidating 5 state resets into `onEnter.loading` callback.
- ReviewPage uses `usePhaseMachine` — `loadReview` and `handleRate` simplified, stats refresh moved to `onEnter.done`.
- SpeedTrainerPage race conditions fixed — `stoppedRef` + 3 `setTimeout` hacks replaced by generation counter pattern (`playGenerationRef`).
- All 4 LLM pages (Correct, Reading, Exercise, Listening) now use shared `EmptyState`, `ErrorBanner`, and `LoadingIndicator` components.
- HistoryDetailPage's type dispatch changed from 4-level ternary chain to `DETAIL_COMPONENTS` map lookup.
- `CATEGORY_EXERCISE_TYPE` and `EXERCISE_TYPE_LABEL` moved from ExercisePage to `type-config.tsx` — all type mappings now centralized.
- TTS config cache in db.ts refactored to use `createCachedFetcher` (3 lines instead of 30).
- Audio cache in tts.ts refactored to use `createCachedFetcher` with FIFO eviction and `URL.revokeObjectURL` cleanup.

### Fixed

- **Critical: `playAudio` Promise leak on abort** — when AbortSignal fired, `onAbort` handler paused the audio but never rejected the Promise, causing it to hang indefinitely. Now properly rejects with `AbortError` and cleans up all event listeners.
- **Critical: `createCachedFetcher` permanently cached rejected Promises** — network failures for a given key were cached forever, blocking all subsequent retries. Now deletes the cache entry on rejection so the next call retries.
- **Major: `ReadingPage.fetchGraphData` had no AbortSignal** — graph fetch could not be cancelled when user started a new analysis. Added `graphAbortRef`, aborted at the start of `handleAnalyze`, and passed signal through to `streamChat`.
- **Major: `useStreamChat` options dependency footgun** — `options` was in `execute`'s `useCallback` dependency array, causing `execute` to be recreated every render if consumers didn't memoize options. Switched to `optionsRef` + `useEffect` pattern.
- SpeedTrainerPage race condition: `setTimeout(() => playFrom(idx), 100)` could start new playback before old loop fully exited. Replaced with generation counter that detects stale loops.
- `useAudioPlayer` and `usePhaseMachine` ref assignments moved from render body to `useEffect` (React hooks lint compliance).
- ReadingPage `fetchGraphData` null-to-undefined type mismatch for `historyId` parameter.
- ReadingPage `readAloudAbortRef` and `graphAbortRef` now cleaned up on unmount.
- ExercisePage `isValidExercises` removed `any` type — now uses `unknown` + `Record<string, unknown>` type guard.
- `page-states.tsx` className concatenation replaced with `cn()` utility for robust class merging.

### Docs

- **SpeedTrainerPage** — added component JSDoc, 8 handler JSDocs, detailed `playGenerationRef` concurrency pattern explanation, and all state variable comments (was the least documented page).
- **SettingsPage** — added component JSDoc, 5 handler JSDocs, speed clamping logic documentation, and form field descriptions.
- **ListeningPage** — added component JSDoc, `generateSentences`/`handleSubmit` JSDocs, 10 state variable comments, matching documentation quality of peer pages.
- **SpeakButton** — added component JSDoc, props JSDoc, three-state icon logic, and `stopPropagation` rationale.
- **tts.ts** — added JSDoc on `fetchTTSAudio`, `playAudio` (Promise lifecycle with 5 steps), and `speakText`.
- **db.ts** — added one-line JSDoc on 11 CRUD functions (`getWords`, `deleteWord`, `updateWordLevel`, `getHistory`, `getHistoryById`, `deleteHistory`, `getSetting`, `setSetting`, `getTTSConfig`, `setTTSSetting`, `updateHistoryGraphData`).
- **HistoryDetailPage** — added `ListeningDetail` JSDoc to match sibling components.
- **use-stream-chat** — documented `taskName` purpose, `overrides` merge semantics, and all 6 return value members.
- **use-audio-player** — documented `speed` parameter on `play` and `toggle` methods.
- **fetch-utils** — documented fallback strategy in catch block.

### Product Improvements

- **Vocabulary auto-enrichment** — words added from ReadingPage now automatically get phonetic, definition, collocations, and example via LLM. VocabularyPage adds "批量补全" button to fill missing data for existing words.
- **New user onboarding** — 4-step wizard dialog on first launch: welcome → configure API Key (with OpenAI/DeepSeek presets and connection test) → feature preview → quick start guide. Skippable at any step.
- **Expanded analytics** — AnalyticsPage now covers all learning types: exercise score trend chart, listening score trend chart, 8 stat cards (writing/reading/exercise/listening counts), recent sessions show all types with colored badges.
- **Learning streak & review reminder** — Sidebar shows "连续学习 N 天" streak counter and red badge with due review count. New `learning_streaks` DB table tracks daily activities across all 5 learning types.
- **Writing correction → vocabulary** — each correction card in CorrectPage now has an "加入生词本" button with LLM enrichment, three visual states (add/enriching/done).
- **AI personalized prompts** — `buildPersonalizedContext()` queries recent error history, extracts top 3 error categories with examples, and injects into CorrectPage and ExercisePage prompts. New users get no personalization (threshold: 3+ records).
- **Daily review notification** — new `notifications.ts` service using browser Notification API. Checks `getReviewStats().dueCount` on app startup, sends system notification if > 0. SettingsPage adds toggle switch. Only notifies once per day.
- **Manual vocabulary entry** — VocabularyPage adds collapsible form with word/phonetic/definition/level fields. Auto-calls `enrichWord` when definition is empty. Duplicate detection by case-insensitive match.
- **CSV vocabulary import** — VocabularyPage adds "导入" button supporting CSV/TXT files (comma or tab delimited). Auto-detects header row, checks duplicates, optionally enriches missing definitions. Shows progress and summary.
- **Page-level tests** — 38 new tests across 3 test files: `ExercisePage.test.tsx` (11 tests), `ReviewPage.test.tsx` (12 tests), `use-stream-chat.test.ts` (15 tests). Shared mock utilities in `src/test/mocks.ts`. Total: 103 tests across 6 files, all passing.
- **Listening vocabulary extraction** — after listening practice, users can extract key vocabulary from wrong sentences via LLM and add them to the vocabulary notebook with one click. Uses `enrichWord` for auto-enrichment.
- **Daily learning goals & progress** — new `learning_goals` DB table (migration 006). Sidebar shows compact progress bars for each goal type (review/exercise/reading/writing/listening). SettingsPage adds goal management with 3 presets (casual/standard/advanced).
- **Learning profile radar chart** — AnalyticsPage shows a 4-dimension capability radar chart (语法/词汇/句式/细节) derived from writing error analysis (70%) and exercise scores (30%). Includes trend indicators and strongest/weakest dimension summary.

### Code Review Fixes

- **Critical: ReadingPage `addWord` not in try/catch** — DB failure left UI stuck in "补全中..." state permanently. Wrapped in try/catch/finally, added `addedWords` Set to prevent duplicate additions.
- **Major: CorrectPage notes dropped collocations when example was empty** — `collocations && example` evaluated to falsy when either was empty. Changed to `filter(Boolean).join` pattern.
- **Major: `recordLearningActivity` read-modify-write race condition** — concurrent calls could overwrite each other's activity counts. Replaced with atomic SQLite JSON functions (`json_set` + `json_extract`).
- `getTodayActivities` JSON.parse now wrapped in try/catch with `{}` fallback.
- VocabularyPage batch enrichment now aborts on component unmount via `cancelledRef`.
- ReadingPage word-click adds now tracked in `addedWords` Set to prevent duplicate inserts.
- OnboardingDialog no longer dismisses on Escape key or backdrop click — user must explicitly skip or finish.
- `useStreamChat` onDone callback now checks `signal.aborted` to prevent task status flicker on abort race.

### Bug Fixes (Post Feature Addition)

- **Major: Radar chart "表达" dimension always showed score 50** — no error category or exercise data ever fed into it. Removed from `DIMENSION_CONFIG`, radar now shows 4 dimensions with real data.
- **Minor: ListeningPage vocabulary extraction `extracting` state stuck on abort** — added `onAbort` callback to reset the loading state.
- **Minor: `handleAddExtractedWord` had no error handling** — wrapped in try/catch to prevent unhandled promise rejections.

### Final Code Review Fixes

- **Major: ListeningPage retry blocked by stale error** — `handleRetry` now explicitly clears `error` and `showRetryHint` before calling `transition("loading")`, preventing the useEffect guard from blocking generation.
- **Major: ReadingPage language detection lacked AbortSignal** — added `detectAbortRef` controller, passed signal to `streamChat` for language detection, aborted on new submission and unmount.
- **Major: useStreamChat double task-status emission** — reordered abort: set new controller in ref first, then abort old one, preventing idle→running→idle→running flicker.
- **Major: VocabularyPage showMessage timer leak** — timer stored in ref, cleared on unmount and before setting new timer.
- **Major: SpeedTrainerPage stale speed on change** — `playFrom` now accepts optional `overrideSpeed` parameter, `handleSpeedChange` passes new speed directly.
- **Major: CorrectPage addedWords stale closure** — switched guard check to `addedWordsRef` (useRef), removed `addedWords` from useCallback dependency array.
- `test/mocks.ts` — `is_default` changed from `1` to `true` to match `ModelConfig` type.
- `VocabularySection` — `handleAdd` wrapped in try/catch to prevent unhandled rejection.
- `db.ts` `buildPersonalizedContext` — now uses `LIMIT` query instead of fetching all records then slicing.

### Pattern Compliance Fixes

- **SpeedTrainerPage** — added missing AbortController unmount cleanup for `playAbortRef` (HIGH: TTS audio could continue playing after navigation).
- **HistoryDetailPage** — `ExerciseDetail` and `ListeningDetail` now use `extractJson` instead of raw `JSON.parse`, consistent with `WritingDetail` and the rest of the codebase.
- **AnalyticsPage** — `parseResult` now uses `extractJson` instead of `JSON.parse`, consistent with how the same file parses `ExerciseResult` and `ListeningResult`. Inline loading spinner and empty state replaced with shared `LoadingIndicator` and `EmptyState` components.
- **VocabularyPage** — inline empty state replaced with shared `EmptyState` component.
- **fetch-utils** — JSDoc changed from English to Chinese to match project convention.
- **ExerciseCard** — added JSDoc on `ExerciseCardProps` interface members.
- **OnboardingDialog** — removed dead `handleKeyDown` code (empty keyboard listener that did nothing).

## v1.4.0

Architecture refactoring — design patterns applied to eliminate technical debt accumulated during rapid multi-agent development.

### New

- **`useStreamChat` hook** (`src/hooks/use-stream-chat.ts`) — shared hook encapsulating model lookup, AbortController lifecycle, and task status reporting for all LLM streaming calls
- **`extractJson<T>()`** (`src/lib/parse-utils.ts`) — unified JSON parser with 3-level fallback (direct parse → code block extraction → brace matching), supports optional type-guard validation
- **`smartFetch`** (`src/lib/fetch-utils.ts`) — Tauri/WebView dual-fetch strategy extracted as a shared utility
- **`addHistorySafe`** (`src/lib/db.ts`) — wraps `addHistory` with try/catch, returns `lastInsertId` or `null`, accepts optional `onError` callback
- **TTS config cache** (`src/lib/db.ts`) — `getTTSConfigCached()` with Promise deduplication and auto-invalidation on settings change
- **`ExerciseCard` component** (`src/components/ExerciseCard.tsx`) — extracted from ExercisePage, supports interactive and read-only modes
- **`VocabularySection` component** (`src/components/VocabularySection.tsx`) — extracted from ReadingPage

### Changed

- CorrectPage, ReadingPage, ExercisePage, ListeningPage refactored to use `useStreamChat` hook (~40 lines of boilerplate removed per page)
- ExercisePage and ListeningPage now use `extractJson<T>()` instead of inline JSON parsing
- ReadingPage uses shared `readingSectionConfig` from `type-config.tsx` instead of local duplicate
- ReadingPage's graph data and language detection parsing now use `extractJson<T>()`
- `parseCorrectionJson` now delegates to `extractJson<CorrectionResult>()` (eliminates duplicate 3-level fallback)
- `parseSections` moved from `llm.ts` to `parse-utils.ts` (pure text parser belongs in utils, not services)
- `llm.ts` and `tts.ts` use `smartFetch` instead of duplicated tauriFetch/fetch fallback
- SpeakButton uses `getTTSConfigCached()` (eliminates 4 DB queries per click)
- `addModel` wrapped in BEGIN/COMMIT/ROLLBACK transaction
- HistoryDetailPage uses shared ExerciseCard component (eliminates ~120 lines of duplicate rendering)
- `type-config.test.ts` updated to include `listening` type

### Fixed

- Abort cleanup missing in ExercisePage and ListeningPage (state update on unmounted component)
- Unhandled Promise rejection in ReadingPage's `onDone` callback
- Non-atomic `addModel` operation (insert + set-default could leave inconsistent state)
- `parseCorrectionJson` greedy regex matching — now uses proper brace-depth matching
- FIFO cache mislabeled as "LRU" in tts.ts comment
- `type-config.test.ts` failing to assert `listening` type

### Tests

- 13 new unit tests for `extractJson<T>()` (direct parse, code block, brace matching, validation, edge cases)
- Total: 50 tests across 2 test files, all passing

## v1.3.0

- **TTS integration**: supports OpenAI-compatible TTS API with independent config for URL, key, voice, and speed
- **Vocabulary pronunciation**: speaker button on every word in vocabulary notebook and review flashcards
- **Reading read-aloud**: sentence-by-sentence playback with synchronized highlighting of the current sentence
- **Writing compare-speak**: listen to both the original wrong text and the corrected version for each correction
- **Listening practice**: new feature — LLM generates sentences, TTS plays them, user dictates, auto-scoring
- **Speed trainer**: new feature — paste English text and play at 5 speed levels (0.5x–1.5x) with single/full loop modes
- Settings page now includes TTS configuration card with a test button

## v1.2.1

- Enhanced weak point training: smart answer matching by question type (exact for fill-in-the-blank, normalized for correction/rewriting)
- Loading timeout hint: shows "regenerate" button when LLM takes over 30 seconds
- Save failure feedback: displays warning banner when exercise results fail to persist
- Task status bar integration: weak point training now shows loading/completion in the global status bar
- Code quality: comprehensive comments added, new unit tests (32 test cases)

## v1.1.0

- Weak point training: automatically identifies weak areas from writing correction data and generates targeted exercises
- Analytics dashboard: new weak category recommendation with direct training access
- History detail supports exercise record review
