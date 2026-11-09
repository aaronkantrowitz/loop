/**
 * Errors that map to a specific HTTP response. Anything else becomes a generic 500 and its
 * message is never sent to the client.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, "not_found", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(403, "forbidden", message);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(400, "bad_request", message);
  }
}

/** The upstream API failed or returned something we could not use. */
export class UpstreamError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(502, "upstream_error", message, undefined, options);
  }
}

/** A dependency is temporarily unavailable (rate limited, not configured). */
export class UnavailableError extends AppError {
  constructor(code: string, message: string, retryAfterSeconds?: number) {
    super(503, code, message, retryAfterSeconds);
  }
}
