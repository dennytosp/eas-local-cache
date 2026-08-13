import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { ensureManagedDirectory } from "../src/cache/filesystem";
import { acquireEntryLock, releaseEntryLock } from "../src/cache/lock";
import { readManifest } from "../src/cache/manifest";
import { getCachePaths, getEntryId } from "../src/cache/paths";
import {
  resolveCacheEntryDetailed,
  uploadCacheEntry,
} from "../src/cache/store";
import { createServerIdentity } from "../src/lan/certificate";
import { discoverZstdCodec } from "../src/cache/zstd";
import { createWirePackage } from "../src/lan/export";
import { importWirePackage } from "../src/lan/import";
import {
  createLanServerAuthenticator,
  startLanServer,
  type LanServerHandle,
} from "../src/lan/server";
import { fetchLanEntryToLocal, pushLanEntryToPeer } from "../src/lan/sync";
import type { LanAuthorizedClient, LanOutboundPeer } from "../src/lan/types";

const roots: string[] = [];
const servers: LanServerHandle[] = [];

const projectRoot = (): string => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "easlc-lan-sync-"))
  );
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close(50)));
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const writeApk = (root: string, name: string, contents: string): string => {
  const filename = path.join(root, name);
  fs.writeFileSync(filename, contents);
  return filename;
};

