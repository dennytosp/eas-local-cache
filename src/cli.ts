#!/usr/bin/env node

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { inventoryCache } from "./cache/catalog";
import { pruneCache } from "./cache/cleanup";
import { doctorCache, doctorCacheDeep } from "./cache/doctor";
import { scanResolveEvents, summarizeResolveEvents } from "./cache/events";
import {
  formatSizeBytes,
  normalizeCacheOptions,
  type CacheProviderOptions,
} from "./cache/options";
import { readPolicyState } from "./cache/policy-state";
import { ensureProviderRoot } from "./cache/filesystem";
import { ensureManagedDirectory } from "./cache/filesystem";
import { getCachePaths } from "./cache/paths";

type ParsedArguments = {
  command:
    | "help"
    | "stats"
    | "list"
    | "doctor"
    | "prune"
    | "serve"
    | "pair"
    | "peers";
  projectRoot: string;
  json: boolean;
  dryRun: boolean;
  deep: boolean;
  platform: "android" | "ios" | null;
  overrides: CacheProviderOptions;
  host: string | null;
  port: number | null;
  advertiseHost: string | null;
  discovery: boolean;
  allowWrite: boolean;
  pairing: boolean;
  pairingFile: string | null;
  stdin: boolean;
  alias: string | null;
  check: boolean;
  requireOnline: boolean;
  peerAction: "enable" | "disable" | "revoke" | null;
  peerId: string | null;
};

class UsageError extends Error {}

const HELP = `eas-local-cache — inspect and maintain the local Expo build cache

Usage:
  eas-local-cache stats [--project-root PATH] [--json]
  eas-local-cache list [--project-root PATH] [--platform ios|android] [--json]
  eas-local-cache doctor [--project-root PATH] [--deep] [--json]
  eas-local-cache prune [--project-root PATH] [--dry-run] [--json]
                         [--max-size SIZE] [--max-entries COUNT]
                         [--retention-days DAYS]
  eas-local-cache serve [--project-root PATH] [--host ADDRESS] [--port PORT]
                        [--advertise-host HOST] [--no-discovery]
                        [--allow-write] [--pairing]
                        [--pairing-file PATH] [--json]
  eas-local-cache pair [--project-root PATH] [--stdin|--pairing-file PATH]
                       [--alias NAME] [--json]
  eas-local-cache peers [--project-root PATH] [--check] [--require-online]
                        [--json]
  eas-local-cache peers enable|disable|revoke PEER_ID [--project-root PATH]

Sizes use binary units: B, KB, MB, GB, or TB.
`;

const requireValue = (arguments_: string[], index: number, option: string) => {
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new UsageError(`${option} requires a value`);
  }
  return value;
};

