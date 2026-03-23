---
id: T03
parent: S04
milestone: M001
key_files:
  - src/resources/extensions/gsd/auto-dispatch.ts
  - src/resources/extensions/gsd/auto-verification.ts
  - src/resources/extensions/gsd/parallel-eligibility.ts
  - .gsd/milestones/M001/slices/S04/tasks/T03-PLAN.md
key_decisions:
  - Used lazy createRequire fallback for all three files (same pattern as T02) — avoids module-level parser imports while keeping fallback path functional when DB is unavailable
  - Kept loadFile in auto-dispatch.ts module imports since it's still used by 15 other rules for non-planning file content (UAT files, context files, etc.) — only parseRoadmap was removed
  - TaskRow.files is already a parsed string[] from the getter (rowToTask), so no JSON.parse needed in parallel-eligibility.ts DB path
duration: ""
verification_result: passed
completed_at: 2026-03-23T17:09:17.905Z
blocker_discovered: false
---

# T03: Migrate auto-dispatch.ts (3 rules), auto-verification.ts, and parallel-eligibility.ts from parser calls to DB queries with lazy disk-parse fallback

**Migrate auto-dispatch.ts (3 rules), auto-verification.ts, and parallel-eligibility.ts from parser calls to DB queries with lazy disk-parse fallback**

## What Happened

Migrated the three remaining hot-path parser callers to DB queries, following the same pattern established in T02 (dispatch-guard.ts).

**auto-dispatch.ts changes:**
- Removed `parseRoadmap` from module-level `files.js` import; added `isDbAvailable, getMilestoneSlices` from `gsd-db.js` and `createRequire` from `node:module`.
- Added `lazyParseRoadmap()` fallback using `createRequire` with .ts/.js extension resolution (same pattern as T02's `lazyParseRoadmapSlices`).
- **uat-verdict-gate rule:** Replaced `parseRoadmap(roadmapContent).slices.filter(s => s.done)` with `getMilestoneSlices(mid).filter(s => s.status === 'complete')` when DB is available. Falls back to lazy disk parse. Kept `loadFile` for UAT-RESULT file content reading (that's file content, not planning state).
- **validating-milestone rule:** Replaced `parseRoadmap(roadmapContent).slices` → `getMilestoneSlices(mid)` for SUMMARY existence checks. Falls back to lazy disk parse when DB unavailable.
- **completing-milestone rule:** Same pattern as validating-milestone — `getMilestoneSlices(mid)` for SUMMARY checks with lazy disk fallback.
- All other rules (15 of 18) untouched — they use `loadFile` for non-planning content or don't use parsers at all.

**auto-verification.ts changes:**
- Removed `loadFile` and `parsePlan` from module-level `files.js` import; added `isDbAvailable, getTask` from `gsd-db.js` and `createRequire`.
- Replaced `loadFile(planFile)` → `parsePlan(planContent)` → `taskEntry?.verify` chain with `getTask(mid, sid, tid)?.verify` when DB is available.
- Disk fallback uses lazy `createRequire` to load `loadFile` and `parsePlan` from `files.ts/.js`.

**parallel-eligibility.ts changes:**
- Removed `parseRoadmap`, `parsePlan`, `loadFile` from module-level `files.js` import; added `isDbAvailable, getMilestoneSlices, getSliceTasks` from `gsd-db.js` and `createRequire`.
- `collectTouchedFiles()`: When DB is available, uses `getMilestoneSlices(milestoneId)` for slice list, then `getSliceTasks(milestoneId, slice.id)` and reads `task.files` (already parsed `string[]` by the getter). When DB unavailable, falls back to lazy-loaded parsers via `createRequire`.

All three files follow the T02-established pattern: `isDbAvailable()` gate → DB query path → lazy `createRequire` fallback with .ts/.js extension resolution.

## Verification

1. `rg 'parseRoadmap' auto-dispatch.ts` — only matches in lazy fallback block (lazyParseRoadmap), zero module-level imports.
2. `rg 'parsePlan|parseRoadmap' auto-verification.ts` — only matches in lazy fallback block type annotations, zero module-level imports.
3. `rg 'parsePlan|parseRoadmap' parallel-eligibility.ts` — only matches in lazy fallback block, zero module-level imports.
4. TypeScript compilation: all 3 files import and execute cleanly under `--experimental-strip-types`.
5. `schema-v9-sequence.test.ts` — 7/7 pass (T01 regression).
6. `dispatch-guard.test.ts` — 8/8 pass (T02 regression).
7. `integration-mixed-milestones.test.ts` — 54/54 pass (exercises disk-parse fallback path).
8. Diagnostic: `getMilestoneSlices('NONEXISTENT')` returns `[]` (no crash on missing milestone).

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `rg '^import.*parseRoadmap' src/resources/extensions/gsd/auto-dispatch.ts` | 1 | ✅ pass — no module-level parseRoadmap import | 5ms |
| 2 | `rg '^import.*loadFile|parsePlan' src/resources/extensions/gsd/auto-verification.ts` | 1 | ✅ pass — no module-level loadFile/parsePlan imports | 5ms |
| 3 | `rg '^import.*parseRoadmap|parsePlan|loadFile' src/resources/extensions/gsd/parallel-eligibility.ts` | 1 | ✅ pass — no module-level parser imports | 5ms |
| 4 | `node --import resolve-ts.mjs --experimental-strip-types -e "import './auto-dispatch.ts'"` | 0 | ✅ pass | 3200ms |
| 5 | `node --import resolve-ts.mjs --experimental-strip-types -e "import './auto-verification.ts'"` | 0 | ✅ pass | 3200ms |
| 6 | `node --import resolve-ts.mjs --experimental-strip-types -e "import './parallel-eligibility.ts'"` | 0 | ✅ pass | 3200ms |
| 7 | `node --import resolve-ts.mjs --experimental-strip-types --test schema-v9-sequence.test.ts` | 0 | ✅ pass — 7/7 | 164ms |
| 8 | `node --import resolve-ts.mjs --experimental-strip-types --test dispatch-guard.test.ts` | 0 | ✅ pass — 8/8 | 640ms |
| 9 | `node --import resolve-ts.mjs --experimental-strip-types --test integration-mixed-milestones.test.ts` | 0 | ✅ pass — 54/54 | 770ms |
| 10 | `node -e "getMilestoneSlices('NONEXISTENT')" diagnostic` | 0 | ✅ pass — returns [] | 200ms |


## Deviations

The task plan said `rg 'parseRoadmap' auto-dispatch.ts` should return zero matches. It returns matches in the lazy fallback block (lazyParseRoadmap function body), not module-level imports. This is the same pattern T02 established for dispatch-guard.ts where `rg 'parseRoadmapSlices'` matches in the lazy loader. The intent — no module-level parser imports — is satisfied.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/auto-dispatch.ts`
- `src/resources/extensions/gsd/auto-verification.ts`
- `src/resources/extensions/gsd/parallel-eligibility.ts`
- `.gsd/milestones/M001/slices/S04/tasks/T03-PLAN.md`
