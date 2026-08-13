import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import {
  ensureManagedDirectory,
  ensureProviderRoot,
  pathExists,
} from "../cache/filesystem";
import { acquireEntryLock, releaseEntryLock } from "../cache/lock";
import { readManifest } from "../cache/manifest";
import { getCachePaths, type CachePlatform } from "../cache/paths";
import { validateEntry } from "../cache/validation";
import {
  fetchLanEntry,
  headLanEntry,
  putLanEntry,
  type LanPeerConnection,
} from "./client";
import { createWirePackage } from "./export";
import { importWirePackage } from "./import";
import type { LanOutboundPeer } from "./types";

const FETCH_BUDGET_MS = 45_000;
const UPLOAD_BUDGET_MS = 30_000;
const MAX_PEERS = 8;
const MAX_PROBES = 3;
const PROBE_TIMEOUT_MS = 10_000;
const DISCOVERY_WINDOW_MS = 300;

const hardenTransferDirectory = (directory: string): void => {
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
};

export type LanSyncPeer = LanOutboundPeer;

const toConnection = (
  peer: LanSyncPeer,
  clientId: string
): LanPeerConnection => ({
  serverId: peer.peerId,
  host: peer.endpoint.host,
  port: peer.endpoint.port,
  certificatePem: peer.certificatePem,
  clientId,
  secret: peer.secret,
  capabilities: peer.capabilities,
});

const orderedPeers = (
  peers: readonly LanSyncPeer[],
  capability: "read" | "write"
): LanSyncPeer[] =>
  peers
    .filter(
      (peer) =>
        peer.enabled &&
        peer.capabilities[capability] &&
        /^[a-f0-9]{64}$/.test(peer.peerId)
    )
    .sort((left, right) => {
      const successDelta =
        Date.parse(right.lastSuccessAt ?? "1970-01-01T00:00:00.000Z") -
        Date.parse(left.lastSuccessAt ?? "1970-01-01T00:00:00.000Z");
      return successDelta || left.peerId.localeCompare(right.peerId);
    })
    .slice(0, MAX_PEERS);

const probeBatch = async (
  peers: readonly LanSyncPeer[],
  clientId: string,
  platform: CachePlatform,
  entryId: string,
  deadline: number
): Promise<
  Array<{ peer: LanSyncPeer; sizeBytes: number; latencyMs: number }>
> => {
  const results: Array<{
    peer: LanSyncPeer;
    sizeBytes: number;
    latencyMs: number;
  }> = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(MAX_PROBES, peers.length) }, async () => {
      while (cursor < peers.length && Date.now() < deadline) {
        const peer = peers[cursor++]!;
        const started = Date.now();
        try {
          const head = await headLanEntry(
            toConnection(peer, clientId),
            platform,
            entryId,
            {
              timeoutMs: Math.max(
                1,
                Math.min(PROBE_TIMEOUT_MS, deadline - Date.now())
              ),
            }
          );
          if (head) {
            results.push({
              peer,
              sizeBytes: head.sizeBytes,
              latencyMs: Date.now() - started,
            });
          }
        } catch {
          // Every peer failure is isolated; the local cache remains usable.
        }
      }
    })
  );
  return results.sort(
    (left, right) =>
      left.latencyMs - right.latencyMs ||
      left.sizeBytes - right.sizeBytes ||
      left.peer.peerId.localeCompare(right.peer.peerId)
  );
};

const localEntryIsValid = (input: {
  providerRoot: string;
  entriesRoot: string;
  platform: CachePlatform;
  entryId: string;
  deadlineMs: number;
  replaceCompressedPayloadDigest?: string;
}): boolean => {
  if (Date.now() >= input.deadlineMs) return false;
  const entryDirectory = path.join(
    input.entriesRoot,
    input.platform,
    input.entryId
  );
  if (!pathExists(entryDirectory)) return false;
  try {
    const manifest = readManifest(entryDirectory);
    if (
      manifest.schemaVersion === 2 &&
      input.replaceCompressedPayloadDigest === manifest.payload.integrity.digest
    ) {
      return false;
    }
    return validateEntry(
      entryDirectory,
      input.providerRoot,
      input.platform,
      manifest.fingerprintHash,
      input.entryId,
      { deadlineMs: input.deadlineMs }
    ).valid;
  } catch {
    return false;
  }
};

