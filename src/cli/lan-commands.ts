import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import {
  ensureManagedDirectory,
  ensureProviderRoot,
} from "../cache/filesystem";
import { getCachePaths } from "../cache/paths";
import type { ParsedArguments } from "./arguments";
import { UsageError } from "./arguments";
import {
  printJson,
  readBoundedFile,
  readStdin,
  removeOwnedPrivateFile,
  sha256RegularFile,
  writePrivateExclusiveFile,
} from "./io";

const prepareLanRoot = (projectRoot: string) => {
  const managedProjectRoot = fs.realpathSync(projectRoot);
  const paths = getCachePaths(managedProjectRoot);
  ensureProviderRoot(managedProjectRoot, paths.providerRoot);
  return { managedProjectRoot, paths };
};

export const runPairCommand = async (
  parsed: ParsedArguments
): Promise<number> => {
  const { paths } = prepareLanRoot(parsed.projectRoot);
  const [{ decodePairingUri }, { pairWithLanServer }, stateModule] =
    await Promise.all([
      import("../lan/pairing.js"),
      import("../lan/client.js"),
      import("../lan/state.js"),
    ]);
  const uri = parsed.pairingFile
    ? readBoundedFile(parsed.pairingFile, true)
    : await readStdin(!parsed.stdin);
  const offer = decodePairingUri(uri);
  const state = await stateModule.ensureLanState(paths.providerRoot);
  const paired = await pairWithLanServer(offer, state.clientId, {
    beforeAcknowledge: async (peer) => {
      await stateModule.updateLanState(paths.providerRoot, (current) => {
        const timestamp = new Date().toISOString();
        const existing = current.outboundPeers.findIndex(
          (candidate) => candidate.peerId === peer.serverId
        );
        const record = {
          peerId: peer.serverId,
          alias: parsed.alias,
          certificatePem: peer.certificatePem,
          endpoint: { host: peer.host, port: peer.port },
          secret: peer.secret,
          capabilities: peer.capabilities,
          enabled: true,
          createdAt:
            existing === -1
              ? timestamp
              : current.outboundPeers[existing]!.createdAt,
          updatedAt: timestamp,
          lastSuccessAt: null,
        };
        if (existing === -1) current.outboundPeers.push(record);
        else current.outboundPeers[existing] = record;
      });
    },
  });
  const output = {
    paired: true,
    peerId: paired.serverId,
    alias: parsed.alias,
    capabilities: paired.capabilities,
  };
  if (parsed.json) printJson(output);
  else console.log(`Paired trusted LAN peer ${paired.serverId.slice(0, 12)}.`);
  return 0;
};