export const parseCliArguments = (
  arguments_: string[],
  cwd = process.cwd()
): ParsedArguments => {
  const commandValue = arguments_[0];
  const command =
    !commandValue || commandValue === "help" || commandValue === "--help"
      ? "help"
      : commandValue;
  if (
    !new Set([
      "help",
      "stats",
      "list",
      "doctor",
      "prune",
      "serve",
      "pair",
      "peers",
    ]).has(command)
  ) {
    throw new UsageError(`Unknown command: ${command}`);
  }

  const parsed: ParsedArguments = {
    command: command as ParsedArguments["command"],
    projectRoot: cwd,
    json: false,
    dryRun: false,
    deep: false,
    platform: null,
    overrides: {},
    host: null,
    port: null,
    advertiseHost: null,
    discovery: true,
    allowWrite: false,
    pairing: false,
    pairingFile: null,
    stdin: false,
    alias: null,
    check: false,
    requireOnline: false,
    peerAction: null,
    peerId: null,
  };

  let optionStart = 1;
  if (
    parsed.command === "peers" &&
    arguments_[1] &&
    !arguments_[1]!.startsWith("--")
  ) {
    const action = arguments_[1];
    if (action !== "enable" && action !== "disable" && action !== "revoke") {
      throw new UsageError(`Unknown peers action: ${action}`);
    }
    const peerId = arguments_[2];
    if (!peerId || peerId.startsWith("--")) {
      throw new UsageError(`peers ${action} requires a peer id`);
    }
    parsed.peerAction = action;
    parsed.peerId = peerId;
    optionStart = 3;
  }

  for (let index = optionStart; index < arguments_.length; index += 1) {
    const option = arguments_[index]!;
    if (option === "--json") {
      parsed.json = true;
    } else if (option === "--dry-run") {
      parsed.dryRun = true;
    } else if (option === "--deep") {
      parsed.deep = true;
    } else if (option === "--project-root") {
      parsed.projectRoot = path.resolve(
        cwd,
        requireValue(arguments_, index, option)
      );
      index += 1;
    } else if (option === "--platform") {
      const value = requireValue(arguments_, index, option);
      if (value !== "ios" && value !== "android") {
        throw new UsageError("--platform must be ios or android");
      }
      parsed.platform = value;
      index += 1;
    } else if (option === "--max-size") {
      parsed.overrides.maxSize = requireValue(arguments_, index, option);
      index += 1;
    } else if (option === "--max-entries") {
      parsed.overrides.maxEntries = Number(
        requireValue(arguments_, index, option)
      );
      index += 1;
    } else if (option === "--retention-days") {
      parsed.overrides.retentionDays = Number(
        requireValue(arguments_, index, option)
      );
      index += 1;
    } else if (option === "--host") {
      parsed.host = requireValue(arguments_, index, option);
      index += 1;
    } else if (option === "--port") {
      const value = Number(requireValue(arguments_, index, option));
      if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
        throw new UsageError("--port must be an integer from 0 through 65535");
      }
      parsed.port = value;
      index += 1;
    } else if (option === "--advertise-host") {
      parsed.advertiseHost = requireValue(arguments_, index, option);
      index += 1;
    } else if (option === "--no-discovery") {
      parsed.discovery = false;
    } else if (option === "--allow-write") {
      parsed.allowWrite = true;
    } else if (option === "--pairing") {
      parsed.pairing = true;
    } else if (option === "--pairing-file") {
      parsed.pairingFile = path.resolve(
        cwd,
        requireValue(arguments_, index, option)
      );
      index += 1;
    } else if (option === "--stdin") {
      parsed.stdin = true;
    } else if (option === "--alias") {
      parsed.alias = requireValue(arguments_, index, option);
      index += 1;
    } else if (option === "--check") {
      parsed.check = true;
    } else if (option === "--require-online") {
      parsed.requireOnline = true;
    } else {
      throw new UsageError(`Unknown option: ${option}`);
    }
  }

  if (parsed.command !== "prune" && parsed.dryRun) {
    throw new UsageError("--dry-run is only valid with prune");
  }
  if (parsed.command !== "list" && parsed.platform) {
    throw new UsageError("--platform is only valid with list");
  }
  if (parsed.command !== "doctor" && parsed.deep) {
    throw new UsageError("--deep is only valid with doctor");
  }
  if (
    parsed.command !== "prune" &&
    Object.values(parsed.overrides).some((value) => value !== undefined)
  ) {
    throw new UsageError("Cleanup policy options are only valid with prune");
  }
  const serveOnlyUsed =
    parsed.host !== null ||
    parsed.port !== null ||
    parsed.advertiseHost !== null ||
    !parsed.discovery ||
    parsed.allowWrite ||
    parsed.pairing;
  if (parsed.command !== "serve" && serveOnlyUsed) {
    throw new UsageError("Server options are only valid with serve");
  }
  if (
    parsed.command !== "serve" &&
    parsed.command !== "pair" &&
    parsed.pairingFile
  ) {
    throw new UsageError("--pairing-file is only valid with serve or pair");
  }
  if (parsed.command !== "pair" && (parsed.stdin || parsed.alias)) {
    throw new UsageError("Pairing input options are only valid with pair");
  }
  if (parsed.command === "pair" && parsed.stdin && parsed.pairingFile) {
    throw new UsageError("Use only one of --stdin or --pairing-file");
  }
  if (parsed.command !== "peers" && (parsed.check || parsed.requireOnline)) {
    throw new UsageError("Peer status options are only valid with peers");
  }
  if (parsed.requireOnline && !parsed.check) {
    throw new UsageError("--require-online requires --check");
  }
  if (parsed.peerAction && (parsed.check || parsed.requireOnline)) {
    throw new UsageError("Peer actions cannot be combined with status checks");
  }
  if (parsed.command === "serve") {
    if (
      (parsed.host === "0.0.0.0" || parsed.host === "::") &&
      !parsed.advertiseHost
    ) {
      throw new UsageError(
        "--advertise-host is required when --host is unspecified"
      );
    }
    if (parsed.pairingFile && !parsed.pairing) {
      throw new UsageError("--pairing-file requires --pairing with serve");
    }
    if (parsed.json && parsed.pairing && !parsed.pairingFile) {
      throw new UsageError(
        "--json pairing requires --pairing-file so the secret is not printed"
      );
    }
  }
  return parsed;
};

