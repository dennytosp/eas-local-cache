import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  certificateMatchesPeerId,
  createServerIdentity,
  getCertificatePeerId,
  validateServerIdentity,
} from "../src/lan/certificate";
import {
  createPairingOffer,
  decodePairingUri,
  encodePairingUri,
} from "../src/lan/pairing";
import {
  ensureLanState,
  getLanStatePath,
  readLanState,
  updateLanState,
} from "../src/lan/state";

let root: string;
let providerRoot: string;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "eas-lan-state-"))
  );
  providerRoot = path.join(root, "v1");
  fs.mkdirSync(providerRoot, { mode: 0o700 });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("LAN identity and state", () => {
  it("creates a private canonical state file and preserves concurrent updates", async () => {
    const initial = await ensureLanState(providerRoot);
    expect(initial.clientId).toHaveLength(43);
    const statePath = getLanStatePath(providerRoot);
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(statePath)).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(statePath, "utf8")).toBe(
      `${JSON.stringify(initial)}\n`
    );

    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        updateLanState(providerRoot, (state) => {
          const now = new Date(index * 1_000).toISOString();
          state.authorizedClients.push({
            clientId: Buffer.alloc(32, index + 1).toString("base64url"),
            secret: Buffer.alloc(32, index + 10).toString("base64url"),
            capabilities: { read: true, write: false },
            status: "active",
            pairingId: null,
            createdAt: now,
            updatedAt: now,
          });
        })
      )
    );
    const current = readLanState(providerRoot);
    expect(current?.clientId).toBe(initial.clientId);
    expect(current?.authorizedClients).toHaveLength(4);
  });

  it("rejects symlink, broad permissions, unknown fields, and duplicate clients", async () => {
    const initial = await ensureLanState(providerRoot);
    const statePath = getLanStatePath(providerRoot);
    if (process.platform !== "win32") {
      fs.chmodSync(statePath, 0o644);
      expect(() => readLanState(providerRoot)).toThrow(
        "permissions are too broad"
      );
      fs.chmodSync(statePath, 0o600);
    }

    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    raw.extra = true;
    fs.writeFileSync(statePath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    expect(() => readLanState(providerRoot)).toThrow(
      "Invalid LAN state schema"
    );

    delete raw.extra;
    const duplicate = {
      clientId: Buffer.alloc(32, 6).toString("base64url"),
      secret: Buffer.alloc(32, 5).toString("base64url"),
      capabilities: { read: true, write: false },
      status: "active",
      pairingId: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    raw.authorizedClients = [duplicate, duplicate];
    fs.writeFileSync(statePath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    expect(() => readLanState(providerRoot)).toThrow(
      "Duplicate authorized LAN client"
    );

    fs.unlinkSync(statePath);
    const target = path.join(root, "outside.json");
    fs.writeFileSync(target, `${JSON.stringify(initial)}\n`, { mode: 0o600 });
    fs.symlinkSync(target, statePath);
    expect(() => readLanState(providerRoot)).toThrow();
  });

  it("treats a missing LAN file as disabled even when shared state is broad", () => {
    const stateRoot = path.join(providerRoot, "state");
    fs.mkdirSync(stateRoot, { mode: 0o755 });
    if (process.platform !== "win32") fs.chmodSync(stateRoot, 0o755);

    expect(readLanState(providerRoot)).toBeNull();
  });

  it("generates a matching, pinned TLS identity and rejects mismatched keys", async () => {
    const identity = await createServerIdentity(
      new Date("2026-08-13T00:00:00.000Z")
    );
    expect(getCertificatePeerId(identity.certificatePem)).toBe(identity.peerId);
    expect(
      certificateMatchesPeerId(identity.certificatePem, identity.peerId)
    ).toBe(true);
    expect(() =>
      validateServerIdentity(identity, {
        now: new Date("2026-08-14T00:00:00.000Z"),
      })
    ).not.toThrow();

    const other = await createServerIdentity(
      new Date("2026-08-13T00:00:00.000Z")
    );
    expect(() =>
      validateServerIdentity({
        ...identity,
        privateKeyPem: other.privateKeyPem,
      })
    ).toThrow("do not match");
    expect(
      certificateMatchesPeerId(identity.certificatePem, "0".repeat(64))
    ).toBe(false);

    await updateLanState(providerRoot, (state) => {
      state.serverIdentity = identity;
    });
    expect(readLanState(providerRoot)?.serverIdentity).toEqual(identity);
  }, 30_000);
});

describe("LAN pairing code", () => {
  it("round-trips strict pairing data without leaking the capability in errors", async () => {
    const now = new Date("2026-08-13T00:00:00.000Z");
    const identity = await createServerIdentity(now);
    const offer = createPairingOffer(identity, "127.0.0.1", 4_321, {
      now,
      capability: Buffer.alloc(32, 7).toString("base64url"),
    });
    expect(decodePairingUri(offer.uri, { now })).toEqual(offer.payload);
    expect(encodePairingUri(offer.payload)).toBe(offer.uri);
    expect(() =>
      decodePairingUri(offer.uri, {
        now: new Date(now.getTime() + 5 * 60_000),
      })
    ).toThrow("has expired");

    const corrupted = `${offer.uri.slice(0, -1)}!`;
    try {
      decodePairingUri(corrupted, { now });
      throw new Error("Expected pairing decode to fail");
    } catch (error) {
      expect(String(error)).not.toContain(offer.capability);
    }
  }, 30_000);
});
