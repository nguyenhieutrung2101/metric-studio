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
    sharepoint-repository.js     adapter skeleton: list mapping + ETag→concurrencyToken notes, no logic yet
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
integer incremented by the repository on every successful save, for humans to
read; `concurrencyToken` is the opaque value passed back as `expectedToken`
to detect a stale write (see 4.1). `createdAt` / `updatedAt` are ISO strings.

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
DependencyEdge  { bindingId, from, to, fromMetricId, fromScenarioId,
                  targetMetricId|null, targetScenarioId, token,
                  dimensionContexts: [],   // every slice that produced this edge
                  isCrossScenario, resolved }
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
          │  repo.save(collection, record, expectedToken)
          ▼
   Repository adapter  ── Local: IndexedDB (memory mirror, write-through)
          │              ── SharePoint (later): list item, ETag ⇄ concurrencyToken
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

Eight rules hold at the persistence boundary. The failure-injection suite in
`tests/integrity.test.mjs` and the regression suite in
`tests/regressions.test.mjs` keep them honest.

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

**Order is part of the contract, and removes are idempotent.** Operations in
a batch are applied in the order they were queued. An atomic adapter may
ignore that, but a non-atomic one must not: services queue dependent records
before the record they depend on, and mark those removals `optional`, so that
a partial failure degrades into a retryable state instead of orphan records.
This costs nothing on IndexedDB and is what makes a non-transactional backend
tolerable later.

**Writes are serialised, so a check and its write cannot be separated.**
Every mutating repository call goes through one promise queue. A check-then-act
sequence — read the token, compare it, plan the write — spans an `await` on the
durable commit, and two callers interleaving there would both pass the check
and both write: the second silently overwriting the first, and a unique
relationship ending up with two records. The queue makes each mutation
indivisible with respect to the others, so one of the two racers is refused
with `ConflictError` or `UniquenessError`. It costs nothing in the single-user
case, where there is never anything in the queue.

**A removal that found nothing is still reported.** A batch may mark a removal
`optional` when it is cleaning up records it believes exist. When one is
already gone, the batch succeeds and lists it under `alreadyGone` — and in
`removed`, because after the call it is absent either way. The caller's mirror
therefore drops it too; before, the store kept showing a placement the
database no longer had.

**Structural uniqueness is enforced where the data lives, not in the UI.**
One binding per Metric × Scenario, one placement per Metric × Node, one link
per Metric × Dimension. `UNIQUE_KEYS` in `core/collections.js` drives a unique
IndexedDB index on each of those three stores, and is the list a SharePoint
adapter will mirror with indexed unique columns. Business codes are
deliberately *not* in that list: a legacy workbook does contain duplicate
metric codes, and those must arrive and be reported by the warning centre
rather than blocking the import.

**The mirror is a cache; the database decides.** Comparing a token against the
in-memory mirror only speaks for this connection. A second tab has its own
mirror, so both could pass that check and the second would overwrite the
first with no warning. Every expected token therefore travels with the plan
and is compared again inside the readwrite transaction that performs the
write, and a refused write refreshes the mirror from what was actually read,
so the retry is judged against the truth. Uniqueness likewise moves from a
scan of the mirror to the database's own index.

**An invariant that spans records is checked where the records live.**
Serialising writes protects one record at a time. "Does this move create a
cycle?" is a question about the whole hierarchy, and two moves can each see
an acyclic tree, each be allowed, and together produce a cycle. A `UnitOfWork`
can therefore carry a `guard`: a check the adapter re-runs against the
collection it reads inside the writing transaction, aborting the batch if it
throws. `commitExclusive` adds the matching critical section inside one
instance, so both the fast local case and the two-tab case are covered.

**Canonical codes are allocated, not guessed.** Reading the highest existing
code and then writing the record is a check-then-act like any other: three
creates started at once would all read the same maximum. `allocateCode` runs
inside the write queue and keeps a high-water mark, and the IndexedDB adapter
reads and bumps a sequence record inside its own transaction, so two tabs
cannot be handed the same `M.000123`. `nextCode()` survives only as the
placeholder in the create form.

### 4.1b One definition of reference identity

`referenceIdentity(ref)` in the formula parser is the only definition of what
makes two formula references the same, and the parser, the validation rules
and the dependency graph all use it. It combines scenario, metric token and
dimension context, and normalises the token exactly the way references are
resolved to metrics (`referenceKey`, so case, spacing and diacritics do not
matter). That keeps "two references" and "two metrics" from ever disagreeing:
`[Doanh thu]` and `[DOANH THU]` are one reference because they are one metric,
while `[SALES | Product=A]` and `[SALES | Product=B]` are two.

The dependency graph is a dependency between **metrics**, so those two slices
still form a single edge; the edge lists every slice that produced it in
`dimensionContexts` rather than silently keeping the first one.

