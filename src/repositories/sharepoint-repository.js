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
 * Concurrency: SharePoint returns an ETag ("odata.etag") on every item; the
 * adapter exposes it as `version` and sends `If-Match: <etag>` on update. A
 * 412 Precondition Failed maps to ConflictError with the freshly fetched
 * current item. `id` is stored in a dedicated indexed text column (StableId)
 * so the immutable app id never depends on SharePoint's numeric item Id.
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