export const runPeersCommand = async (
  parsed: ParsedArguments
): Promise<number> => {
  const { paths } = prepareLanRoot(parsed.projectRoot);
  const stateModule = await import("../lan/state.js");
  if (parsed.peerAction) {
    let changed = false;
    await stateModule.updateLanState(paths.providerRoot, (state) => {
      const peer = state.outboundPeers.find(
        (candidate) => candidate.peerId === parsed.peerId
      );
      if (peer) {
        if (parsed.peerAction === "revoke") {
          state.outboundPeers = state.outboundPeers.filter(
            (candidate) => candidate.peerId !== parsed.peerId
          );
        } else {
          peer.enabled = parsed.peerAction === "enable";
          peer.updatedAt = new Date().toISOString();
        }
        changed = true;
      }
      const client = state.authorizedClients.find(
        (candidate) => candidate.clientId === parsed.peerId
      );
      if (client && parsed.peerAction === "revoke") {
        state.authorizedClients = state.authorizedClients.filter(
          (candidate) => candidate.clientId !== parsed.peerId
        );
        changed = true;
      }
    });
    if (!changed) throw new Error("Trusted LAN peer was not found");
    if (parsed.json) printJson({ changed: true });
    else console.log(`Peer ${parsed.peerAction} completed.`);
    return 0;
  }
  const state = stateModule.readLanState(paths.providerRoot);
  const peers = state?.outboundPeers ?? [];
  const clientModule = parsed.check ? await import("../lan/client.js") : null;
  const output = await Promise.all(
    peers.map(async (peer) => {
      let online: boolean | null = null;
      if (parsed.check && peer.enabled && state && clientModule) {
        try {
          await clientModule.pingLanPeer({
            serverId: peer.peerId,
            host: peer.endpoint.host,
            port: peer.endpoint.port,
            certificatePem: peer.certificatePem,
            clientId: state.clientId,
            secret: peer.secret,
            capabilities: peer.capabilities,
          });
          online = true;
        } catch {
          online = false;
        }
      }
      return {
        peerId: peer.peerId,
        alias: peer.alias,
        enabled: peer.enabled,
        capabilities: peer.capabilities,
        online,
      };
    })
  );
  const clients = (state?.authorizedClients ?? []).map((client) => ({
    clientId: client.clientId,
    status: client.status,
    capabilities: client.capabilities,
  }));
  if (parsed.json) printJson({ peers: output, clients });
  else {
    if (output.length === 0) {
      console.log("No outbound trusted LAN peers configured.");
    }
    for (const peer of output) {
      console.log(
        `${peer.peerId.slice(0, 12)} ${peer.alias ?? "unnamed"} ${
          peer.enabled ? "enabled" : "disabled"
        }${peer.online === null ? "" : peer.online ? " online" : " offline"}`
      );
    }
    if (clients.length === 0) {
      console.log("No authorized inbound LAN clients configured.");
    }
    for (const client of clients) {
      console.log(
        `${client.clientId.slice(0, 12)} inbound ${client.status} read${
          client.capabilities.write ? ",write" : ""
        }`
      );
    }
  }
  return parsed.requireOnline && output.some((peer) => peer.online !== true)
    ? 1
    : 0;
};