A reference whose scenario prefix names no scenario — `[XX:REVENUE]` — gets a
node of its own (`unknownScenarioId('XX')`). It must not fall back to the
scenario the formula happens to live in: that would draw an edge to
`REVENUE|TT` and make the graph assert a dependency nobody wrote. The node is
a leaf, is never expanded through, and the side panel says which code is
unknown and where to fix it.

### 4.1c Two budgets on the graph

The graph is derived, so its cost is governed rather than cached away.

**Cycle detection is linear in edges.** Tarjan's walk keeps each frame's
successor list on the frame. Rebuilding it on every step of the walk over that
same list makes one node with N dependencies cost N², which measured 749 ms
for N = 5,000 — on the main thread, on every validation pass.

**A focused subgraph has a node ceiling and an edge ceiling**
(`SUBGRAPH_NODE_LIMIT`, 300; `SUBGRAPH_EDGE_LIMIT`, 900). The breadth-first
expansion stops at either budget, the outermost nodes keep their "more"
markers, and the result is flagged `truncated` so the view says so above the
canvas. One hub metric used by 2,000 others would otherwise lay out 2,001
cards at depth 1 — the one thing the focused graph exists to avoid. The edge
ceiling is the one that matters for cost: layout time and the number of SVG
paths follow edges, and 300 nodes that all depend on each other are 44,850
edges, so a node budget alone bounds nothing. Edges whose endpoint the budget
refused are left out entirely and nodes left unconnected are dropped, so the
layout never has to place an edge with one end missing.

### 4.1c′ Where the data lives is where it is checked

Serialising writes and comparing tokens inside the transaction protect one
record at a time. Three more things had to move into the transaction:

* **Requirements.** `UnitOfWork.require(collection, id)` names a record the
  batch depends on — the parent a node is created under, the metric a binding
  belongs to. The adapter reads it inside the writing transaction and refuses
  with `NotFoundError` if it is gone. Without it, a tab could hang a child on
  a parent another tab had just deleted.
* **Cascade guards.** Deleting a metric collects its dependents from this
  instance's records, then carries a guard that refuses if the database holds
  one the collection missed. The guard hands the database's records to the
  mirror and the cascade retries once with the complete set.
* **Write order.** Deletes are issued before puts, so a batch that frees a
  unique relationship and re-creates it is not refused by the index it is
  about to satisfy — the promise the contract already made.

The sequence that hands out canonical codes reads its floor from the
database in the same transaction, because a mirror cannot know what another
tab imported, and `replaceAll` clears the sequence inside its own
transaction.

### 4.1c″ Schema upgrades

A unique index created over a store that already holds duplicates aborts
the upgrade. That is what an earlier release's data can look like, so each
relationship store is deduplicated inside the upgrade transaction first (the
primary placement wins), and the index is created from the cursor's last
callback. When the database still cannot be opened — an older tab holds it
(`blocked`), the upgrade failed, or a newer tab took it over
(`superseded`) — `describe()` says which, and the app shows a recovery
screen with *Retry* and *Continue without saving*. It never seeds the demo
over a database that exists: `hasExistingData` is true for every failure but
"no IndexedDB at all".

All of this is exercised in `tests/indexeddb.test.mjs` over
`fake-indexeddb`: two repositories on one factory are two tabs of the app,
sharing the database and nothing else.

### 4.1d The cache never outranks the source

`parsedReferences` on a binding is derived from `formulaText`; the formula
text is what a user wrote. An import that accepted a damaged cache would let a
file claim that a formula metric depends on nothing — and it would look
correct, because the formula is still displayed and validation has nothing to
complain about.

So the boundary re-parses — reference by reference. Each reference the
formula states is matched to the cache by *reference identity* (not by
count: a cache can be the right length and still name the wrong metric). A
cached entry whose stable id still exists keeps it, which is how a reference
survives the rename of the metric it points at even when a sibling entry is
damaged; anything the cache cannot answer is resolved against the records in
the file. Syntax errors are always rebuilt from the text, because a broken
formula must arrive flagged whatever its cache said. A binding that is not a
formula keeps no references at all. Each case is reported:
`REFERENCE_REPARSED`, `REFERENCE_DROPPED`, `REFERENCE_RESET`.

Resolution is defined once, in `core/reference-lookup.js`, and used both by
the selectors over the live store and by the boundary over a file being
imported — otherwise a formula could mean one thing during the import and
another one after it.

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

Import always replaces, so the records that disappear are the ones whose id
is not in the file. The preview computes that by comparing id sets, not
counts, and reports additions, updates and deletions before the confirmation
dialog. Comparing counts would miss the ordinary case of a smaller file: 20
incoming metrics replacing 100 deletes 80 of them while the collection stays
non-empty.

