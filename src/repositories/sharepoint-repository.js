import { Repository, NotImplementedError, COLLECTIONS } from './repository.js';

/**
 * SharePoint adapter — Phase 3 skeleton.
 *
 * Intended mapping (one SharePoint list per collection):
 *
 *   collection        list title            notes
 *   ---------------   -------------------   ----------------------------------------
 *   metrics           MS_Metrics            Title = name; MetricCode; Aliases (multi-line)
 *   structureNodes    MS_StructureNodes     ParentId lookup
 *   metricStructures  MS_MetricStructures   MetricId + StructureNodeId lookups
 *   scenarios         MS_Scenarios
 *   bindings          MS_Bindings           JSON columns for source / assumption /
 *                                           parsedReferences (multi-line text)
 *   dimensions        MS_Dimensions
 *   dimensionMembers  MS_DimensionMembers   ParentId lookup
 *   metricDimensions  MS_MetricDimensions
 *   units             MS_Units
 *
 * Concurrency: SharePoint returns an ETag ("odata.etag") on every item. The
 * adapter puts it in `concurrencyToken` verbatim and sends `If-Match: <etag>`
 * on update; `version` stays the app's own human-readable revision counter
 * and is never derived from the ETag. A 412 Precondition Failed maps to
 * ConflictError with the freshly fetched current item. `id` is stored in a
 * dedicated indexed text column (StableId) so the immutable app id never
 * depends on SharePoint's numeric item Id.
 *
 * Uniqueness: the relationships in `UNIQUE_KEYS` must be enforced by the
 * list itself, with a calculated column holding the composite key and the
 * "enforce unique values" setting on its index. Client-side checks do not
 * survive twenty concurrent users. Business codes are deliberately not
 * enforced there: legacy workbooks contain duplicates that must arrive and be
 * reported.
 *
 * Write consistency: SharePoint does NOT roll back a failed multi-item
 * request, and our cascades span four different lists, where cross-list
 * atomicity was never on offer in the first place. This adapter must
 * therefore report `describe().atomicBatch === false` and apply `plan.ops` in
 * the order given. Services already queue dependent records before the record
 * they depend on, and mark those removals optional, so a partial failure
 * leaves a retryable state rather than orphan records; whatever does slip
 * through is caught by the existing orphan rules in the validation service.
 * `replaceAll` must not be ported as-is: a full import against SharePoint has
 * to become an incremental reconcile (diff, upsert, delete) with a JSON
 * export as the safety net instead of a restore point.
 *
 * This class deliberately contains no fetch logic yet; it exists so that
 * app.js can swap `new LocalRepository()` for `new SharePointRepository(cfg)`
 * without touching services or UI.
 */
export class SharePointRepository extends Repository {
  constructor({ siteUrl = '', listPrefix = 'MS_', fetchImpl = null } = {}) {
    super();
    this.siteUrl = siteUrl;
    this.listPrefix = listPrefix;
    this.fetchImpl = fetchImpl;
    this.listNames = Object.fromEntries(COLLECTIONS.map((c) => [c, `${listPrefix}${c[0].toUpperCase()}${c.slice(1)}`]));
  }

  describe() {
    return { persistent: true, kind: 'sharepoint', detail: this.siteUrl };
  }

  async init() {
    throw new NotImplementedError('SharePointRepository.init');
  }
}
