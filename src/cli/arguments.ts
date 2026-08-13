import * as path from "path";

import type { CacheProviderOptions } from "../cache/options";

export type ParsedArguments = {
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

export class UsageError extends Error {}

export const HELP = `eas-local-cache — inspect and maintain the local Expo build cache

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