export const fetchLanEntryToLocal = async (input: {
  projectRoot: string;
  clientId: string;
  peers: readonly LanSyncPeer[];
  platform: CachePlatform;
  entryId: string;
  budgetMs?: number;
  replaceCompressedPayloadDigest?: string;
}): Promise<{ imported: boolean; peerId: string | null }> => {
  const managedProjectRoot = fs.realpathSync(input.projectRoot);
  const paths = getCachePaths(managedProjectRoot);
  ensureProviderRoot(managedProjectRoot, paths.providerRoot);
  ensureManagedDirectory(paths.providerRoot, paths.transferLocksRoot);
  ensureManagedDirectory(paths.providerRoot, paths.transferStagingRoot);
  hardenTransferDirectory(paths.transferLocksRoot);
  hardenTransferDirectory(paths.transferStagingRoot);
  const budgetMs = Math.min(input.budgetMs ?? FETCH_BUDGET_MS, FETCH_BUDGET_MS);
  const deadline = Date.now() + Math.max(1, budgetMs);
  const transferLock = await acquireEntryLock(
    paths.transferLocksRoot,
    input.entryId,
    { maxWaitMs: Math.max(1, deadline - Date.now()), retryIntervalMs: 50 }
  );
  if (!transferLock) return { imported: false, peerId: null };
  let packagePath: string | null = null;
  try {
    if (
      localEntryIsValid({
        providerRoot: paths.providerRoot,
        entriesRoot: paths.entriesRoot,
        platform: input.platform,
        entryId: input.entryId,
        deadlineMs: deadline,
        ...(input.replaceCompressedPayloadDigest
          ? {
              replaceCompressedPayloadDigest:
                input.replaceCompressedPayloadDigest,
            }
          : {}),
      })
    ) {
      return { imported: true, peerId: null };
    }
    const basePeers = orderedPeers(input.peers, "read");
    let peers = basePeers;
    try {
      const { discoverPairedEndpoints } = await import("./discovery.js");
      const discovered = await discoverPairedEndpoints(
        basePeers.map((peer) => peer.peerId),
        {
          windowMs: Math.min(
            DISCOVERY_WINDOW_MS,
            Math.max(0, deadline - Date.now())
          ),
        }
      );
      const byId = new Map(
        discovered.map((endpoint) => [endpoint.serverId, endpoint])
      );
      peers = basePeers.map((peer) => {
        const hint = byId.get(peer.peerId);
        return hint
          ? { ...peer, endpoint: { host: hint.host, port: hint.port } }
          : peer;
      });
    } catch {
      // Saved authenticated endpoints remain available without multicast.
    }
    const candidates = await probeBatch(
      peers,
      input.clientId,
      input.platform,
      input.entryId,
      deadline
    );
    for (const candidate of candidates) {
      if (Date.now() >= deadline) break;
      packagePath = path.join(
        paths.transferStagingRoot,
        `${input.entryId}-${crypto.randomUUID()}.wire`
      );
      try {
        await fetchLanEntry(
          toConnection(candidate.peer, input.clientId),
          input.platform,
          input.entryId,
          packagePath,
          { timeoutMs: Math.max(1, deadline - Date.now()) }
        );
        await importWirePackage({
          projectRoot: managedProjectRoot,
          packagePath,
          expectedPlatform: input.platform,
          expectedEntryId: input.entryId,
          deadlineMs: deadline,
          transferLock,
          ...(input.replaceCompressedPayloadDigest
            ? {
                replaceCompressedUnavailable: {
                  payloadDigest: input.replaceCompressedPayloadDigest,
                },
              }
            : {}),
        });
        if (
          input.replaceCompressedPayloadDigest &&
          !localEntryIsValid({
            providerRoot: paths.providerRoot,
            entriesRoot: paths.entriesRoot,
            platform: input.platform,
            entryId: input.entryId,
            deadlineMs: deadline,
            replaceCompressedPayloadDigest:
              input.replaceCompressedPayloadDigest,
          })
        ) {
          continue;
        }
        return { imported: true, peerId: candidate.peer.peerId };
      } catch {
        // A malformed, corrupt, or unavailable peer never blocks another peer.
      } finally {
        fs.rmSync(packagePath, { force: true });
        packagePath = null;
      }
    }
    return { imported: false, peerId: null };
  } finally {
    if (packagePath) fs.rmSync(packagePath, { force: true });
    releaseEntryLock(transferLock);
  }
};

export const pushLanEntryToPeer = async (input: {
  projectRoot: string;
  clientId: string;
  peers: readonly LanSyncPeer[];
  platform: CachePlatform;
  entryId: string;
  budgetMs?: number;
}): Promise<{ uploaded: boolean; peerId: string | null }> => {
  const peer = orderedPeers(input.peers, "write")[0];
  if (!peer) return { uploaded: false, peerId: null };
  const managedProjectRoot = fs.realpathSync(input.projectRoot);
  const paths = getCachePaths(managedProjectRoot);
  ensureProviderRoot(managedProjectRoot, paths.providerRoot);
  ensureManagedDirectory(paths.providerRoot, paths.transferLocksRoot);
  ensureManagedDirectory(paths.providerRoot, paths.transferStagingRoot);
  hardenTransferDirectory(paths.transferLocksRoot);
  hardenTransferDirectory(paths.transferStagingRoot);
  const budgetMs = Math.max(
    1,
    Math.min(input.budgetMs ?? UPLOAD_BUDGET_MS, UPLOAD_BUDGET_MS)
  );
  const deadline = Date.now() + budgetMs;
  const transferLock = await acquireEntryLock(
    paths.transferLocksRoot,
    input.entryId,
    {
      maxWaitMs: Math.max(1, deadline - Date.now()),
      retryIntervalMs: 50,
    }
  );
  if (!transferLock) return { uploaded: false, peerId: null };
  const packagePath = path.join(
    paths.transferStagingRoot,
    `${input.entryId}-upload-${crypto.randomUUID()}.wire`
  );
  try {
    if (Date.now() >= deadline) return { uploaded: false, peerId: null };
    await createWirePackage({
      projectRoot: managedProjectRoot,
      platform: input.platform,
      entryId: input.entryId,
      outputPath: packagePath,
      deadlineMs: deadline,
    });
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { uploaded: false, peerId: null };
    const result = await putLanEntry(
      toConnection(peer, input.clientId),
      input.platform,
      input.entryId,
      packagePath,
      {
        timeoutMs: remainingMs,
      }
    );
    return { uploaded: result !== "conflict", peerId: peer.peerId };
  } catch {
    return { uploaded: false, peerId: null };
  } finally {
    fs.rmSync(packagePath, { force: true });
    releaseEntryLock(transferLock);
  }
};
