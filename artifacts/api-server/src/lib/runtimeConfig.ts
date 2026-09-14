const LOG_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export type RuntimeConfig = {
  port: number;
  nodeEnv: "development" | "test" | "production";
  requestTimeoutMs: number;
};

function requiredEnvironmentKeys(nodeEnv: RuntimeConfig["nodeEnv"]): string[] {
  const common = [
    "DATABASE_URL",
    "CLERK_PUBLISHABLE_KEY",
    "CLERK_SECRET_KEY",
    "PRIVATE_OBJECT_DIR",
  ];
  return nodeEnv === "production" ? [...common, "SESSION_SECRET"] : common;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const rawNodeEnv = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(rawNodeEnv)) {
    throw new Error("NODE_ENV must be development, test, or production.");
  }
  const nodeEnv = rawNodeEnv as RuntimeConfig["nodeEnv"];
  const missing = requiredEnvironmentKeys(nodeEnv).filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Required environment configuration is missing: ${missing.join(", ")}`);
  }

  const port = Number(env.PORT);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  if (env.LOG_LEVEL && !LOG_LEVELS.has(env.LOG_LEVEL)) {
    throw new Error("LOG_LEVEL is not a supported logging level.");
  }

  if (env.PACKET_WORKER_GLOBAL_SLOTS) {
    const slots = Number(env.PACKET_WORKER_GLOBAL_SLOTS);
    if (!Number.isSafeInteger(slots) || slots < 1 || slots > 4) {
      throw new Error("PACKET_WORKER_GLOBAL_SLOTS must be an integer from 1 through 4.");
    }
  }

  const requestTimeoutMs = Number(env.API_REQUEST_TIMEOUT_MS ?? "30000");
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 120_000) {
    throw new Error("API_REQUEST_TIMEOUT_MS must be an integer from 1000 through 120000.");
  }

  return { port, nodeEnv, requestTimeoutMs };
}