The boundary has no back door. `importSnapshot` parses its input again even
when a caller hands it a preview result that claims to be parsed already;
parsing is idempotent and costs about 100 ms on a 3,000 metric snapshot.

### 4.3 Restore points

Before every import, reset, clear and restore, the repository writes a full
snapshot to a separate IndexedDB store (the three most recent are kept).
Destructive operations are therefore undoable from the Import / Export page,
and the toast offers *Undo* directly. If a restore point cannot be written,
the operation still runs — a user whose storage is full needs clearing to
work — but the UI says plainly that it cannot be undone.

---

### 4.4 What the browser is allowed to do

`index.html` has no inline script and no inline event handler, so a strict
policy is nearly free. `_headers` sends
`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`,
which means an injected string can never become a script, a form target or a
base URL, on top of the existing rule that user text is only ever set through
`textContent`.

`scripts/serve.mjs` sends the same headers, binds to the loopback interface,
and serves only what `.assetsignore` leaves in the published site
(`index.html`, `css/`, `src/`); anything else, dotfiles included, is a 404. A
development server that hands `.git` or `package.json` to everyone on the
same café network is a real leak even when the deployed site is configured
correctly. The allow-list is exported and tested rather than swept by hand.

### 4.4b Two tables for the world outside

`DependencyService.edgeRows()` flattens the graph into one row per reference:
target and source metric and scenario, the reference's sequence in the
formula, whether it crosses scenarios, its dimension context, and the
operator or function it is a direct operand of (read off the AST; groups are
transparent). The Dependencies view shows these rows as a table beside the
graph, and Import / Export writes them as `Dependency_Edges` CSV next to a
`Bindings` CSV that carries the formula text. Both are exported because
neither replaces the other: the formula is the logic as its author wrote it;
the edge table is what a pipeline needs to build lineage and execution order
without a parser of its own. `Time_Context` is present in the export and
empty — the model does not carry a time dimension yet.

### 4.5 What the editor owes the person typing

A save is not instant, and people keep typing during one. The drawer sends a
copy of the draft taken at the moment of saving, and when the response comes
back it moves the baseline and the token forward but replaces the draft only
if the draft is still byte-for-byte what was sent. Anything typed meanwhile
survives and the editor stays dirty, so the next save builds on this one.
Every save also carries the sequence number of the drawer that started it: a
response that arrives after the user has opened a different metric updates
nothing, because that editor is not the one that asked — and that holds for
every binding write in a Save loop, for the conflict banner, and for
*Reload latest*, which only ever reloads the metric that is open.

Leaving an editor is guarded by one function, `guardThen(proceed)`, whatever
the route out: a reference link, a row in the table, a tab in the top bar.
The router keeps the previous route so a refused hash change can be put back
without the view noticing. Views stay mounted once opened and are hidden
rather than destroyed, so the scroll position, the filters and the graph a
user left are still there on return; they are rebuilt only when the scenario
list changes, since their columns are baked from it.

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
* **Atomicity beyond one backend.** `applyBatch` is all-or-nothing here, and
  an adapter that cannot guarantee that must say so in
  `describe().atomicBatch === false`. **SharePoint will be such an adapter.**
  It does not roll back a failed multi-item request, and our cascades span
  four different lists, where cross-list atomicity was never on offer at all.
  Designing on the assumption of a rollback would be wrong regardless of how
  changesets are documented. Three things make the loss survivable, and all
  three are already in place:

  1. **Ordering.** Operations are applied in the order queued, and services
     queue dependent records before the record they depend on. A cascade that
     stops halfway leaves a metric with fewer bindings, not bindings pointing
     at a metric that is gone.
  2. **Idempotent removes.** A removal marked `optional` succeeds when the
     record is already gone, so replaying a failed batch is safe.
  3. **Reconciliation through validation.** `PLACEMENT_ORPHAN`,
     `BINDING_ORPHAN` and `METRIC_DIMENSION_ORPHAN` already detect whatever
     does slip through, so the repair path is a rule the warning centre
     surfaces rather than a bespoke mechanism.

  An operation journal remains an option if audit history is wanted for its
  own sake, but it is not a correctness mechanism: writing the journal entry
  is itself not atomic with the data writes. It is a retry and repair log.
* **`replaceAll` will not be ported to SharePoint.** Clearing nine lists and
  re-inserting thousands of items is long, non-atomic, and cannot be made
  safe by ordering. Import there has to become an incremental reconcile
  (diff, upsert, delete), with a JSON export as the safety net instead of a
  restore point.
* **Conflict resolution beyond metrics and bindings.** The drawer diffs and
  offers an overwrite for those two. For placements and dimension links,
  which have no local draft, reloading the server record *is* the resolution,
  so that is all it offers. A generic resolver is deliberately deferred until
  a real second writer exists to design against.