const readBoundedFile = (filePath: string, secret = false): string => {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0 || stats.size > 64 * 1024) {
      throw new UsageError("Pairing input must be a bounded regular file");
    }
    if (secret && process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new UsageError("Pairing file permissions must be 0600");
    }
    return fs.readFileSync(descriptor, "utf8").trim();
  } finally {
    fs.closeSync(descriptor);
  }
};

const writePrivateExclusiveFile = (
  filePath: string,
  contents: string
): { path: string; device: number; inode: number } => {
  const resolvedPath = path.resolve(filePath);
  const parent = path.dirname(resolvedPath);
  const parentStats = fs.lstatSync(parent);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new UsageError("Pairing file parent must be a real directory");
  }
  const managedParent = fs.realpathSync(parent);
  const managedPath = path.join(managedParent, path.basename(resolvedPath));
  const temporaryPath = path.join(
    managedParent,
    `.${path.basename(resolvedPath)}.tmp-${process.pid}-${crypto.randomUUID()}`
  );
  const descriptor = fs.openSync(
    temporaryPath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600
  );
  try {
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.linkSync(temporaryPath, managedPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  const published = fs.lstatSync(managedPath);
  if (
    published.isSymbolicLink() ||
    !published.isFile() ||
    published.nlink !== 1
  ) {
    throw new Error("Pairing file was not published safely");
  }
  return {
    path: managedPath,
    device: published.dev,
    inode: published.ino,
  };
};

const removeOwnedPrivateFile = (owned: {
  path: string;
  device: number;
  inode: number;
}): boolean => {
  try {
    const current = fs.lstatSync(owned.path);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.dev !== owned.device ||
      current.ino !== owned.inode
    ) {
      return false;
    }
    fs.unlinkSync(owned.path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const readStdin = async (hidden: boolean): Promise<string> => {
  if (hidden && !process.stdin.isTTY) {
    throw new UsageError("Interactive pairing requires a TTY or --stdin");
  }
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", finish);
      if (hidden && process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      if (hidden) process.stderr.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003") {
          reject(new Error("Pairing cancelled"));
          finish();
          return;
        }
        if (character === "\u007f") value = value.slice(0, -1);
        else if (value.length < 64 * 1024) value += character;
      }
    };
    if (hidden) {
      process.stderr.write("Paste pairing code: ");
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.once("end", finish);
  });
};

const printJson = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

const formatDuration = (milliseconds: number): string => {
  const seconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return [
    ...(hours > 0 ? [`${hours}h`] : []),
    ...(minutes > 0 ? [`${minutes}m`] : []),
    ...(remainingSeconds > 0 || (hours === 0 && minutes === 0)
      ? [`${remainingSeconds}s`]
      : []),
  ].join(" ");
};

