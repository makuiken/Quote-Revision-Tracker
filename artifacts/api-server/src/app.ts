import express, { type Express } from "express";
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

const app: Express = express();

// Trust the first proxy hop (Replit's reverse proxy) so that rate limiters
// key on the real client IP rather than the proxy address. Without this all
// requests appear to come from the same proxy IP and share a single quota.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
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

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

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

export default app;
