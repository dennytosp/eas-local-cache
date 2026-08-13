import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createAuthHeaders } from "../src/lan/auth";
import {
  createLanServerCoordinator,
  type LanPairingWindow,
} from "../src/lan/coordinator";
import { ensureLanState, readLanState } from "../src/lan/state";
import type { LanAuthenticationRequest } from "../src/lan/server";

let root: string;
let providerRoot: string;

beforeEach(async () => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "eas-lan-coordinator-"))
  );
  providerRoot = path.join(root, "v1");
  fs.mkdirSync(providerRoot, { mode: 0o700 });
  await ensureLanState(providerRoot);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const capability = Buffer.alloc(32, 9).toString("base64url");
const clientId = Buffer.alloc(32, 8).toString("base64url");
const serverId = "a".repeat(64);
const startMs = Date.parse("2026-08-13T00:00:00.000Z");

const signedRequest = (
  secret: string,
  nowMs: number,
  overrides: Partial<LanAuthenticationRequest> = {}
): LanAuthenticationRequest => {
  const method = overrides.method ?? "POST";
  const pathname = overrides.pathname ?? "/v1/pair/ack";
  const contentLength = overrides.contentLength ?? 0;
  const contentSha256 =
    overrides.contentSha256 ?? crypto.createHash("sha256").digest("hex");
  const headers = createAuthHeaders({
    clientId,
    secret,
    method,
    pathname,
    contentLength,
    contentSha256,
    timestamp: Math.floor(nowMs / 1_000),
  });
  return {
    clientId,
    timestamp: headers["x-elc-timestamp"],
    nonce: headers["x-elc-nonce"],
    contentSha256,
    signature: headers["x-elc-signature"],
    contentLength,
    method,
    pathname,
    allowPendingPairing: overrides.allowPendingPairing ?? true,
  };
};

const windowAt = (nowMs: number): LanPairingWindow => ({
  capability,
  expiresAt: new Date(nowMs + 5 * 60_000).toISOString(),
  allowWrite: false,
});

const pair = async (
  coordinator: ReturnType<typeof createLanServerCoordinator>
): Promise<{
  pairingId: string;
  secret: string;
  capabilities: { read: boolean; write: boolean };
}> =>
  (await coordinator.pair({ clientId, capability })) as {
    pairingId: string;
    secret: string;
    capabilities: { read: boolean; write: boolean };
  };

describe("LAN server pairing coordinator", () => {
  it("retries one reserved client idempotently and activates only after ACK", async () => {
    let nowMs = startMs;
    const coordinator = createLanServerCoordinator({
      providerRoot,
      serverId,
      pairingWindow: windowAt(nowMs),
      now: () => nowMs,
    });
    const first = await pair(coordinator);
    const retry = await pair(coordinator);
    expect(retry).toEqual(first);
    await expect(
      coordinator.pair({
        clientId: Buffer.alloc(32, 7).toString("base64url"),
        capability,
      })
    ).rejects.toThrow("rejected");

    const authenticated = await coordinator.authenticate(
      signedRequest(first.secret, nowMs)
    );
    expect(authenticated?.clientId).toBe(clientId);
    await coordinator.acknowledgePairing(first.pairingId, authenticated!);
    expect(readLanState(providerRoot)?.authorizedClients[0]).toMatchObject({
      clientId,
      status: "active",
      pairingId: null,
    });

    nowMs += 1_000;
    const activeRequest = signedRequest(first.secret, nowMs, {
      method: "GET",
      pathname: "/v1/ping",
      allowPendingPairing: false,
    });
    expect(await coordinator.authenticate(activeRequest)).not.toBeNull();
    await expect(pair(coordinator)).rejects.toThrow("rejected");
  });

  it("does not authorize pending credentials after expiry or server restart", async () => {
    let nowMs = startMs;
    const coordinator = createLanServerCoordinator({
      providerRoot,
      serverId,
      pairingWindow: windowAt(nowMs),
      now: () => nowMs,
    });
    const paired = await pair(coordinator);
    const beforeExpiry = await coordinator.authenticate(
      signedRequest(paired.secret, nowMs)
    );
    expect(beforeExpiry).not.toBeNull();

    const restarted = createLanServerCoordinator({
      providerRoot,
      serverId,
      pairingWindow: null,
      now: () => nowMs,
    });
    expect(
      await restarted.authenticate(signedRequest(paired.secret, nowMs))
    ).toBeNull();

    nowMs += 5 * 60_000;
    expect(
      await coordinator.authenticate(signedRequest(paired.secret, nowMs))
    ).toBeNull();
    await expect(
      coordinator.acknowledgePairing(paired.pairingId, beforeExpiry!)
    ).rejects.toThrow("acknowledgement failed");
    await coordinator.discardPendingPairing();
    expect(readLanState(providerRoot)?.authorizedClients).toEqual([]);
  });

  it("limits pending authentication to the exact ACK route", async () => {
    const coordinator = createLanServerCoordinator({
      providerRoot,
      serverId,
      pairingWindow: windowAt(startMs),
      now: () => startMs,
    });
    const paired = await pair(coordinator);
    expect(
      await coordinator.authenticate(
        signedRequest(paired.secret, startMs, {
          method: "GET",
          pathname: "/v1/ping",
          allowPendingPairing: true,
        })
      )
    ).toBeNull();
    await expect(
      coordinator.pair({ clientId, capability: `${capability.slice(0, -1)}A` })
    ).rejects.toThrow("rejected");
  });
});
