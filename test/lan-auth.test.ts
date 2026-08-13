import { describe, expect, it } from "bun:test";
import * as crypto from "crypto";
import * as path from "path";

import {
  EMPTY_SHA256,
  NonceReplayGuard,
  canonicalizeAuthInput,
  createAuthHeaders,
  readAuthHeaderValues,
  verifyAuthHeaders,
} from "../src/lan/auth";

const clientId = Buffer.alloc(32, 1).toString("base64url");
const secret = Buffer.alloc(32, 2).toString("base64url");
const timestamp = 1_786_579_200;
const nonce = Buffer.alloc(16, 3).toString("base64url");

describe("LAN HMAC authentication", () => {
  it("does not load certificate generation or discovery in LAN-off startup", async () => {
    const fixture = path.join(import.meta.dir, "fixtures/lan-off-load.ts");
    const child = Bun.spawn([process.execPath, fixture], {
      cwd: path.resolve(import.meta.dir, ".."),
      stdout: "ignore",
      stderr: "inherit",
    });

    expect(await child.exited).toBe(0);
  });

  it("uses a stable canonical message and validates a signed request", () => {
    const canonical = canonicalizeAuthInput({
      clientId,
      method: "GET",
      pathname: `/v1/entries/ios/${"a".repeat(64)}`,
      timestamp,
      nonce,
      contentLength: 0,
      contentSha256: EMPTY_SHA256,
    });
    expect(canonical).toBe(
      [
        "ELCAUTH1",
        clientId,
        "GET",
        `/v1/entries/ios/${"a".repeat(64)}`,
        String(timestamp),
        nonce,
        "0",
        EMPTY_SHA256,
      ].join("\n")
    );

    const headers = createAuthHeaders({
      clientId,
      secret,
      method: "GET",
      pathname: `/v1/entries/ios/${"a".repeat(64)}`,
      contentLength: 0,
      contentSha256: EMPTY_SHA256,
      timestamp,
      nonce,
    });
    const values = readAuthHeaderValues(headers);
    expect(values.signature).toHaveLength(64);
    expect(values.signature).toBe(
      crypto
        .createHmac("sha256", Buffer.from(secret, "base64url"))
        .update(canonical)
        .digest("hex")
    );
    expect(() =>
      verifyAuthHeaders({
        headers: values,
        secret,
        method: "GET",
        pathname: `/v1/entries/ios/${"a".repeat(64)}`,
        contentLength: 0,
        now: timestamp * 1_000,
      })
    ).not.toThrow();
  });

  it("rejects tampering, stale timestamps, malformed input, and repeated nonces", () => {
    const pathname = "/v1/ping";
    const headers = readAuthHeaderValues(
      createAuthHeaders({
        clientId,
        secret,
        method: "GET",
        pathname,
        contentLength: 0,
        contentSha256: EMPTY_SHA256,
        timestamp,
        nonce,
      })
    );
    const replayGuard = new NonceReplayGuard();
    const input = {
      headers,
      secret,
      method: "GET",
      pathname,
      contentLength: 0,
      now: timestamp * 1_000,
      replayGuard,
    };
    verifyAuthHeaders(input);
    expect(() => verifyAuthHeaders(input)).toThrow(
      "Invalid LAN authentication"
    );
    expect(() =>
      verifyAuthHeaders({
        ...input,
        replayGuard: undefined,
        now: (timestamp + 61) * 1_000,
      })
    ).toThrow("Invalid LAN authentication");
    expect(() =>
      verifyAuthHeaders({
        ...input,
        replayGuard: undefined,
        headers: {
          ...headers,
          signature: `${headers.signature.slice(0, 62)}00`,
        },
      })
    ).toThrow("Invalid LAN authentication");
    expect(() =>
      canonicalizeAuthInput({
        clientId,
        method: "GET",
        pathname: "/v1/ping?secret=true",
        timestamp,
        nonce,
        contentLength: 0,
        contentSha256: EMPTY_SHA256,
      })
    ).toThrow("Invalid LAN authentication");
  });

  it("refuses overflowed replay records and supports explicit revocation", () => {
    const guard = new NonceReplayGuard({
      ttlMs: 100,
      maximumPerClient: 1,
      maximumClients: 1,
    });
    const otherNonce = Buffer.alloc(16, 4).toString("base64url");
    expect(guard.consume(clientId, nonce, 1_000)).toBe(true);
    expect(guard.consume(clientId, nonce, 1_000)).toBe(false);
    expect(guard.consume(clientId, otherNonce, 1_000)).toBe(false);
    guard.revoke(clientId);
    expect(guard.consume(clientId, nonce, 1_000)).toBe(true);
    expect(guard.consume(clientId, nonce, 1_101)).toBe(true);
  });
});