const authorizedClient = (clientId: string): LanAuthorizedClient => {
  const timestamp = new Date().toISOString();
  return {
    clientId,
    secret: crypto.randomBytes(32).toString("base64url"),
    capabilities: { read: true, write: true },
    status: "active",
    pairingId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};

const outboundPeer = (
  identity: Awaited<ReturnType<typeof createServerIdentity>>,
  server: LanServerHandle,
  client: LanAuthorizedClient
): LanOutboundPeer => {
  const timestamp = new Date().toISOString();
  return {
    peerId: identity.peerId,
    alias: "loopback",
    certificatePem: identity.certificatePem,
    endpoint: { host: "127.0.0.1", port: server.port },
    secret: client.secret,
    capabilities: client.capabilities,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSuccessAt: null,
  };
};

const sha256File = (filename: string): string =>
  crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");

describe("trusted LAN cache synchronization", () => {
  it("promotes A to B, preserves an offline B hit, then shares B through A to C", async () => {
    const rootA = projectRoot();
    const rootB = projectRoot();
    const rootC = projectRoot();
    const firstFingerprint = "lan-sync-first";
    const secondFingerprint = "lan-sync-second";
    const firstEntryId = getEntryId("android", firstFingerprint);
    const secondEntryId = getEntryId("android", secondFingerprint);

    await uploadCacheEntry(
      {
        projectRoot: rootA,
        platform: "android",
        fingerprintHash: firstFingerprint,
      },
      writeApk(rootA, "first.apk", "first-from-A")
    );

    const identity = await createServerIdentity();
    const clientB = authorizedClient(
      crypto.randomBytes(32).toString("base64url")
    );
    const clientC = authorizedClient(
      crypto.randomBytes(32).toString("base64url")
    );
    const clients = new Map([
      [clientB.clientId, clientB],
      [clientC.clientId, clientC],
    ]);
    const pathsA = getCachePaths(rootA);
    ensureManagedDirectory(pathsA.providerRoot, pathsA.transferStagingRoot);
    const server = await startLanServer({
      certificatePem: identity.certificatePem,
      privateKeyPem: identity.privateKeyPem,
      serverId: identity.peerId,
      allowWrite: true,
      incomingDirectory: pathsA.transferStagingRoot,
      authenticate: createLanServerAuthenticator({
        findClient: (clientId) => clients.get(clientId) ?? null,
      }),
      prepareEntry: async (platform, entryId) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 900));
        const packagePath = path.join(
          pathsA.transferStagingRoot,
          `${entryId}-${crypto.randomUUID()}.wire`
        );
        try {
          const inspected = await createWirePackage({
            projectRoot: rootA,
            platform,
            entryId,
            outputPath: packagePath,
          });
          return {
            packagePath,
            sizeBytes: inspected.totalBytes,
            sha256: sha256File(packagePath),
            cleanup: () => fs.rmSync(packagePath, { force: true }),
          };
        } catch {
          fs.rmSync(packagePath, { force: true });
          return null;
        }
      },
      importEntry: async (platform, entryId, packagePath) => {
        const result = await importWirePackage({
          projectRoot: rootA,
          packagePath,
          expectedPlatform: platform,
          expectedEntryId: entryId,
        });
        if (result.status === "imported") return "created";
        return result.sameGeneration ? "existing" : "conflict";
      },
    });
    servers.push(server);

    const peerB = outboundPeer(identity, server, clientB);
    expect(
      await fetchLanEntryToLocal({
        projectRoot: rootB,
        clientId: clientB.clientId,
        peers: [peerB],
        platform: "android",
        entryId: firstEntryId,
      })
    ).toEqual({ imported: true, peerId: identity.peerId });
    if (process.platform !== "win32") {
      const pathsB = getCachePaths(rootB);
      expect(fs.statSync(pathsB.transferLocksRoot).mode & 0o777).toBe(0o700);
      expect(fs.statSync(pathsB.transferStagingRoot).mode & 0o777).toBe(0o700);
    }
    const hitB = await resolveCacheEntryDetailed({
      projectRoot: rootB,
      platform: "android",
      fingerprintHash: firstFingerprint,
    });
    expect(hitB.outcome).toBe("hit");
    if (hitB.outcome === "hit") {
      expect(fs.readFileSync(hitB.path, "utf8")).toBe("first-from-A");
    }

    if (discoverZstdCodec()) {
      const rootSame = projectRoot();
      const repairFingerprint = "lan-sync-compressed-repair";
      const repairEntryId = getEntryId("android", repairFingerprint);
      const repairedBytes = "schema-one-from-A".repeat(10_000);
      await uploadCacheEntry(
        {
          projectRoot: rootA,
          platform: "android",
          fingerprintHash: repairFingerprint,
        },
        writeApk(rootA, "repair.apk", repairedBytes)
      );
      await uploadCacheEntry(
        {
          projectRoot: rootB,
          platform: "android",
          fingerprintHash: repairFingerprint,
        },
        writeApk(rootB, "repair-compressed.apk", "other".repeat(100_000)),
        { compressionMode: "zstd" }
      );
      await uploadCacheEntry(
        {
          projectRoot: rootSame,
          platform: "android",
          fingerprintHash: repairFingerprint,
        },
        writeApk(rootSame, "repair-compressed.apk", "other".repeat(100_000)),
        { compressionMode: "zstd" }
      );
      const repairDirectory = path.join(
        getCachePaths(rootB).entriesRoot,
        "android",
        repairEntryId
      );
      const compressed = readManifest(repairDirectory);
      expect(compressed.schemaVersion).toBe(2);
      if (compressed.schemaVersion !== 2) throw new Error("expected zstd");

      const sameIdentity = await createServerIdentity();
      const sameClient = authorizedClient(
        crypto.randomBytes(32).toString("base64url")
      );
      const samePaths = getCachePaths(rootSame);
      ensureManagedDirectory(
        samePaths.providerRoot,
        samePaths.transferStagingRoot
      );
      const sameServer = await startLanServer({
        certificatePem: sameIdentity.certificatePem,
        privateKeyPem: sameIdentity.privateKeyPem,
        serverId: sameIdentity.peerId,
        allowWrite: false,
        incomingDirectory: samePaths.transferStagingRoot,
        authenticate: createLanServerAuthenticator({
          findClient: (clientId) =>
            clientId === sameClient.clientId ? sameClient : null,
        }),
        prepareEntry: async (platform, entryId) => {
          const packagePath = path.join(
            samePaths.transferStagingRoot,
            `${entryId}-${crypto.randomUUID()}.wire`
          );
          try {
            const inspected = await createWirePackage({
              projectRoot: rootSame,
              platform,
              entryId,
              outputPath: packagePath,
            });
            return {
              packagePath,
              sizeBytes: inspected.totalBytes,
              sha256: sha256File(packagePath),
              cleanup: () => fs.rmSync(packagePath, { force: true }),
            };
          } catch {
            fs.rmSync(packagePath, { force: true });
            return null;
          }
        },
        importEntry: async () => "conflict" as const,
      });
      servers.push(sameServer);
      const samePeer = outboundPeer(sameIdentity, sameServer, sameClient);

      expect(
        await fetchLanEntryToLocal({
          projectRoot: rootB,
          clientId: clientB.clientId,
          // The first peer only serves the same unreadable generation. The
          // resolver must continue to the second peer's schema-1 artifact.
          peers: [samePeer, peerB],
          platform: "android",
          entryId: repairEntryId,
          replaceCompressedPayloadDigest: compressed.payload.integrity.digest,
        })
      ).toEqual({ imported: true, peerId: identity.peerId });
      expect(readManifest(repairDirectory).schemaVersion).toBe(1);
      const repaired = await resolveCacheEntryDetailed({
        projectRoot: rootB,
        platform: "android",
        fingerprintHash: repairFingerprint,
      });
      expect(repaired.outcome).toBe("hit");
      if (repaired.outcome === "hit") {
        expect(fs.readFileSync(repaired.path, "utf8")).toBe(repairedBytes);
      }
    }

    await server.close(50);
    servers.splice(servers.indexOf(server), 1);
    expect(
      (
        await resolveCacheEntryDetailed({
          projectRoot: rootB,
          platform: "android",
          fingerprintHash: firstFingerprint,
        })
      ).outcome
    ).toBe("hit");

    const restarted = await startLanServer({
      certificatePem: identity.certificatePem,
      privateKeyPem: identity.privateKeyPem,
      serverId: identity.peerId,
      allowWrite: true,
      incomingDirectory: pathsA.transferStagingRoot,
      authenticate: createLanServerAuthenticator({
        findClient: (clientId) => clients.get(clientId) ?? null,
      }),
      prepareEntry: async (platform, entryId) => {
        const packagePath = path.join(
          pathsA.transferStagingRoot,
          `${entryId}-${crypto.randomUUID()}.wire`
        );
        try {
          const inspected = await createWirePackage({
            projectRoot: rootA,
            platform,
            entryId,
            outputPath: packagePath,
          });
          return {
            packagePath,
            sizeBytes: inspected.totalBytes,
            sha256: sha256File(packagePath),
            cleanup: () => fs.rmSync(packagePath, { force: true }),
          };
        } catch {
          fs.rmSync(packagePath, { force: true });
          return null;
        }
      },
      importEntry: async (platform, entryId, packagePath) => {
        const result = await importWirePackage({
          projectRoot: rootA,
          packagePath,
          expectedPlatform: platform,
          expectedEntryId: entryId,
        });
        if (result.status === "imported") return "created";
        return result.sameGeneration ? "existing" : "conflict";
      },
    });
    servers.push(restarted);
    const restartedPeerB = outboundPeer(identity, restarted, clientB);
    await uploadCacheEntry(
      {
        projectRoot: rootB,
        platform: "android",
        fingerprintHash: secondFingerprint,
      },
      writeApk(rootB, "second.apk", "second-from-B")
    );
    expect(
      await pushLanEntryToPeer({
        projectRoot: rootB,
        clientId: clientB.clientId,
        peers: [restartedPeerB],
        platform: "android",
        entryId: secondEntryId,
      })
    ).toEqual({ uploaded: true, peerId: identity.peerId });

    const peerC = outboundPeer(identity, restarted, clientC);
    expect(
      await fetchLanEntryToLocal({
        projectRoot: rootC,
        clientId: clientC.clientId,
        peers: [peerC],
        platform: "android",
        entryId: secondEntryId,
      })
    ).toEqual({ imported: true, peerId: identity.peerId });
    const hitC = await resolveCacheEntryDetailed({
      projectRoot: rootC,
      platform: "android",
      fingerprintHash: secondFingerprint,
    });
    expect(hitC.outcome).toBe("hit");
    if (hitC.outcome === "hit") {
      expect(fs.readFileSync(hitC.path, "utf8")).toBe("second-from-B");
    }
  }, 10_000);

  it("enforces one upload deadline across lock, packaging, and PUT", async () => {
    const root = projectRoot();
    const fingerprint = "lan-sync-upload-deadline";
    const entryId = getEntryId("android", fingerprint);
    const source = path.join(root, "large.apk");
    fs.writeFileSync(source, "");
    fs.truncateSync(source, 64 * 1024 ** 2);
    await uploadCacheEntry(
      { projectRoot: root, platform: "android", fingerprintHash: fingerprint },
      source
    );

    const identity = await createServerIdentity();
    const client = authorizedClient(
      crypto.randomBytes(32).toString("base64url")
    );
    const peer: LanOutboundPeer = {
      ...outboundPeer(identity, { port: 9 } as LanServerHandle, client),
      endpoint: { host: "127.0.0.1", port: 9 },
    };
    const paths = getCachePaths(root);
    ensureManagedDirectory(paths.providerRoot, paths.transferLocksRoot);
    const activeLock = await acquireEntryLock(
      paths.transferLocksRoot,
      entryId,
      {
        maxWaitMs: 100,
      }
    );
    if (!activeLock) throw new Error("expected transfer lock");
    const lockStarted = Date.now();
    try {
      expect(
        await pushLanEntryToPeer({
          projectRoot: root,
          clientId: client.clientId,
          peers: [peer],
          platform: "android",
          entryId,
          budgetMs: 75,
        })
      ).toEqual({ uploaded: false, peerId: null });
    } finally {
      releaseEntryLock(activeLock);
    }
    expect(Date.now() - lockStarted).toBeLessThan(500);

    const packageStarted = Date.now();
    expect(
      await pushLanEntryToPeer({
        projectRoot: root,
        clientId: client.clientId,
        peers: [peer],
        platform: "android",
        entryId,
        budgetMs: 5,
      })
    ).toEqual({ uploaded: false, peerId: null });
    expect(Date.now() - packageStarted).toBeLessThan(500);
    expect(
      fs
        .readdirSync(paths.transferStagingRoot)
        .filter((name) => name.endsWith(".wire"))
    ).toEqual([]);
  });

  it("caps mDNS discovery latency below the overall fetch budget", async () => {
    const root = projectRoot();
    const identity = await createServerIdentity();
    const client = authorizedClient(
      crypto.randomBytes(32).toString("base64url")
    );
    const peer: LanOutboundPeer = {
      ...outboundPeer(identity, { port: 9 } as LanServerHandle, client),
      endpoint: { host: "127.0.0.1", port: 9 },
    };
    const started = Date.now();

    expect(
      await fetchLanEntryToLocal({
        projectRoot: root,
        clientId: client.clientId,
        peers: [peer],
        platform: "android",
        entryId: getEntryId("android", "offline-discovery-latency"),
        budgetMs: 1_500,
      })
    ).toEqual({ imported: false, peerId: null });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
