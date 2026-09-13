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
npm start            # zero-dependency static server → http://localhost:8080
npm test             # node:test suites over the pure modules (no browser needed)
```

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
| **Metric Master** | What is this metric? | default view; one record per metric, immutable id, `M.000123` code |
| **Structural Hierarchy** | Where does it belong for governance? | left tree; folders with counters, drag & drop, multiple placements |
| **Scenario Binding** | How is the value obtained in TT / GD? | drawer → Bindings tabs; Source / Formula / Assumption / None |
| **Dimension** | Along which axes can it be sliced? | drawer → Dimensions; More → Dimensions for member hierarchies |
| **Dependency Graph** | What does it depend on mathematically? | Dependencies view, derived from Formula bindings, never edited by hand |

TT and GD are **bindings of the same metric**, not two catalogues. Legacy
`TT-*` / `GD-*` codes are kept on the binding as metadata. Moving a metric in
the structure never touches its formulas; saving a formula never moves it.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full model, schemas,
data flow and the decisions taken on ambiguous points.

## Formula references

```
[VOLUME] * [PRICE]                      same-scenario references (code, alias or exact name)
[TT:REVENUE] * (1 + [GROWTH_RATE])      explicit cross-scenario reference
([REVENUE] - [OPEX]) / [REVENUE]        arithmetic, parentheses, MAX(...) style calls
[REVENUE | Product=HRC]                 dimension context (parsed, reserved for later)
```

References are resolved when the binding is saved. A reference that matches
nothing is flagged with suggestions and an explicit **Create draft metric**
action that asks for a structure group; the app never invents metrics from a
typo. Ambiguous matches are errors, not guesses.

## Working in the app

* `/` focuses search · `Enter` opens the first result · `Esc` closes the drawer
* `Ctrl/Cmd + S` saves the drawer (metric fields and the open binding tab)
* Drag a metric row onto a structure group to move it; drag groups to reorder or nest them
* Click the ⚠ badge for the warning center; click an issue to jump to it
* More ▾ holds Dimensions, Master data (units, scenarios), Import / Export and the language switch (English / Tiếng Việt)

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
  preview lists exactly what was repaired and what the import would delete.
* **Destructive actions are undoable.** A restore point is written before every
  import, reset and clear; the three most recent are kept and restoring is
  itself undoable. If one cannot be written, the app says so instead of
  pretending.
* **Structural duplicates are impossible.** A metric cannot get two bindings
  for the same scenario, two placements in one group, or two links to one
  dimension. Duplicate business codes are allowed in and reported as findings,
  because legacy workbooks contain them.

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
src/features/         metric-master, bindings, dependency, dimensions, master-data, import-export, warnings
src/ui/               dom helpers, i18n, router, drawer, virtual list, tree, graph, toast, components
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
schema-validated import, restore points, uniqueness at the persistence
boundary, and a failure-injection test suite.
