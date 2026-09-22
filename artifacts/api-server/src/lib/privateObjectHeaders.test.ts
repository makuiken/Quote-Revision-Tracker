import assert from "node:assert/strict";
import test from "node:test";

import { applyPrivateObjectHeaders } from "./privateObjectHeaders";

test("private object headers override cacheable upstream metadata", () => {
  const headers = new Map<string, string>([
    ["cache-control", "public, max-age=86400, immutable"],
    ["cdn-cache-control", "public, s-maxage=86400"],
    ["surrogate-control", "max-age=86400"],
    ["expires", "Wed, 01 Jan 2031 00:00:00 GMT"],
    ["etag", "\"stale-sensitive-object\""],
    ["last-modified", "Wed, 01 Jan 2025 00:00:00 GMT"],
    ["content-type", "image/png"],
    ["content-length", "123"],
  ]);
  const output = new Map<string, string>([
    ["Cache-Control", "public, max-age=31536000"],
    ["ETag", "\"middleware-validator\""],
  ]);
  const target = {
    setHeader(name: string, value: string) {
      output.set(name.toLowerCase(), value);
    },
    removeHeader(name: string) {
      output.delete(name);
      output.delete(name.toLowerCase());
    },
  };

  applyPrivateObjectHeaders(
    { forEach: (callback) => headers.forEach((value, name) => callback(value, name, {} as Headers)) },
    target,
  );

  assert.equal(output.get("cache-control"), "private, no-store");
  assert.equal(output.get("pragma"), "no-cache");
  assert.equal(output.get("expires"), "0");
  assert.equal(output.get("content-type"), "image/png");
  assert.equal(output.get("content-length"), "123");
  assert.equal(output.has("etag"), false);
  assert.equal(output.has("last-modified"), false);
  assert.equal(output.has("cdn-cache-control"), false);
  assert.equal(output.has("surrogate-control"), false);
});