export const runServeCommand = async (
  parsed: ParsedArguments
): Promise<number> => {
  const { paths } = prepareLanRoot(parsed.projectRoot);
  const [
    certificate,
    stateModule,
    coordinatorModule,
    serverModule,
    exportModule,
    importModule,
  ] = await Promise.all([
    import("../lan/certificate.js"),
    import("../lan/state.js"),
    import("../lan/coordinator.js"),
    import("../lan/server.js"),
    import("../lan/export.js"),
    import("../lan/import.js"),
  ]);
  let state = await stateModule.ensureLanState(paths.providerRoot);
  if (!state.serverIdentity) {
    const identity = await certificate.createServerIdentity();
    state = await stateModule.updateLanState(paths.providerRoot, (current) => {
      current.serverIdentity ??= identity;
    });
  }
  certificate.validateServerIdentity(state.serverIdentity!);
  ensureManagedDirectory(paths.providerRoot, paths.transferStagingRoot);
  ensureManagedDirectory(paths.providerRoot, paths.transferLocksRoot);
  const advertisedHost =
    parsed.advertiseHost ??
    (parsed.host && parsed.host !== "0.0.0.0" && parsed.host !== "::"
      ? parsed.host
      : "127.0.0.1");
  const { isPrivateLanAddress } = await import("../lan/discovery.js");
  if (!isPrivateLanAddress(advertisedHost)) {
    throw new UsageError(
      "The advertised server address must be private or loopback"
    );
  }
  const window = parsed.pairing
    ? coordinatorModule.createPairingWindow({ allowWrite: parsed.allowWrite })
    : null;
  const coordinator = coordinatorModule.createLanServerCoordinator({
    providerRoot: paths.providerRoot,
    serverId: state.serverIdentity!.peerId,
    pairingWindow: window,
  });
  const server = await serverModule.startLanServer({
    host: parsed.host ?? "127.0.0.1",
    port: parsed.port ?? 0,
    certificatePem: state.serverIdentity!.certificatePem,
    privateKeyPem: state.serverIdentity!.privateKeyPem,
    serverId: state.serverIdentity!.peerId,
    allowWrite: parsed.allowWrite,
    incomingDirectory: paths.transferStagingRoot,
    transferLocksRoot: paths.transferLocksRoot,
    operationTimeoutMs: 45_000,
    authenticate: coordinator.authenticate,
    ...(window ? { pair: coordinator.pair } : {}),
    ...(window ? { acknowledgePairing: coordinator.acknowledgePairing } : {}),
    prepareEntry: async (platform, entryId, deadlineMs) => {
      ensureManagedDirectory(paths.providerRoot, paths.transferStagingRoot);
      const packagePath = path.join(
        paths.transferStagingRoot,
        `${entryId}-serve-${crypto.randomUUID()}.wire`
      );
      try {
        const inspected = await exportModule.createWirePackage({
          projectRoot: parsed.projectRoot,
          platform,
          entryId,
          outputPath: packagePath,
          deadlineMs,
        });
        return {
          packagePath,
          sizeBytes: inspected.totalBytes,
          sha256: sha256RegularFile(
            packagePath,
            inspected.totalBytes,
            deadlineMs
          ),
          cleanup: () => fs.rmSync(packagePath, { force: true }),
        };
      } catch {
        fs.rmSync(packagePath, { force: true });
        return null;
      }
    },
    importEntry: async (
      platform,
      entryId,
      packagePath,
      transferLock,
      deadlineMs
    ) => {
      const imported = await importModule.importWirePackage({
        projectRoot: parsed.projectRoot,
        packagePath,
        expectedPlatform: platform,
        expectedEntryId: entryId,
        deadlineMs,
        ...(transferLock ? { transferLock } : {}),
      });
      if (imported.status === "imported") return "created";
      return imported.sameGeneration ? "existing" : "conflict";
    },
  });
  let pairingUri: string | null = null;
  let pairingFileOwned: ReturnType<typeof writePrivateExclusiveFile> | null =
    null;
  let pairingFileExpiry: NodeJS.Timeout | null = null;
  let advertisement: { stop: () => Promise<void> } | null = null;
  try {
    if (window) {
      const { createPairingOffer } = await import("../lan/pairing.js");
      pairingUri = createPairingOffer(
        state.serverIdentity!,
        advertisedHost,
        server.port,
        {
          capability: window.capability,
          ttlMs: Date.parse(window.expiresAt) - Date.now(),
        }
      ).uri;
      if (parsed.pairingFile) {
        pairingFileOwned = writePrivateExclusiveFile(
          parsed.pairingFile,
          `${pairingUri}\n`
        );
      }
      pairingFileExpiry = setTimeout(() => {
        if (pairingFileOwned) {
          removeOwnedPrivateFile(pairingFileOwned);
          pairingFileOwned = null;
        }
        void coordinator.discardPendingPairing().catch(() => {});
      }, Math.max(1, Date.parse(window.expiresAt) - Date.now()));
      pairingFileExpiry.unref();
    }
    if (parsed.discovery) {
      const { advertiseLanPeer } = await import("../lan/discovery.js");
      advertisement = advertiseLanPeer({
        serverId: state.serverIdentity!.peerId,
        port: server.port,
        allowWrite: parsed.allowWrite,
        host: advertisedHost,
      });
    }
    if (parsed.json) {
      printJson({
        ready: true,
        serverId: state.serverIdentity!.peerId,
        host: server.host,
        port: server.port,
        allowWrite: parsed.allowWrite,
      });
    } else {
      console.log(
        `Trusted LAN cache server ${state.serverIdentity!.peerId.slice(
          0,
          12
        )} listening on ${server.host}:${server.port}`
      );
      if (pairingUri && !parsed.pairingFile) console.log(pairingUri);
    }
    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  } finally {
    if (pairingFileExpiry) clearTimeout(pairingFileExpiry);
    await coordinator.discardPendingPairing().catch(() => {});
    await advertisement?.stop().catch(() => {});
    await server.close().catch(() => {});
    if (pairingFileOwned) removeOwnedPrivateFile(pairingFileOwned);
  }
};