const checkedSum = (values: Iterable<number>, label: string): number => {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} contains an invalid byte count`);
    }
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new Error(`${label} exceeds the supported byte range`);
    }
  }
  return total;
};

const formatSignedSize = (bytes: number): string =>
  bytes < 0 ? `-${formatSizeBytes(Math.abs(bytes))}` : formatSizeBytes(bytes);

const sha256RegularFile = (
  filePath: string,
  expectedBytes: number,
  deadlineMs?: number
): string => {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size !== expectedBytes) {
      throw new Error("LAN wire package changed before serving");
    }
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < stats.size) {
      if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
        throw new Error("LAN wire package hashing exceeded its deadline");
      }
      const count = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, stats.size - offset),
        offset
      );
      if (count === 0) throw new Error("LAN wire package was truncated");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
};

const prepareLanRoot = (projectRoot: string) => {
  const managedProjectRoot = fs.realpathSync(projectRoot);
  const paths = getCachePaths(managedProjectRoot);
  ensureProviderRoot(managedProjectRoot, paths.providerRoot);
  return { managedProjectRoot, paths };
};

const runPairCommand = async (parsed: ParsedArguments): Promise<number> => {
  const { paths } = prepareLanRoot(parsed.projectRoot);
  const [{ decodePairingUri }, { pairWithLanServer }, stateModule] =
    await Promise.all([
      import("./lan/pairing.js"),
      import("./lan/client.js"),
      import("./lan/state.js"),
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

const runPeersCommand = async (parsed: ParsedArguments): Promise<number> => {
  const { paths } = prepareLanRoot(parsed.projectRoot);
  const stateModule = await import("./lan/state.js");
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
  const clientModule = parsed.check ? await import("./lan/client.js") : null;
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

const runServeCommand = async (parsed: ParsedArguments): Promise<number> => {
  const { paths } = prepareLanRoot(parsed.projectRoot);
  const [
    certificate,
    stateModule,
    coordinatorModule,
    serverModule,
    exportModule,
    importModule,
  ] = await Promise.all([
    import("./lan/certificate.js"),
    import("./lan/state.js"),
    import("./lan/coordinator.js"),
    import("./lan/server.js"),
    import("./lan/export.js"),
    import("./lan/import.js"),
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
  const { isPrivateLanAddress } = await import("./lan/discovery.js");
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
      const { createPairingOffer } = await import("./lan/pairing.js");
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
      const { advertiseLanPeer } = await import("./lan/discovery.js");
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

export const runCli = async (arguments_: string[]): Promise<number> => {
  try {
    const parsed = parseCliArguments(arguments_);
    if (parsed.command === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    if (!fs.existsSync(parsed.projectRoot)) {
      throw new UsageError(
        `Project root does not exist: ${parsed.projectRoot}`
      );
    }

    if (parsed.command === "serve") return await runServeCommand(parsed);
    if (parsed.command === "pair") return await runPairCommand(parsed);
    if (parsed.command === "peers") return await runPeersCommand(parsed);

    const catalog = inventoryCache(parsed.projectRoot);
    if (parsed.command === "list") {
      const entries = [...catalog.entries]
        .filter(
          (entry) => !parsed.platform || entry.platform === parsed.platform
        )
        .sort(
          (left, right) =>
            Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
            left.platform.localeCompare(right.platform) ||
            left.entryId.localeCompare(right.entryId)
        )
        .map((entry) => ({
          platform: entry.platform,
          entryId: entry.entryId,
          fingerprint: entry.fingerprintHash.slice(0, 12),
          sizeBytes: entry.sizeBytes,
          createdAt: entry.createdAt,
          lastAccessedAt: entry.lastAccessedAt,
          protectedUntil: entry.protectedUntil,
          encoding: entry.encoding,
          logicalArtifactBytes: entry.logicalArtifactBytes,
          payloadBytes: entry.payloadBytes,
          compressionRatio: entry.compressionRatio,
          grossCompressionSavedBytes: entry.grossCompressionSavedBytes,
          restoreBytes: entry.restoreBytes,
        }));
      const legacyEntries = catalog.legacyEntries.filter(
        (entry) => !parsed.platform || entry.platform === parsed.platform
      );
      if (parsed.json) {
        printJson({
          entries,
          legacyEntries,
          issues: catalog.issues,
        });
      } else if (entries.length === 0 && legacyEntries.length === 0) {
        console.log("No versioned cache entries found.");
      } else {
        for (const entry of entries) {
          console.log(
            `${entry.platform.padEnd(7)} ${entry.fingerprint} ${formatSizeBytes(
              entry.sizeBytes
            ).padStart(9)} ${entry.encoding.padEnd(4)} last used ${
              entry.lastAccessedAt
            }`
          );
          if (entry.encoding === "zstd") {
            console.log(
              `         logical ${formatSizeBytes(
                entry.logicalArtifactBytes
              )}, payload ${formatSizeBytes(entry.payloadBytes ?? 0)}, ratio ${(
                (entry.compressionRatio ?? 0) * 100
              ).toFixed(1)}%, gross saved ${formatSizeBytes(
                entry.grossCompressionSavedBytes
              )}, restore ${formatSizeBytes(entry.restoreBytes)}`
            );
          }
        }
        for (const entry of legacyEntries) {
          console.log(
            `${entry.platform.padEnd(7)} legacy       ${formatSizeBytes(
              entry.sizeBytes
            ).padStart(9)} unverified ${entry.path}`
          );
        }
      }
      return catalog.issues.some((issue) => issue.severity === "error") ? 1 : 0;
    }

    if (parsed.command === "stats") {
      const policy = readPolicyState(
        catalog.paths.providerRoot,
        catalog.paths.stateRoot
      );
      let telemetry;
      try {
        const scan = scanResolveEvents(catalog.paths.eventsRoot);
        telemetry = summarizeResolveEvents(
          scan.events.map(({ event }) => event)
        );
      } catch {
        telemetry = summarizeResolveEvents([]);
      }
      const grossSavedBytes = checkedSum(
        catalog.entries.map((entry) => entry.grossCompressionSavedBytes),
        "Compression savings"
      );
      const latestEntry = [...catalog.entries].sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
          left.platform.localeCompare(right.platform) ||
          left.entryId.localeCompare(right.entryId)
      )[0];
      const output = {
        entryCount: catalog.entries.length,
        legacyEntryCount: catalog.legacyEntries.length,
        latestBuild: latestEntry
          ? {
              platform: latestEntry.platform,
              entryId: latestEntry.entryId,
              fingerprint: latestEntry.fingerprintHash.slice(0, 12),
              createdAt: latestEntry.createdAt,
              lastAccessedAt: latestEntry.lastAccessedAt,
              sizeBytes: latestEntry.sizeBytes,
              encoding: latestEntry.encoding,
            }
          : null,
        entriesByPlatform: {
          android: catalog.entries.filter(
            (entry) => entry.platform === "android"
          ).length,
          ios: catalog.entries.filter((entry) => entry.platform === "ios")
            .length,
        },
        usage: catalog.usage,
        compression: {
          compressedEntries: catalog.entries.filter(
            (entry) => entry.encoding === "zstd"
          ).length,
          logicalArtifactBytes: checkedSum(
            catalog.entries.map((entry) => entry.logicalArtifactBytes),
            "Logical artifact storage"
          ),
          payloadBytes: checkedSum(
            catalog.entries.map((entry) => entry.payloadBytes ?? 0),
            "Compressed payload storage"
          ),
          grossSavedBytes,
          restoreBytes: catalog.usage.restoreCommittedBytes,
          netSavedBytes: grossSavedBytes - catalog.usage.restoreCommittedBytes,
        },
        policy,
        hitRate: telemetry.hitRate,
        estimatedTimeSavedMs:
          telemetry.hits === telemetry.hitsWithoutEstimate
            ? null
            : telemetry.estimatedTimeSavedMs,
        telemetry: {
          scope: "recorded-retained-resolves",
          ...telemetry,
          invalidEventCount: catalog.telemetry.invalidEventCount,
        },
        issues: catalog.issues,
      };
      if (parsed.json) {
        printJson(output);
      } else {
        console.log(
          `${output.entryCount} entries using ${formatSizeBytes(
            output.usage.entriesBytes
          )} (${output.entriesByPlatform.ios} iOS, ${
            output.entriesByPlatform.android
          } Android)`
        );
        console.log(
          output.latestBuild === null
            ? "Latest build: unavailable (no versioned cache entries)"
            : `Latest build: ${output.latestBuild.platform} ${output.latestBuild.fingerprint} created ${output.latestBuild.createdAt}`
        );
        console.log(
          `Apparent managed cache bytes: ${formatSizeBytes(
            output.usage.managedBytes
          )}; provider and legacy bytes: ${formatSizeBytes(
            output.usage.totalBytes
          )}`
        );
        console.log(
          `Compression: ${
            output.compression.compressedEntries
          } entries represent ${formatSizeBytes(
            output.compression.logicalArtifactBytes
          )}; payloads ${formatSizeBytes(
            output.compression.payloadBytes
          )}; gross saved ${formatSizeBytes(
            output.compression.grossSavedBytes
          )}; restores ${formatSizeBytes(
            output.compression.restoreBytes
          )}; net saved ${formatSignedSize(output.compression.netSavedBytes)}`
        );
        console.log(
          output.hitRate === null
            ? "Hit rate: unavailable (no retained cache decisions)"
            : `Hit rate: ${(output.hitRate * 100).toFixed(1)}% (${
                telemetry.hits
              } hits / ${telemetry.hits + telemetry.misses} decisions)`
        );
        console.log(
          output.estimatedTimeSavedMs === null
            ? `Estimated time saved: unavailable (${telemetry.hitsWithoutEstimate} hits lacked timing data)`
            : `Estimated time saved: ~${formatDuration(
                output.estimatedTimeSavedMs
              )} (${telemetry.hitsWithoutEstimate} hits lacked timing data)`
        );
      }
      return catalog.issues.some((issue) => issue.severity === "error") ? 1 : 0;
    }

    if (parsed.command === "doctor") {
      const report = parsed.deep
        ? await doctorCacheDeep(parsed.projectRoot)
        : doctorCache(parsed.projectRoot);
      if (parsed.json) {
        printJson(report);
      } else if (report.healthy) {
        console.log(
          `Cache is healthy (${report.checkedEntries} entries and ${
            report.checkedRestores
          } restores checked${
            report.deep ? ", deep validation complete" : ""
          }).`
        );
      } else {
        for (const issue of report.issues) {
          console.log(
            `${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`
          );
        }
      }
      if (!parsed.json) {
        console.log(
          `Compression storage: gross saved ${formatSizeBytes(
            report.compression.grossSavedBytes
          )}; restores ${formatSizeBytes(
            report.compression.restoreBytes
          )}; net saved ${formatSignedSize(report.compression.netSavedBytes)}.`
        );
      }
      return report.healthy ? 0 : 1;
    }

    let basePolicy;
    try {
      basePolicy = readPolicyState(
        catalog.paths.providerRoot,
        catalog.paths.stateRoot
      );
    } catch {
      basePolicy = normalizeCacheOptions();
    }
    let policy;
    try {
      policy = normalizeCacheOptions({
        maxSize: parsed.overrides.maxSize ?? basePolicy.maxSizeBytes,
        maxEntries: parsed.overrides.maxEntries ?? basePolicy.maxEntries,
        retentionDays:
          parsed.overrides.retentionDays ??
          (basePolicy.retentionMs === null
            ? null
            : basePolicy.retentionMs / (24 * 60 * 60 * 1000)),
        autoPrune: basePolicy.autoPrune,
      });
    } catch (error) {
      throw new UsageError(
        error instanceof Error ? error.message : "Invalid cleanup policy"
      );
    }
    const result = await pruneCache(parsed.projectRoot, policy, {
      dryRun: parsed.dryRun,
    });
    if (parsed.json) {
      printJson(result);
    } else {
      const action = parsed.dryRun ? "Would remove" : "Removed";
      console.log(
        `${action} ${
          parsed.dryRun ? result.candidates.length : result.removed.length
        } source entries and ${
          parsed.dryRun
            ? result.auxiliaryCandidates.length
            : result.auxiliaryRemoved.length
        } auxiliary items; restore bytes ${formatSizeBytes(
          (parsed.dryRun ? result.auxiliaryCandidates : result.auxiliaryRemoved)
            .filter((candidate) => candidate.category === "restore")
            .reduce((total, candidate) => total + candidate.sizeBytes, 0)
        )}; reclaim ${formatSizeBytes(result.reclaimedBytes)} apparent bytes.`
      );
      if (result.skipped.length > 0) {
        console.log(`${result.skipped.length} entries were protected or busy.`);
      }
    }
    return result.limitsSatisfied && result.issues.length === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error("Run eas-local-cache --help for usage.");
      return 2;
    }
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
};
