# Metric Studio

A browser workspace for **data planning and metric governance**. It replaces
the Excel workbook used to define master metrics, their structural
classification, Actual (TT) / Planning (GD) bindings, dimensions and formula
dependencies.

Vanilla JavaScript with native ES modules, no build step, no framework.
Data lives in the browser (IndexedDB) and can be exported as JSON; the
repository layer is designed to be swapped for SharePoint later.

## Run it

```sh
npm install          # one dev dependency: fake-indexeddb, for the storage tests
npm start            # zero-dependency static server → http://localhost:8080
npm test             # node:test suites, including the IndexedDB adapter over fake-indexeddb
```

The published site has no dependencies and no build step; `fake-indexeddb`
exists only so that transaction order, unique indexes, schema upgrades and
two-tab races are tested against a real IndexedDB implementation rather than
against the in-memory adapter alone.

`npm start` binds to the loopback interface, serves only `index.html`, `css/`
and `src/`, and sends the same Content-Security-Policy as the deployed site,
so a policy violation shows up in development rather than after a deploy.
Any static file server works (`python3 -m http.server`, VS Code Live Server…);
the app is `index.html` + `css/` + `src/`. Opening `index.html` directly from
disk works in browsers that allow ES modules on `file://`.

On first start the catalogue is seeded with a small demo (28 metrics) that
shows every concept: a shared TT/GD metric, a TT-only metric, a GD-only growth
assumption, an unbound draft, a cross-scenario formula and one deliberately
missing reference so the warning center has something to show.
**Import / Export → Load large dataset** generates 3,000 metrics and 120
dimensions to check performance.

## The five concepts

| | Question | Where in the app |
| --- | --- | --- |
| **Metric Master** | What is this metric? | Catalogue → Metric Master: one row per metric, immutable id, `M.000123` code; click inspects, double-click edits |
| **Structural Hierarchy** | Where does it belong for governance? | Structure → Structure: the hierarchy as a workspace of its own (drag, rename, move, inspect); the same tree scopes the Metric Master grid |
| **Scenario Binding** | How is the value obtained in each scenario? | Logic → Bindings: one row per metric, one cell per scenario; drawer → Bindings for editing; Source / Formula / Assumption / None |
| **Dimension** | Along which axes can it be sliced? | Structure → Dimensions: dimension list, member hierarchy, inspector; drawer → Dimensions on the metric |
| **Dependency Graph** | What does it depend on mathematically? | Logic → Dependencies, derived from Formula bindings, never edited by hand |

Scenarios are yours to define under **More ▾ → Master data** — the demo ships
with *TT* (actual) and *GD* (planning) as two examples, and a planning
process can add as many as it needs. Each is a **binding of the same
metric**, never a second catalogue. Legacy `TT-*` / `GD-*` codes are kept on
the binding as metadata. Moving a metric in the structure never touches its
formulas; saving a formula never moves it.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full model, schemas,
data flow and the decisions taken on ambiguous points.

## Formula references

```
[VOLUME] * [PRICE]                      same-scenario references (code, alias or exact name)
[TT:REVENUE] * (1 + [GROWTH_RATE])      explicit cross-scenario reference
([REVENUE] - [OPEX]) / [REVENUE]        arithmetic, parentheses, MAX(...) style calls
[REVENUE | Product=HRC]                 dimension context (parsed, reserved for later)
```

Nobody remembers every metric name, so the formula box does not ask them to:
typing `[` (or Ctrl+Space, or *Insert a metric reference…*) opens a picker,
and the chosen metric is inserted as a token. Every reference is then boxed
in place — green when it resolves, red when nothing matches, amber when
several do — so the variables read as fixed and checked while the operators
and words between them stay free text.

References are resolved when the binding is saved. A reference that matches
nothing is flagged with suggestions and an explicit **Create draft metric**
action that asks for a structure group; the app never invents metrics from a
typo. Ambiguous matches are errors, not guesses.

## Dependencies as a table

The Dependencies view has a **Table** mode next to the graph: one row per
reference inside a formula — target metric and scenario, source metric and
scenario, sequence in the formula, same- or cross-scenario, dimension
context, and the operator or function the reference is an operand of.
**Import / Export** downloads the same rows as `Dependency edges (CSV)`,
alongside a `Bindings table (CSV)` with one row per metric × scenario and the
formula text. The two are meant to be kept side by side: the formula is the
logic as written; the edge table is what a pipeline builds lineage and
execution order from without parsing formulas itself.

## Working in the app

Every workspace is built the same way: a page header, a **context bar**
(what the page is about — the structure group, the scenarios, the root
metric), a **filter bar** (which rows are hidden; active filters show as
chips), the main grid or tree, and an **Insights** panel on the right.

* **Inspect frequently, edit intentionally.** A single click selects a row, a
  cell or a node and shows it in Insights without opening anything. Double-click,
  `Enter` or the *Edit* button opens the drawer.
* The top bar is grouped by the work: **Overview · Catalogue · Structure · Logic
  · Quality**; groups with several pages get a second row of tabs.
* `/` focuses search · `Enter` opens the first result · `Esc` closes menus and the drawer · `↑ ↓` move the selection · `← →` walk across scenarios in the Bindings matrix
* Views keep their state — selection, filters, scroll position, the graph you were looking at — when you switch pages and come back
* Leaving a metric with unsaved changes, by any route, is refused with *Save all and open* / *Discard and open* on offer
* `Ctrl/Cmd + S` saves the drawer (metric fields and the open binding tab)
* Drag a metric row onto a structure group to move it; drag groups and dimension members to reorganise them
* Click the ⚠ badge for Quality; click an issue to inspect it, double-click to jump to it
* More ▾ holds Master data (units, scenarios), Import / Export, density (comfortable / compact) and the language switch (English / Tiếng Việt)

