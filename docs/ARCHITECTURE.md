# Metric Studio — Architecture

Metric Studio replaces an Excel-based data-planning workbook with a browser
application for **metric governance**. This document is the source of truth
for the Phase 1 implementation and the contract that later phases (Excel
import staging, SharePoint persistence, presence) must respect.

---

## 1. The model, restated

Five concepts. They are stored, edited and validated separately, and they all
point at the same canonical metric identity.

| Concept | Question it answers | Owns |
| --- | --- | --- |
| **Metric Master** | *What is this thing?* | identity (`id`), `code`, name, aliases, definition, unit, owner, status |
| **Structural Hierarchy** | *Where does it belong for governance?* | folder-like nodes; a metric is *placed* into a node through a link record |
| **Scenario Binding** | *How is the value obtained in scenario X?* | one record per **Metric × Scenario** (`TT` = actual, `GD` = planning): Source / Formula / Assumption / None |
| **Dimension** | *Along which axes can it be sliced?* | dimensions, their member hierarchy, and Metric ↔ Dimension links |
| **Dependency Graph** | *What does it depend on mathematically?* | **derived** from Formula bindings; never edited by hand |

```
                         METRIC MASTER  (one record per metric, immutable id)
                              |
          +-------------------+-------------------+
          |                   |                   |
          v                   v                   v
 Structural Hierarchy     Dimensions          Bindings (Metric × Scenario)
 "where is it?"         "slice by what?"     TT / GD : Source | Formula | Assumption | None
   MetricStructure       MetricDimension           |
                                                   v  (only Formula bindings)
                                             FormulaParser
                                                   |
                                                   v
                                         Dependency Graph (cached edges,
                                         nodes = Metric × Scenario)
```

Invariants the code enforces (and tests cover):

1. A metric exists **once**. TT and GD are bindings of the same metric, never
   two catalogs. Legacy `TT-*` / `GD-*` codes are stored on the *binding* as
   `legacyCode`, not on the metric.
2. `Metric.id` never changes. `Metric.code` is an identifier, not an address:
   it encodes no hierarchy, dimension or scenario.
3. Moving a metric between structure nodes touches only `MetricStructure`
   records. Bindings and formulas are byte-for-byte unchanged.
4. Saving a binding touches only the `Binding` record. Structure placement is
   unchanged.
5. Dimension members never create metrics. `Revenue` sliced by `Product` is
   one metric plus one `MetricDimension` link.
6. Dependency edges are regenerated from `Binding.parsedReferences`; there is
   no user-editable edge table.
7. A formula that references an unknown code is **flagged**, never silently
   turned into a new metric. Creating a draft metric from a reference is an
   explicit action that asks for structural placement.
8. Cross-scenario references (`[TT:REVENUE]` inside a GD formula) are
   first-class: an edge carries both the source scenario and the target
   scenario.

---

## 2. Module structure

