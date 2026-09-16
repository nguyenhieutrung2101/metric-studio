/**
 * Refusals the services share.
 *
 * They live apart from any one service because the rules that raise them do
 * too: the same invariant is asked about by the service that performs an
 * edit, by the planner that previews an import, and by the guard that
 * re-checks it where the data lives.
 */

/** A cascade that missed a dependent the database holds; the caller retries once. */
export class StaleCascadeError extends Error {
  constructor(collection, id) {
    super(`${collection}/${id} appeared after the cascade was planned`);
    this.name = 'StaleCascadeError';
    this.collection = collection;
    this.id = id;
  }
}

/** The operation as asked for is not one this catalogue can accept. */
export class ValidationFailure extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = 'ValidationFailure';
    this.field = field;
  }
}
