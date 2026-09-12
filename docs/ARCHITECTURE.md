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
    repository.js                Repository contract, COLLECTIONS, ConflictError, NotFoundError
    memory-repository.js         reference implementation (used by tests and as IDB fallback)
    local-repository.js          IndexedDB adapter (write-through over the memory implementation)
    sharepoint-repository.js     adapter skeleton: list mapping + ETag→version notes, no logic yet
  services/
    formula-parser.js            text → tokens → AST → references (pure)
    metric-service.js            metric CRUD, code allocation, reference suggestions
    structure-service.js         node CRUD/move/reorder, metric placement
    binding-service.js           binding CRUD, formula parse + reference resolution, draft-from-reference
    dimension-service.js         dimension / member / link CRUD
    dependency-service.js        cached edge index, subgraph extraction, cycle detection
    validation-service.js        rule engine → issues (pure)
    backup-service.js            JSON snapshot export / import
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

Conflict handling: a save with a stale `expectedVersion` throws
`ConflictError { current }`. The drawer shows *Reload* / *Keep editing*; it
never overwrites. Presence ("Trung is editing Revenue · GD") is a separate
`PresenceService`; it is UX only and the version check remains the real guard.

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
  mapping and the ETag ⇄ version bridge so that Phase 3 replaces one file.
