import type { FastifyError, FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { AppError } from "../errors.js";

/**
 * Every error leaves as RFC 9457 problem+json. Messages from AppError are written for clients;
 * anything else is logged in full and reported as a generic 500.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply
        .status(400)
        .type("application/problem+json")
        .send({
          type: "about:blank",
          title: "Bad Request",
          status: 400,
          code: "invalid_request",
          detail: "The request parameters are invalid",
          errors: error.validation.map((v) => ({
            location: error.validationContext,
            path: v.instancePath || "/",
            message: v.message,
          })),
        });
    }

    if (error instanceof AppError) {
      const level = error.statusCode >= 500 ? "warn" : "info";
      request.log[level]({ err: error }, error.message);
      if (error.retryAfterSeconds) reply.header("retry-after", String(error.retryAfterSeconds));
      return reply
        .status(error.statusCode)
        .type("application/problem+json")
        .send(problem(error.statusCode, error.code, error.message));
    }

    // Fastify's own client errors (rate limit, malformed JSON, payload too large).
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply
        .status(error.statusCode)
        .type("application/problem+json")
        .send(problem(error.statusCode, error.code?.toLowerCase() ?? "client_error", error.message));
    }

    request.log.error({ err: error }, "unhandled error");
    return reply
      .status(500)
      .type("application/problem+json")
      .send(problem(500, "internal_error", "Something went wrong"));
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .status(404)
      .type("application/problem+json")
      .send(problem(404, "not_found", `No route for ${request.method} ${request.url.split("?")[0]}`));
  });
}

const TITLES: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

const problem = (status: number, code: string, detail: string) => ({
  type: "about:blank",
  title: TITLES[status] ?? "Error",
  status,
  code,
  detail,
});
