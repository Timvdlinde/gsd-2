---
estimated_steps: 5
estimated_files: 3
skills_used: []
---

# T03: Migrate auto-dispatch.ts, auto-verification.ts, and parallel-eligibility.ts to DB queries

**Slice:** S04 — Hot-path caller migration + cross-validation tests
**Milestone:** M001

## Description

Migrate the remaining hot-path parser callers to DB queries. Three files, each with a narrow transformation: replace parser calls with DB query functions, gate on `isDbAvailable()`, add disk-parse fallback. The auto-dispatch.ts changes touch only 3 of 18 rules — leave other `loadFile` usages untouched (those are S05 warm-path callers).

## Steps

1. **auto-dispatch.ts** — Migrate 3 rules that use `parseRoadmap()`:
   - Add import: `import { isDbAvailable, getMilestoneSlices } from "./gsd-db.js"`.
   - **uat-verdict-gate rule** (~line 176): Replace `parseRoadmap(roadmapContent).slices.filter(s => s.done)` with: if `isDbAvailable()`, use `getMilestoneSlices(mid).filter(s => s.status === 'complete')`. Map `slice.id` directly (same field). Keep the `resolveSliceFile` + `loadFile` for UAT-RESULT content reading (that's file content, not planning state). Else fall back to existing disk code.
   - **validating-milestone rule** (~line 507): Replace `parseRoadmap(roadmapContent).slices` with: if `isDbAvailable()`, use `getMilestoneSlices(mid)`. Map `slice.id` directly for the `resolveSliceFile` SUMMARY existence check. Else fall back to existing disk code.
   - **completing-milestone rule** (~line 564): Same pattern as validating-milestone — replace `parseRoadmap(roadmapContent).slices` with `getMilestoneSlices(mid)` when DB is available.
   - Remove `parseRoadmap` from the import on line 15. Keep `loadFile`, `extractUatType`, `loadActiveOverrides`.

2. **auto-verification.ts** — Migrate task verify lookup:
   - Add import: `import { isDbAvailable, getTask } from "./gsd-db.js"`.
   - At ~line 69-75: Replace the `loadFile(planFile)` → `parsePlan(planContent)` → `taskEntry?.verify` chain with: if `isDbAvailable()`, use `getTask(mid, sid, tid)?.verify`. Else fall back to existing disk code.
   - Remove `parsePlan` and `loadFile` from imports. The remaining code in the file doesn't use either.

3. **parallel-eligibility.ts** — Migrate `collectTouchedFiles()`:
   - Add import: `import { isDbAvailable, getMilestoneSlices, getSliceTasks } from "./gsd-db.js"`.
   - Replace `collectTouchedFiles()` body: if `isDbAvailable()`, use `getMilestoneSlices(milestoneId)` for slice list, then for each slice `getSliceTasks(milestoneId, slice.id)` → `flatMap(t => JSON.parse(t.files) or t.files)` for file paths. Note: `TaskRow.files` is `string[]` (already parsed by the getter). Else fall back to existing disk code.
   - Remove `parseRoadmap`, `parsePlan`, `loadFile` from imports. The file still imports `resolveMilestoneFile` and `resolveSliceFile` for the disk fallback path.

4. Verify no parser references remain in migrated call sites:
   - `rg 'parseRoadmap' src/resources/extensions/gsd/auto-dispatch.ts` — should return zero matches
   - `rg 'parsePlan|parseRoadmap' src/resources/extensions/gsd/auto-verification.ts` — zero matches
   - `rg 'parsePlan|parseRoadmap' src/resources/extensions/gsd/parallel-eligibility.ts` — zero matches

5. Run existing test suites to confirm no regressions (these files are exercised indirectly by integration tests).

## Must-Haves

- [ ] auto-dispatch.ts: 3 rules use `getMilestoneSlices()` instead of `parseRoadmap()`, with disk fallback
- [ ] auto-verification.ts: uses `getTask()?.verify` instead of `parsePlan()`, with disk fallback
- [ ] parallel-eligibility.ts: uses `getMilestoneSlices()` + `getSliceTasks()` instead of parsers, with disk fallback
- [ ] `parseRoadmap` removed from auto-dispatch.ts import
- [ ] `parsePlan` and `loadFile` removed from auto-verification.ts imports
- [ ] `parseRoadmap`, `parsePlan`, `loadFile` removed from parallel-eligibility.ts imports

## Verification

- `rg 'parseRoadmap' src/resources/extensions/gsd/auto-dispatch.ts` returns no matches
- `rg 'parsePlan|parseRoadmap' src/resources/extensions/gsd/auto-verification.ts` returns no matches
- `rg 'parsePlan|parseRoadmap' src/resources/extensions/gsd/parallel-eligibility.ts` returns no matches
- No TypeScript compilation errors in the modified files (check via `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types -e "import './src/resources/extensions/gsd/auto-dispatch.ts'; import './src/resources/extensions/gsd/auto-verification.ts'; import './src/resources/extensions/gsd/parallel-eligibility.ts'"` or equivalent)

## Inputs

- `src/resources/extensions/gsd/auto-dispatch.ts` — 656-line file, 3 rules using `parseRoadmap()` at lines ~176, ~507, ~564
- `src/resources/extensions/gsd/auto-verification.ts` — 233-line file, `parsePlan()` at line ~71
- `src/resources/extensions/gsd/parallel-eligibility.ts` — 233-line file, `parseRoadmap()` + `parsePlan()` in `collectTouchedFiles()`
- `src/resources/extensions/gsd/gsd-db.ts` — `isDbAvailable()`, `getMilestoneSlices()`, `getSliceTasks()`, `getTask()`

## Observability Impact

- **Signals changed:** `isDbAvailable()` gate in each migrated caller emits `process.stderr.write` diagnostic when DB is unavailable, making fallback events visible in auto-mode logs.
- **Inspection:** Future agents can confirm migration by `rg 'parseRoadmap|parsePlan' <file>` returning zero matches. DB queries are visible in SQLite `slices`/`tasks` tables.
- **Failure visibility:** All three files fall back to disk parsing when DB is not open — no hard failures from DB unavailability. Disk-parse fallback is silent (same behavior as before migration).

## Expected Output

- `src/resources/extensions/gsd/auto-dispatch.ts` — 3 rules migrated to DB queries
- `src/resources/extensions/gsd/auto-verification.ts` — task verify lookup migrated to DB query
- `src/resources/extensions/gsd/parallel-eligibility.ts` — file collection migrated to DB queries
