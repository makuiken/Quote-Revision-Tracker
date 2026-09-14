import { randomUUID } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";
import { apiLimiter } from "./lib/rateLimiters";
import healthRouter from "./routes/health";
import {
  recordHttpResponse,
  recordOperationalFailure,
} from "./lib/operationalSignals";

const app: Express = express();
const requestTimeoutMs = Number(process.env.API_REQUEST_TIMEOUT_MS ?? "30000");

// Trust the first proxy hop (Replit's reverse proxy) so that rate limiters
// key on the real client IP rather than the proxy address. Without this all
// requests appear to come from the same proxy IP and share a single quota.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    genReqId(_req, res) {
      const id = randomUUID();
      res.setHeader("X-Request-Id", id);
      return id;
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

const operationalMetrics: RequestHandler = (req, res, next) => {
  const startedAt = performance.now();
  const abortController = new AbortController();
  res.locals.requestAbortSignal = abortController.signal;
  const deadline = setTimeout(() => {
    abortController.abort(new Error("API request deadline exceeded."));
    recordOperationalFailure("http_timeout");
    req.log.error({ signal: "request_timeout" }, "API request timed out");
    if (res.headersSent) {
      res.destroy();
    } else if (req.method === "GET" || req.method === "HEAD") {
      res.status(504).json({
        error: "The request timed out.",
        requestId: String(req.id),
      });
    } else {
      // Never tell a mutation caller that work was rolled back when an
      // underlying database operation may already be committing.
      res.destroy();
    }
  }, requestTimeoutMs);
  deadline.unref();
  const finish = () => {
    clearTimeout(deadline);
    recordHttpResponse(res.statusCode, performance.now() - startedAt);
  };
  res.once("finish", finish);
  res.once("close", () => {
    clearTimeout(deadline);
    if (!res.writableFinished) abortController.abort();
  });
  next();
};
app.use(operationalMetrics);

const normalizeServerErrors: RequestHandler = (_req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (
      res.statusCode >= 500 &&
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      !("requestId" in body)
    ) {
      return sendJson({ ...body, requestId: String(res.req.id) });
    }
    return sendJson(body);
  }) as typeof res.json;
  next();
};
app.use(normalizeServerErrors);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// Probes are intentionally dependency-free from authentication and rate
// limiting. Readiness performs its own short, cached dependency checks.
app.use("/api", healthRouter);

// General API rate limit — applied before body parsing so oversized or
// malformed requests from rate-limited IPs are rejected immediately.
app.use("/api", apiLimiter);

// The public signoff PUT route accepts signature drawings. Mount a 500 KB
// JSON parser at this path BEFORE the global 2 MB parser so that oversized
// payloads are rejected at parse time (body-parser skips re-parsing once a
// request has already been parsed, so first match wins).
app.use("/api/public/signoff", express.json({ limit: "500kb" }));

// All other routes get the full 2 MB limit.
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

app.use((_req, res) => {
  res.status(404).json({
    error: "API route not found.",
    requestId: String(res.req.id),
  });
});

const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const candidateStatus = Number((err as { status?: unknown }).status);
  const status =
    Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus < 500
      ? candidateStatus
      : 500;
  const logContext = {
    err,
    requestId: req.id,
    signal: status >= 500 ? "api_failure" : "request_rejected",
    statusCode: status,
  };
  if (status >= 500) req.log.error(logContext, "API request failed");
  else req.log.warn(logContext, "API request rejected");
  res.status(status).json({
    error:
      status === 500
        ? "An unexpected error occurred."
        : "The request could not be processed.",
    requestId: String(req.id),
  });
};
app.use(errorHandler);

export default app;