```
index.html                       <script type="module" src="./src/app.js">
css/
  tokens.css                     design tokens (colour, spacing, radius, motion)
  app.css                        shell + layout
  components.css                 buttons, chips, table, tree, drawer, graph, toast
src/
  app.js                         bootstrap: repository → store → services → router → views
  core/
    models/
      metric.js                  createMetric, MetricStatus, MetricRole
      binding.js                 createBinding, BindingType
      structure.js               createStructureNode, createMetricStructure
      dimension.js               createDimension, createDimensionMember, createMetricDimension
      scenario.js                createScenario, DEFAULT_SCENARIOS
      unit.js                    createUnit
    store/
      events.js                  EventBus (on / off / emit)
      store.js                   in-memory normalised state, per-collection revisions
      selectors.js               memoised read models & indexes (tree, coverage, search, reference lookup)
  repositories/
    repository.js                Repository contract, COLLECTIONS, tokenOf, ConflictError, NotFoundError
    memory-repository.js         reference implementation: plan → commit → apply, uniqueness, restore points
    local-repository.js          IndexedDB adapter (one transaction per plan, schema v2)
    sharepoint-repository.js     adapter skeleton: list mapping + ETag→version notes, no logic yet
  services/
    formula-parser.js            text → tokens → AST → references (pure)
    metric-service.js            metric CRUD, code allocation, reference suggestions
    structure-service.js         node CRUD/move/reorder, metric placement
    binding-service.js           binding CRUD, formula parse + reference resolution, draft-from-reference
    dimension-service.js         dimension / member / link CRUD
    dependency-service.js        cached edge index, subgraph extraction, cycle detection
    validation-service.js        rule engine → issues (pure)
    snapshot-schema.js           schema boundary: validate, normalise and repair anything coming from outside
    unit-of-work.js              a set of writes that lands together, mirrored into the store as one change
    backup-service.js            JSON export, validated import, restore points
    presence-service.js          PresenceService interface + local no-op implementation
  data/
    seed.js                      demo snapshot + large synthetic dataset generator
  features/
    metric-master/               view (tree + table + drawer wiring), metric drawer
    bindings/                    coverage view
    dependency/                  focused graph view
    dimensions/                  dimension master data
    master-data/                 units & scenarios
    import-export/               backup, reset, large demo
    warnings/                    warning center
  ui/
    dom.js                       safe DOM helpers (no innerHTML with user strings)
    i18n.js                      UI strings (en / vi)
    router.js                    hash router
    components/                  chip, confirm dialog, dropdown menu, collapsible section, combobox
    drawer/drawer.js             right-side contextual drawer
    table/virtual-list.js        windowed list for long tables
    tree/tree.js                 structure / member tree with expand-collapse + drag/drop
    graph/graph-layout.js        layered layout (pure, tested)
    graph/graph-view.js          pan / zoom / fit canvas, node + edge rendering
    toast/toast.js               non-blocking feedback
  utils/                         id, debounce, text normalisation, time
tests/                           node:test suites over pure modules
scripts/serve.mjs                zero-dependency static server for local development
```

Layering rule (enforced by convention and by tests importing services without
a DOM): **UI → Services → Repository → Store**. UI modules never import a
repository; repository modules never import UI or services; the store is a
dumb in-memory cache that services keep in sync with what the repository
acknowledged.

---

## 3. Schemas

All records are plain JSON objects. `id` is an immutable UUID. `version` is an
integer incremented by the repository on every successful save and is the
optimistic-concurrency token (`expectedVersion`). `createdAt` / `updatedAt`
are ISO strings.

```js
// Every record also carries: version (integer, for humans) and
// concurrencyToken (opaque, for optimistic concurrency).
Metric {
  id, code,                 // code: "M.000012" — identification, not an address
  name, aliases: [],        // aliases are also valid formula references
  definition, unitId, owner,
  role,                     // 'metric' | 'kpi' | 'indicator' | 'index' | ''
  status,                   // 'draft' | 'approved' | 'deprecated'
  tags: [],                 // free metadata
  createdAt, updatedAt, version
}

StructureNode   { id, parentId|null, code, name, sortOrder, createdAt, updatedAt, version }
MetricStructure { id, metricId, structureNodeId, isPrimary, createdAt, updatedAt, version }

Scenario        { id, code: 'TT'|'GD', name, sortOrder, version }

Binding {
  id, metricId, scenarioId,             // unique per (metricId, scenarioId)
  type,                                 // 'source' | 'formula' | 'assumption' | 'none'
  legacyCode,                           // e.g. "TT-KD008" preserved from the workbook
  source:     { system, dataset, field, owner, frequency, note },
  formulaText,
  parsedReferences: [{                  // cached output of FormulaParser + resolver
      raw, token, scenarioCode|null, metricId|null, scenarioId|null,
      dimensionContext|null, status: 'resolved'|'missing'|'ambiguous'|'unknown-scenario'
  }],
  formulaErrors: [{ message, position }],
  assumption: { value, basis, validFrom, validTo, note },
  status,                               // 'draft' | 'approved'
  note, createdAt, updatedAt, version
}

Dimension       { id, code, name, description, createdAt, updatedAt, version }
DimensionMember { id, dimensionId, parentId|null, code, name, level, aliases: [], sortOrder, version, ... }
MetricDimension { id, metricId, dimensionId, required, maxLevel|null, allowedMemberIds|null,
                  scenarioOverride|null, version, ... }

Unit            { id, code, name, version, ... }

// Derived, cached in DependencyService, never persisted:
DependencyEdge  { bindingId, fromMetricId, fromScenarioId,
                  targetMetricId|null, targetScenarioId, token,
                  dimensionContext|null, isCrossScenario, resolved }
```

