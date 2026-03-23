# S04: Hot-path caller migration + cross-validation tests

**Goal:** The six highest-frequency parser callers in the auto-mode dispatch loop read from DB instead of parsing markdown, and cross-validation tests prove DB↔rendered parity.
**Demo:** `dispatch-guard.ts`, `auto-dispatch.ts` (3 rules), `auto-verification.ts`, and `parallel-eligibility.ts` import DB query functions instead of `parseRoadmapSlices`/`parseRoadmap`/`parsePlan`. All existing tests pass. New cross-validation tests prove rendered-then-parsed state matches DB state.

## Must-Haves

- `sequence INTEGER DEFAULT 0` column on `slices` and `tasks` tables via schema v9 migration (R016)
- All 6 `ORDER BY id` queries in gsd-db.ts updated to `ORDER BY sequence, id` with null-safe fallback (R016)
- `dispatch-guard.ts` uses `getMilestoneSlices()` instead of `parseRoadmapSlices()` (R009)
- `auto-dispatch.ts` uat-verdict-gate, validating-milestone, completing-milestone rules use `getMilestoneSlices()` instead of `parseRoadmap()` (R009)
- `auto-verification.ts` uses `getTask()` instead of `parsePlan()` (R009)
- `parallel-eligibility.ts` uses `getMilestoneSlices()` + `getSliceTasks()` instead of `parseRoadmap()` + `parsePlan()` (R009)
- Cross-validation test proving DB state matches rendered-then-parsed state for ROADMAP and PLAN artifacts (R014)
- `dispatch-guard.test.ts` updated to seed DB state instead of writing markdown files

## Proof Level

- This slice proves: contract + integration
- Real runtime required: no
- Human/UAT required: no

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/schema-v9-sequence.test.ts` — sequence column migration and ORDER BY behavior
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/dispatch-guard.test.ts` — dispatch guard using DB queries
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/planning-crossval.test.ts` — DB↔rendered parity
- `rg 'parseRoadmapSlices|parseRoadmap|parsePlan' src/resources/extensions/gsd/dispatch-guard.ts src/resources/extensions/gsd/auto-verification.ts src/resources/extensions/gsd/parallel-eligibility.ts` returns no matches (parser imports removed from migrated files)
- `rg 'parseRoadmap' src/resources/extensions/gsd/auto-dispatch.ts` returns no matches (parser import narrowed)
- Diagnostic: `node -e "const{openDatabase,getMilestoneSlices}=require('./src/resources/extensions/gsd/gsd-db.ts');openDatabase(':memory:');console.log(getMilestoneSlices('NONEXISTENT'))"` — returns empty array `[]` (no crash on missing milestone, observable failure state)

## Observability / Diagnostics

- Runtime signals: `isDbAvailable()` gate in each migrated caller — falls back to disk parsing when DB is not open, logging a stderr diagnostic
- Inspection surfaces: SQLite `slices` and `tasks` tables with `sequence` column; `getMilestoneSlices()`/`getSliceTasks()` query functions
- Failure visibility: dispatch-guard returns blocker string on failure; auto-dispatch rules return stop/skip actions; stderr warnings when DB unavailable

## Integration Closure

- Upstream surfaces consumed: `gsd-db.ts` query functions (`getMilestoneSlices`, `getSliceTasks`, `getTask`, `isDbAvailable`), `markdown-renderer.ts` (`renderRoadmapFromDb`, `renderPlanFromDb`, `renderTaskPlanFromDb`), schema v8 migration from S01/S02
- New wiring introduced in this slice: DB imports in dispatch-guard, auto-dispatch, auto-verification, parallel-eligibility; schema v9 migration block
- What remains before the milestone is truly usable end-to-end: S05 warm/cold callers + flag files, S06 parser removal

## Tasks

- [x] **T01: Add schema v9 migration with sequence column and fix ORDER BY queries** `est:30m`
  - Why: R016 requires sequence-aware ordering. All caller migrations and cross-validation depend on correct query ordering.
  - Files: `src/resources/extensions/gsd/gsd-db.ts`, `src/resources/extensions/gsd/tests/schema-v9-sequence.test.ts`
  - Do: Add `sequence INTEGER DEFAULT 0` to slices and tasks tables in a `currentVersion < 9` migration block. Bump `SCHEMA_VERSION` to 9. Update `SliceRow` and `TaskRow` interfaces to include `sequence: number`. Change all 6 `ORDER BY id` queries to `ORDER BY sequence, id`. Add `insertSlicePlanning`/`insertTask` to accept optional `sequence` param. Write test file proving: migration adds column, ORDER BY respects sequence, null/0 sequence falls back to id ordering, backfill from positional order.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/schema-v9-sequence.test.ts`
  - Done when: All 6 ORDER BY queries use `sequence, id`, test file passes, existing tests unbroken

