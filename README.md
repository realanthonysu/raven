# Raven

English learning desktop assistant powered by LLM. Built with Tauri v2 + React + TypeScript.

> Version 1.0.1

## Features

### Writing Copilot

Paste English text for AI-powered grammar and style analysis:

- **Correction** — identifies errors with categories (subject-verb agreement, tense, articles, spelling, etc.)
- **Suggestions** — writing improvement tips
- **Copy / Replace** — one-click copy corrected text or replace input

### Reading Copilot

Paste an English article for deep reading analysis. The system first verifies the input is English, then provides six analysis dimensions:

1. **参考翻译** — full Chinese translation
2. **重点词汇** — 5-8 key vocabulary with phonetics, collocations, and examples
3. **句子拆解** — complex sentence structure breakdown (max 10)
4. **语法分析** — grammar point extraction (max 10)
5. **背景与技巧** — domain background + translation techniques
6. **延伸思考** — critical thinking and open questions

Plus an interactive **knowledge graph** (Cytoscape.js) with bilingual Chinese/English toggle and fullscreen mode.

### Vocabulary Notebook

Save words from Reading Copilot by clicking on them or via the vocabulary section's "添加到生词本" button. Tag with difficulty levels (CET-4/6, TEM-4/8).

### Spaced Repetition Review

Review saved vocabulary with a flip-card interface and spaced repetition scheduling:

- **Flip card** — front shows word + phonetic, back reveals definition, collocations, and example
- **Self-assessment** — rate each word as "不认识" (reset to 1 day), "模糊" (keep interval), or "认识" (double interval, max 30 days)
- **Auto-promotion** — words transition from `new` → `learning` → `mastered` after 3 consecutive "认识" ratings
- **Smart scheduling** — only shows words due for review (based on `next_review_at`)

### History

All analyses are saved to SQLite. History page supports type filtering (Writing/Reading) and deletion. Detail page renders full analysis with expandable cards and knowledge graph.

### Analytics

`/analytics` page derives statistics from existing history data (no extra DB tables):

- Summary stat cards (total sessions, error count, average errors per session)
- Error category distribution (bar chart + pie chart)
- Error trend over time (line chart)
- Recent session details

### Background Tasks & Persistent State

- CorrectPage and ReadingPage stay mounted when navigating away — switching back restores all content instantly
- A status bar shows running tasks (blue, with spinner) and completed tasks (green)
- Completed task notifications persist until the user returns to that page

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Tauri v2 |
| Frontend | React 19, TypeScript, Vite |
| Routing | react-router-dom v7 |
| UI | shadcn/ui v4 (base-nova), Tailwind CSS v3, lucide-react |
| Markdown | react-markdown |
| LLM | OpenAI-compatible API (configurable base_url + model_name) |
| Graph | Cytoscape.js |
| Database | SQLite (via tauri-plugin-sql) |
| HTTP | tauri-plugin-http (native TLS, SSE streaming) |
| Charts | recharts |
| Testing | Vitest, @testing-library/react |
| Linting | ESLint v10 (flat config), typescript-eslint |

## Development

```bash
npm install
npm run tauri dev        # Full dev (Vite + Rust + desktop window)
npm run dev              # Frontend only (port 5173)
npm run build            # Build frontend (tsc -b && vite build)
npm run preview          # Preview production build
npm run tauri build      # Build desktop app
npm run lint             # ESLint check
npm run test             # Run tests (Vitest)
npm run test:watch       # Watch mode
npx shadcn@latest add <component>  # Add UI components
```

## Project Structure

```
src/
├── components/              # Shared UI components
│   ├── ErrorBoundary        # React error boundary (class component)
│   ├── KnowledgeGraph       # Cytoscape.js graph with bilingual toggle + fullscreen
│   ├── Layout               # Shell with sidebar + task status bar
│   ├── PersistentRoutes     # Keeps CorrectPage/ReadingPage mounted across navigation
│   ├── ResultCard           # Collapsible result section with variant colors
│   ├── Sidebar              # Navigation sidebar with NavLink active states
│   ├── TextInput            # Textarea with Ctrl/Cmd+Enter submit
│   └── ui/                  # shadcn/ui primitives (Button, Card, Badge, etc.)
├── lib/
│   ├── db.ts                # SQLite CRUD (words, history, models) + spaced repetition queries
│   ├── parse-utils.ts       # LLM JSON extraction with 3-level fallback
│   ├── task-status.ts       # Reactive task status store (useSyncExternalStore)
│   ├── type-config.tsx      # Shared type/section display configs
│   └── utils.ts             # Tailwind class merge utility (cn)
├── pages/
│   ├── AnalyticsPage        # Error statistics and trend charts
│   ├── CorrectPage          # Writing Copilot
│   ├── HistoryDetailPage    # Single history record detail view
│   ├── HistoryPage          # Analysis history list with filtering
│   ├── ReadingPage          # Reading Copilot (6-dimension analysis + knowledge graph)
│   ├── ReviewPage           # Spaced repetition review (flip cards)
│   ├── SettingsPage         # LLM model configuration
│   └── VocabularyPage       # Word notebook with level tagging
├── services/
│   └── llm.ts               # SSE streaming, prompt builder, section parser
├── test/
│   └── setup.ts             # Vitest setup (jest-dom matchers)
└── types/
    └── index.ts             # TypeScript interfaces (ModelConfig, Word, HistoryRecord, etc.)

src-tauri/
├── src/lib.rs               # Tauri plugin registration (HTTP, SQL, opener)
├── migrations/              # SQLite schema migrations (001-004)
├── capabilities/            # WebView permissions (SQL, opener)
├── tauri.conf.json          # App config (CSP, window, build commands)
└── Cargo.toml               # Rust dependencies
```

## Architecture Notes

- **LLM streaming**: `streamChat()` uses `tauri-plugin-http` for cross-origin requests with fallback to WebView `fetch`. Supports `AbortSignal` for request cancellation.
- **Persistent pages**: CorrectPage and ReadingPage use CSS `display: contents/none` toggling to stay mounted without affecting layout.
- **Task status**: Module-level state with `useSyncExternalStore` — not React state, so it can be updated from outside components (e.g., async callbacks).
- **Spaced repetition**: Algorithm lives in ReviewPage, persistence in `db.ts`. Interval doubles on "认识" (capped at 30 days), resets on "不认识", stays on "模糊".
- **Knowledge graph**: Cytoscape.js instance managed via `useRef`, with `expandedRef` to avoid stale closures. Language toggle operates on node data directly without rebuilding the graph.
- **JSON parsing**: LLM output is parsed with 3-level fallback (direct JSON → markdown code block → brace extraction) to handle inconsistent formatting.