Saves use optimistic concurrency. If a record was changed elsewhere, the
drawer shows what changed and offers *Reload latest* or an explicit
*Overwrite*; nothing is overwritten silently.

## Your data is hard to lose

* **Every multi-record operation is one transaction.** Deleting a metric takes
  its bindings, placements and dimension links with it, or changes nothing at
  all. The same holds for deleting a structure group, a dimension, and for
  import.
* **Imports are validated before anything is touched.** A file missing a whole
  collection that its own records reference is refused. Orphans, duplicates
  and broken hierarchies inside an otherwise sound file are repaired, and the
  preview lists what was repaired along with what the import adds, updates and
  deletes. Deletions are counted by comparing record ids, so a smaller file
  says so even when the collection stays non-empty.
* **Destructive actions are undoable.** A restore point is written before every
  import, reset and clear; the three most recent are kept and restoring is
  itself undoable. If one cannot be written, the app says so instead of
  pretending.
* **Structural duplicates are impossible.** A metric cannot get two bindings
  for the same scenario, two placements in one group, or two links to one
  dimension. Duplicate business codes are allowed in and reported as findings,
  because legacy workbooks contain them.
* **An upgrade never hides your data.** When the storage schema changes,
  older data is migrated in place; if the database cannot be opened (an older
  tab still holds it, or the upgrade fails) the app says so and offers to
  retry, instead of showing a demo catalogue over data that is still on disk.
* **Two writes cannot cross — including from two tabs.** Every mutation goes
  through one queue, and every expected token is compared again inside the
  transaction that writes, against the database rather than against this
  tab's copy of it. Racing saves end with one winner and one explicit
  conflict, never two silent winners. Canonical codes come from a sequence in
  the database, so two tabs creating a metric at the same moment get two
  different codes.
* **A formula means what it says.** The parsed references on a binding are a
  cache of the formula text. An import that arrives with that cache damaged
  rebuilds it from the formula rather than believing it, so a file can never
  quietly turn a calculated metric into one that depends on nothing.

## Deploy (Cloudflare Workers)

The site is static, so there is no build step. `wrangler.jsonc` publishes the
repository root as the asset directory and `.assetsignore` keeps everything
that is not part of the site out of the upload:

```sh
npm run deploy       # npx wrangler deploy
npm run preview      # npx wrangler dev
```

Connected to Cloudflare Workers Builds, the default deploy command
(`npx wrangler deploy`) works as is — no dashboard settings to change.

**Why `.assetsignore` matters:** the build container installs Wrangler into
the repository, and Wrangler's own `node_modules/workerd` binary is ~148 MiB,
far over Cloudflare's 25 MiB per-asset limit. Without the ignore list the
deploy fails with *Asset too large*. The list also keeps `tests/`, `docs/`,
`scripts/`, `package.json` and `.git` from being served publicly.

`_headers` sends `index.html` with `Cache-Control: no-cache`, so a deploy
never leaves a browser on an old entry point that references modules which no
longer exist.

Any other static host works the same way — serve the repository root (minus
the development directories) and open `index.html`.

## Project layout

```
index.html            entry, loads ./src/app.js as a module
wrangler.jsonc        Cloudflare Workers static-asset config
.assetsignore         files excluded from the published site
_headers              response headers for the published site
css/                  tokens, shell layout, components
src/core/             models, store, selectors
src/repositories/     contract + Memory / IndexedDB adapters, SharePoint skeleton
src/services/         formula parser, dependency graph, validation, schema boundary, unit of work, CRUD services, backup
src/features/         overview, metric-master, structure, bindings, dependency, dimensions, quality, master-data, import-export
src/ui/               dom helpers, i18n, router, density, drawer, virtual list, tree, graph, toast, components
src/ui/workspace/     page header, context bar, insights panel, workspace layout — the grammar every page shares
src/ui/filter/        filter bar + chips · src/ui/hierarchy/  the hierarchy pane Structure and Dimensions share
src/data/seed.js      demo catalogue + large synthetic dataset
tests/                node:test suites
docs/ARCHITECTURE.md  architecture and decisions
```

## Roadmap

* **Phase 1 (this repository):** architecture, LocalRepository, Metric Master,
  structure, drawer, TT/GD bindings, dimensions, formula parser, focused
  dependency graph, validation, JSON backup, tests.
* **Phase 2:** GSM workbook import with a staging / reconciliation step
  (Bảng 1 → structure, Bảng 2.1 / 2.2 → TT / GD candidates, Giá trị chiều →
  dimensions, DIMxx columns → links), dimension hierarchy improvements, richer
  formula syntax, report usage.
* **Phase 3:** SharePointRepository (list per collection, ETag as the
  concurrency token, unique indexed columns for the structural keys),
  presence, SPFx packaging.

Integrity and concurrency hardening (v0.2) is done: transactional writes,
serialised mutations, compare-and-set against the database itself, invariant
guards that run where the records live, sequence-allocated codes,
schema-validated import that re-parses formulas, restore points, uniqueness
enforced by unique indexes, a strict Content-Security-Policy, and
failure-injection plus regression test suites (115 tests, `npm test`).

Still open before a multi-user pilot: reconciliation after a partial batch on
a non-atomic backend, a CI merge gate, and the SharePoint adapter itself.