Formula reference grammar (Phase 1):

```
reference   := '[' [scenario ':'] identifier [ '|' context ] ']'
scenario    := TT | GD              (any known scenario code)
identifier  := metric code | alias | exact name     (case-insensitive)
context     := key '=' value (';' key '=' value)*    (kept as text for later dimension context)
expression  := numbers, + - * / ^, parentheses, function calls (SUM, AVG, ...)
```

The parser is a recursive-descent parser producing an AST; references are
extracted from tokens even when the expression fails to parse, so a formula
with a typo still shows what it *tried* to reference.

---

## 4. Data flow

```
   user action in a view / drawer
          │
          ▼
   Service (business rule, validation, parse, cascade)
          │  repo.save(collection, record, expectedVersion)
          ▼
   Repository adapter  ── Local: IndexedDB (memory mirror, write-through)
          │              ── SharePoint (later): list item, ETag ⇄ version
          │  returns the acknowledged record (new version) or throws ConflictError
          ▼
   Store.upsert(collection, record)   → bumps collection revision
          │
          ▼
   EventBus 'change' {collection, ids}  → views re-render only what they subscribe to
          │
          ▼
   Selectors / DependencyService / Validation recompute lazily (memoised on revisions)
```

Conflict handling: a save with a stale concurrency token throws
`ConflictError { current }`. The drawer shows *Reload* / *Keep editing*; it
never overwrites. Presence ("Trung is editing Revenue · GD") is a separate
`PresenceService`; it is UX only and the token check remains the real guard.

### 4.1 Integrity rules (v0.2)

Four rules hold at the persistence boundary, and the failure-injection suite
in `tests/integrity.test.mjs` keeps them honest.

**A write is acknowledged only when it is durable.** Every mutation is
planned, committed, then applied: the in-memory mirror is updated *after* the
backing store confirms, never before. A failed write leaves the mirror and
the database identical.

**Multi-record operations are one transaction.** Services describe a
`UnitOfWork` and the repository applies it atomically; the IndexedDB adapter
opens a single transaction across every object store the plan touches. This
covers cascading deletes (metric plus its bindings, placements and dimension
links), re-homing a structure node's contents, re-levelling a member subtree,
and `replaceAll` (clear plus insert). Half a cascade is not a state the app
can reach. The acknowledged result is pushed into the store with
`Store.applyChanges`, so no listener observes a half-applied batch either.

