/**
 * The error taxonomy. One human-readable string on the wire,
 * no error codes and no field-level validation objects.
 */

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** 400 — malformed body, bad date format, unknown cadence or mood slug. */
export class BadRequest extends ApiFailure {
  constructor(message: string) {
    super(400, message)
  }
}

/** 404 — no such task id or mood slug. */
export class NotFound extends ApiFailure {
  constructor(message: string) {
    super(404, message)
  }
}

/**
 * 401 — no valid session. The client turns this into a trip to /login rather
 * than an error notice: being signed out is not a failure of the gesture.
 */
export class Unauthorized extends ApiFailure {
  constructor(message: string) {
    super(401, message)
  }
}

/**
 * 409 — valid JSON, but the model refuses the gesture. Placing a daily task,
 * placing outside this week, completing an archived task.
 *
 * Every rejection is unreachable through the interface. They exist so that the
 * interface being wrong is a visible error rather than a silent bad write.
 * A 409 means the write did not happen and the client's current view is still accurate.
 */
export class Rejected extends ApiFailure {
  constructor(message: string) {
    super(409, message)
  }
}
