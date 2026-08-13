import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as tls from "tls";

import { createAuthHeaders } from "../src/lan/auth";
import { createServerIdentity } from "../src/lan/certificate";
import {
  fetchLanEntry,
  headLanEntry,
  pairWithLanServer,
  pingLanPeer,
  putLanEntry,
  type LanPeerConnection,
} from "../src/lan/client";
import {
  discoveryTxtForTesting,
  isPrivateLanAddress,
} from "../src/lan/discovery";
import {
  createLanServerAuthenticator,
  startLanServer,
  type LanServerHandle,
} from "../src/lan/server";
import type { LanAuthorizedClient } from "../src/lan/types";

const temporaryRoots: string[] = [];
const serverHandles: LanServerHandle[] = [];

const temporaryRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easlc-lan-transport-"));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(serverHandles.splice(0).map((server) => server.close(50)));
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const activeClient = (write = true): LanAuthorizedClient => {
  const now = new Date().toISOString();
  return {
    clientId: crypto.randomBytes(32).toString("base64url"),
    secret: crypto.randomBytes(32).toString("base64url"),
    capabilities: { read: true, write },
    status: "active",
    pairingId: null,
    createdAt: now,
    updatedAt: now,
  };
};

describe("authenticated HTTPS LAN transport", () => {
  it("pairs, acknowledges, pings, and transfers an exact entry", async () => {
    const root = temporaryRoot();
    const identity = await createServerIdentity();
    const clients = new Map<string, LanAuthorizedClient>();
    const packageBytes = Buffer.from("ELCWIRE1-test-package");
    const packagePath = path.join(root, "served.wire");
    fs.writeFileSync(packagePath, packageBytes, { mode: 0o600 });
    const packageSha256 = crypto
      .createHash("sha256")
      .update(packageBytes)
      .digest("hex");
    const entryId = "a".repeat(64);
    let importedBytes: Buffer | null = null;
    const pairingCapability = crypto.randomBytes(32).toString("base64url");
    const pairingExpiresAt = new Date(Date.now() + 60_000).toISOString();

    const server = await startLanServer({
      certificatePem: identity.certificatePem,
      privateKeyPem: identity.privateKeyPem,
      serverId: identity.peerId,
      allowWrite: true,
      incomingDirectory: path.join(root, "incoming"),
      authenticate: createLanServerAuthenticator({
        findClient: (clientId) => clients.get(clientId) ?? null,
        allowPendingClient: (client, request) =>
          request.pathname === "/v1/pair/ack" && client.pairingId !== null,
      }),
      pair: (body) => {
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          Object.keys(body).sort().join(",") !== "capability,clientId" ||
          !("clientId" in body) ||
          typeof body.clientId !== "string" ||
          !("capability" in body) ||
          body.capability !== pairingCapability
        ) {
          throw new Error("bad-pair");
        }
        const client = activeClient();
        client.clientId = body.clientId;
        client.status = "pending";
        client.pairingId = crypto.randomBytes(16).toString("base64url");
        clients.set(client.clientId, client);
        return {
          pairingId: client.pairingId,
          serverId: identity.peerId,
          secret: client.secret,
          capabilities: client.capabilities,
          expiresAt: pairingExpiresAt,
        };
      },
      acknowledgePairing: (pairingId, authenticated) => {
        const client = clients.get(authenticated.clientId);
        if (!client || client.pairingId !== pairingId) {
          throw new Error("bad-ack");
        }
        client.status = "active";
        client.pairingId = null;
      },
      prepareEntry: (platform, requestedId) =>
        platform === "android" && requestedId === entryId
          ? {
              packagePath,
              sizeBytes: packageBytes.length,
              sha256: packageSha256,
            }
          : null,
      importEntry: (_platform, _entryId, incomingPath) => {
        importedBytes = fs.readFileSync(incomingPath);
        return "created";
      },
    });
    serverHandles.push(server);

    const paired = await pairWithLanServer(
      {
        version: 1,
        host: "127.0.0.1",
        port: server.port,
        serverId: identity.peerId,
        certificatePem: identity.certificatePem,
        expiresAt: pairingExpiresAt,
        capability: pairingCapability,
      },
      crypto.randomBytes(32).toString("base64url")
    );
    expect(clients.get(paired.clientId)?.status).toBe("active");

    const ping = await pingLanPeer(paired);
    expect(ping.serverId).toBe(identity.peerId);
    expect(ping.capabilities).toEqual(["read", "write"]);

    expect(await headLanEntry(paired, "android", entryId)).toEqual({
      sizeBytes: packageBytes.length,
      sha256: packageSha256,
    });
    expect(await headLanEntry(paired, "ios", "b".repeat(64))).toBeNull();

    const destination = path.join(root, "download.wire");
    expect(
      await fetchLanEntry(paired, "android", entryId, destination)
    ).toEqual({ sizeBytes: packageBytes.length, sha256: packageSha256 });
    expect(fs.readFileSync(destination)).toEqual(packageBytes);

    expect(await putLanEntry(paired, "android", entryId, destination)).toBe(
      "created"
    );
    expect(importedBytes as Buffer | null).toEqual(packageBytes);
  });

  it("rejects bad credentials, nonce replay, and a substituted certificate", async () => {
    const root = temporaryRoot();
    const identity = await createServerIdentity();
    const otherIdentity = await createServerIdentity(
      new Date(Date.now() + 1_000)
    );
    const client = activeClient(false);
    let authenticationCalls = 0;
    const entryId = "c".repeat(64);
    const packagePath = path.join(root, "served.wire");
    fs.writeFileSync(packagePath, "wire", { mode: 0o600 });
    const server = await startLanServer({
      certificatePem: identity.certificatePem,
      privateKeyPem: identity.privateKeyPem,
      serverId: identity.peerId,
      incomingDirectory: path.join(root, "incoming"),
      authenticate: createLanServerAuthenticator({
        findClient: (clientId) => {
          authenticationCalls += 1;
          return clientId === client.clientId ? client : null;
        },
      }),
      prepareEntry: () => ({
        packagePath,
        sizeBytes: 4,
        sha256: crypto.createHash("sha256").update("wire").digest("hex"),
      }),
      importEntry: () => "existing",
    });
    serverHandles.push(server);
    const peer: LanPeerConnection = {
      serverId: identity.peerId,
      host: "127.0.0.1",
      port: server.port,
      certificatePem: identity.certificatePem,
      clientId: client.clientId,
      secret: client.secret,
      capabilities: client.capabilities,
    };

    await expect(
      pingLanPeer({
        ...peer,
        secret: crypto.randomBytes(32).toString("base64url"),
      })
    ).rejects.toThrow();

    const timestamp = Math.floor(Date.now() / 1_000);
    const nonce = crypto.randomBytes(16).toString("base64url");
    const replaySigner = (input: Parameters<typeof createAuthHeaders>[0]) =>
      createAuthHeaders({ ...input, timestamp, nonce });
    expect(
      await headLanEntry(peer, "android", entryId, {
        signer: replaySigner,
      })
    ).not.toBeNull();
    await expect(
      headLanEntry(peer, "android", entryId, { signer: replaySigner })
    ).rejects.toThrow();

    const callsBeforeSubstitution = authenticationCalls;
    await expect(
      pingLanPeer({
        ...peer,
        serverId: otherIdentity.peerId,
        certificatePem: otherIdentity.certificatePem,
      })
    ).rejects.toThrow();
    expect(authenticationCalls).toBe(callsBeforeSubstitution);
  });

  it("fails an interrupted upload without an unhandled response rejection", async () => {
    const root = temporaryRoot();
    const identity = await createServerIdentity();
    const packagePath = path.join(root, "large.wire");
    fs.writeFileSync(packagePath, Buffer.alloc(8 * 1024 * 1024, 7));
    const server = tls.createServer(
      {
        cert: identity.certificatePem,
        key: identity.privateKeyPem,
        minVersion: "TLSv1.2",
      },
      (socket) => socket.once("data", () => socket.destroy())
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Interrupted upload fixture did not bind");
    }
    const client = activeClient();
    const peer: LanPeerConnection = {
      serverId: identity.peerId,
      host: "127.0.0.1",
      port: address.port,
      certificatePem: identity.certificatePem,
      clientId: client.clientId,
      secret: client.secret,
      capabilities: client.capabilities,
    };
    try {
      await expect(
        putLanEntry(peer, "android", "f".repeat(64), packagePath, {
          timeoutMs: 2_000,
        })
      ).rejects.toThrow();
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("LAN discovery hints", () => {
  it("accepts only private endpoints belonging to a uniquely paired prefix", () => {
    const peerId = "d".repeat(64);
    const endpoint = discoveryTxtForTesting(
      {
        type: "eas-local-cache",
        port: 4100,
        txt: { v: "1", id: peerId.slice(0, 16), caps: "rw" },
        addresses: ["203.0.113.8", "192.168.10.4"],
      } as never,
      [peerId]
    );
    expect(endpoint).toEqual({
      serverId: peerId,
      host: "192.168.10.4",
      port: 4100,
      capabilities: { read: true, write: true },
    });
    expect(isPrivateLanAddress("127.0.0.1")).toBeTrue();
    expect(isPrivateLanAddress("10.1.2.3")).toBeTrue();
    expect(isPrivateLanAddress("8.8.8.8")).toBeFalse();
  });

  it("rejects extra discovery metadata and ambiguous peer prefixes", () => {
    const prefix = "e".repeat(16);
    const service = {
      type: "eas-local-cache",
      port: 4100,
      txt: { v: "1", id: prefix, caps: "r", project: "secret" },
      addresses: ["127.0.0.1"],
    } as never;
    expect(
      discoveryTxtForTesting(service, [`${prefix}${"1".repeat(48)}`])
    ).toBeNull();
    delete (service as { txt: Record<string, string> }).txt.project;
    expect(
      discoveryTxtForTesting(service, [
        `${prefix}${"1".repeat(48)}`,
        `${prefix}${"2".repeat(48)}`,
      ])
    ).toBeNull();
  });
});