**Version and concurrency token are different things.** `version` is the
domain revision, an integer meant for humans ("you opened v12, the current one
is v13"). `concurrencyToken` is an opaque value the backend owns: local
adapters derive it from the version, a SharePoint adapter will put its ETag
there verbatim. Nothing outside a repository adapter parses it, compares it
with `<`/`>`, or does arithmetic on it. A record written before tokens
existed still works, because `tokenOf` falls back to the version.

**Structural uniqueness is enforced where the data lives, not in the UI.**
One binding per Metric × Scenario, one placement per Metric × Node, one link
per Metric × Dimension. `UNIQUE_KEYS` in `core/collections.js` is the list a
SharePoint adapter will mirror with indexed unique columns. Business codes
are deliberately *not* in that list: a legacy workbook does contain duplicate
metric codes, and those must arrive and be reported by the warning centre
rather than blocking the import.

### 4.2 The schema boundary

Everything entering the app from outside goes through `parseSnapshot`, which
answers three questions:

| Question | Output | Effect |
| --- | --- | --- |
| Is the file structurally sound? | `errors` | import refused |
| What had to be repaired? | `repairs` | applied and reported |
| What will actually be imported? | `data` | fully normalised records |

Refused outright: invalid JSON, a record without an id, duplicate ids, a
metric with no name, and a *truncated* file — one where a whole collection is
missing while another references it (bindings without scenarios, placements
without groups). That last case is the one that used to be able to empty half
the database silently.

Repaired and reported: orphan records dropped, duplicate composite keys
dropped, parent cycles broken, member levels recomputed from real depth,
dangling unit references cleared, cached formula references reset so they
re-resolve. Because every record comes out of the model factories, no view
can meet a field an imported record happened not to have.

Import always replaces, so a file that omits a collection empties it. The
preview says exactly how many records that would delete, before the
confirmation dialog.

### 4.3 Restore points

Before every import, reset, clear and restore, the repository writes a full
snapshot to a separate IndexedDB store (the three most recent are kept).
Destructive operations are therefore undoable from the Import / Export page,
and the toast offers *Undo* directly. If a restore point cannot be written,
the operation still runs — a user whose storage is full needs clearing to
work — but the UI says plainly that it cannot be undone.

---

## 5. Screens

| Route | Layout | Interaction |
| --- | --- | --- |
| `#/metrics` (default) | left: structure tree with counts · center: virtualised metric table · right: metric drawer | select node → filter list; click row → drawer; search (code, name, alias, definition) debounced; compact filters + collapsible advanced |
| `#/bindings` | coverage table: Metric · TT · GD · Warnings | filter All / TT-only / GD-only / Both / None; row click opens drawer on Bindings |
| `#/dependencies` | root picker + scenario (TT / GD / Cross) + depth; pan/zoom canvas; node panel | click node → highlight ancestors/descendants; double-click → re-root; expand/collapse fringe |
| More ▾ `#/dimensions` | dimension list + member tree | add / rename / move members |
| More ▾ `#/master-data` | units, scenarios | small tables |
| More ▾ `#/backup` | JSON export / import, reset demo, large dataset | Excel staging is Phase 2 (documented placeholder) |
| ⚠ badge `#/warnings` | warning center | click → jumps to the metric / binding / dimension |

Metric drawer sections: **Definition · Structure · Dimensions · Bindings
(TT | GD tabs) · Advanced (collapsed)**. Binding fields appear only after a
type is chosen. Missing references show suggestions and an explicit *Create
draft metric* action that asks for a structure node.

Keyboard: `Esc` closes drawer / menus; `Ctrl/Cmd+S` saves the drawer;
`Enter` picks the highlighted suggestion; `/` focuses search.

---

## 6. Ambiguities and risks (decisions taken)

* **Reference identity vs readability.** `[REVENUE]` is readable, but names
  change. Decision: references resolve against code → alias → exact name at
  save time and the resolved `metricId` is cached in `parsedReferences`.
  The graph uses the cached id when the metric still exists and only falls
  back to re-resolving the token when it does not. Ambiguous matches are an
  error, never a guess.
* **Which scenario a bare reference means.** Same scenario as the binding.
  Cross-scenario needs the explicit prefix. Validation warns when the target
  metric has no binding in the referenced scenario.
* **Multiple structural placements.** Allowed (`isPrimary` marks the main
  one) because governance views sometimes need a metric in two folders; the
  tree counts a metric once per node, and the "All" count is deduplicated.
* **Deleting a structure node with content.** Refused unless the user
  chooses to move contents to the parent; nothing is cascaded silently.
* **Deleting a metric that formulas reference.** Allowed with confirmation;
  the referencing bindings keep their text and become *missing reference*
  warnings. This is the safe, visible failure.
* **Large datasets.** Indexes are rebuilt lazily per collection revision
  (O(n), sub-millisecond at 5k). The table is windowed, search is debounced
  and runs over a cached normalised string, the graph never renders more
  than the requested subgraph, and validation runs debounced after changes.
* **IndexedDB availability.** When it is unavailable (private mode, some
  `file://` contexts) the LocalRepository degrades to memory and the UI
  shows a "not persisted" hint; JSON export still works.
* **SharePoint.** Not implemented. The adapter file documents the list
  mapping so that Phase 3 replaces one file. The two contracts it must
  satisfy are already in place: `concurrencyToken` is opaque (its ETag drops
  straight in) and `UNIQUE_KEYS` names the relationships its lists must
  enforce with indexed unique columns.
* **Atomicity beyond one backend.** `applyBatch` is all-or-nothing, and an
  adapter that cannot guarantee that must say so in
  `describe().atomicBatch === false`. SharePoint REST changesets give a
  usable equivalent; if they prove insufficient, the honest answer is to
  report the limitation there rather than to weaken the contract here.
* **Conflict resolution beyond metrics and bindings.** The drawer diffs and
  offers an overwrite for those two. For placements and dimension links,
  which have no local draft, reloading the server record *is* the resolution,
  so that is all it offers. A generic resolver is deliberately deferred until
  a real second writer exists to design against.