- [x] **T02: Migrate dispatch-guard.ts to DB queries and update tests** `est:45m`
  - Why: dispatch-guard re-parses ROADMAP.md on every slice dispatch — the single hottest parser caller. R009 requires this migration.
  - Files: `src/resources/extensions/gsd/dispatch-guard.ts`, `src/resources/extensions/gsd/tests/dispatch-guard.test.ts`
  - Do: Replace `parseRoadmapSlices(roadmapContent)` with `getMilestoneSlices(mid)`. Map `SliceRow.status === 'complete'` to `done: true`. Remove `readRoadmapFromDisk()`, `readFileSync`, and `parseRoadmapSlices` imports. Add `isDbAvailable()` + `getMilestoneSlices()` import from `gsd-db.js`. Keep the `findMilestoneIds()` disk-based milestone discovery (DB doesn't own milestone queue order). Add fallback to disk parsing when `!isDbAvailable()`. Update all 8 test cases to seed DB via `openDatabase`/`insertMilestone`/`insertSlice` instead of writing ROADMAP markdown files. Preserve all existing assertion semantics.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/dispatch-guard.test.ts`
  - Done when: dispatch-guard.ts has zero `parseRoadmapSlices` references, all 8 tests pass with DB seeding

- [x] **T03: Migrate auto-dispatch.ts, auto-verification.ts, and parallel-eligibility.ts to DB queries** `est:45m`
  - Why: These four files contain the remaining hot-path parser callers. R009 requires all six callers migrated.
  - Files: `src/resources/extensions/gsd/auto-dispatch.ts`, `src/resources/extensions/gsd/auto-verification.ts`, `src/resources/extensions/gsd/parallel-eligibility.ts`
  - Do: In `auto-dispatch.ts`: replace 3 `parseRoadmap(roadmapContent).slices` calls (lines ~176, ~507, ~564) with `getMilestoneSlices(mid)` mapping `status === 'complete'` to `done`. Remove `parseRoadmap` from the import (keep `loadFile`, `extractUatType`, `loadActiveOverrides`). Add `isDbAvailable`, `getMilestoneSlices` import from `gsd-db.js`. Gate each migrated rule on `isDbAvailable()` with disk-parse fallback. In `auto-verification.ts`: replace `parsePlan(planContent).tasks.find(t => t.id === tid).verify` with `getTask(mid, sid, tid)?.verify`. Remove `parsePlan` and `loadFile` imports. Add `isDbAvailable`, `getTask` import. Gate on `isDbAvailable()` with disk-parse fallback. In `parallel-eligibility.ts`: replace `parseRoadmap().slices` with `getMilestoneSlices(mid)`, replace `parsePlan().filesLikelyTouched` with `getSliceTasks(mid, sid).flatMap(t => t.files)`. Remove `parseRoadmap`, `parsePlan`, `loadFile` imports. Add `isDbAvailable`, `getMilestoneSlices`, `getSliceTasks` import. Gate on `isDbAvailable()` with disk-parse fallback.
  - Verify: `rg 'parseRoadmap' src/resources/extensions/gsd/auto-dispatch.ts src/resources/extensions/gsd/auto-verification.ts src/resources/extensions/gsd/parallel-eligibility.ts` returns no matches; `rg 'parsePlan' src/resources/extensions/gsd/auto-verification.ts src/resources/extensions/gsd/parallel-eligibility.ts` returns no matches
  - Done when: All three files import from `gsd-db.js` for planning state, zero parser references in migrated call sites, existing tests pass

- [ ] **T04: Write cross-validation tests proving DB↔rendered↔parsed parity** `est:45m`
  - Why: R014 requires proof that DB state matches rendered-then-parsed state during the transition window. This is the slice's highest-value proof artifact.
  - Files: `src/resources/extensions/gsd/tests/planning-crossval.test.ts`
  - Do: Create test file following the `derive-state-crossval.test.ts` pattern. Test scenarios: (1) Insert milestone + slices via DB, render ROADMAP via `renderRoadmapFromDb()`, parse back via `parseRoadmapSlices()`, assert field parity for `id`, `done`/status, `depends`, `risk`, `title`, `demo`. (2) Insert slice + tasks via DB with planning fields (description, files, verify, estimate), render via `renderPlanFromDb()`, parse back via `parsePlan()`, assert field parity for task `id`, `title`, `verify`, `filesLikelyTouched`, task count. (3) Insert task with all planning fields, render via `renderTaskPlanFromDb()`, parse back via `parseTaskPlanFile()` or read frontmatter, assert field parity for `description`, `verify`, `files`, `inputs`, `expected_output`. (4) Sequence ordering: insert slices with non-sequential sequence values, render ROADMAP, parse back, verify slice order matches sequence order not insertion order. Use `openDatabase`/`closeDatabase` with temp dirs, clean up after each test.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/planning-crossval.test.ts`
  - Done when: All 4 cross-validation scenarios pass, proving DB↔rendered↔parsed round-trip fidelity

## Files Likely Touched

- `src/resources/extensions/gsd/gsd-db.ts`
- `src/resources/extensions/gsd/dispatch-guard.ts`
- `src/resources/extensions/gsd/auto-dispatch.ts`
- `src/resources/extensions/gsd/auto-verification.ts`
- `src/resources/extensions/gsd/parallel-eligibility.ts`
- `src/resources/extensions/gsd/tests/schema-v9-sequence.test.ts`
- `src/resources/extensions/gsd/tests/dispatch-guard.test.ts`
- `src/resources/extensions/gsd/tests/planning-crossval.test.ts`
