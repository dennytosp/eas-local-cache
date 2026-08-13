import * as net from "net";

import Bonjour from "bonjour-service";
import type { Browser, Service } from "bonjour-service";

const SERVICE_TYPE = "eas-local-cache";
const PEER_PREFIX_LENGTH = 16;

export type LanDiscoveredEndpoint = {
  serverId: string;
  host: string;
  port: number;
  capabilities: { read: true; write: boolean };
};

export type LanAdvertisement = {
  stop: () => Promise<void>;
};

export type LanDiscoveryFactory = () => Pick<
  Bonjour,
  "publish" | "find" | "destroy"
>;

const defaultFactory: LanDiscoveryFactory = () =>
  new Bonjour(undefined, () => {
    // Multicast failures are optional discovery failures, never cache failures.
  });

const privateIpv4 = (address: string): boolean => {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) {
    return false;
  }
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
};

export const isPrivateLanAddress = (address: string): boolean => {
  const normalized = address.split("%")[0]!.toLowerCase();
  const family = net.isIP(normalized);
  if (family === 4) return privateIpv4(normalized);
  if (family !== 6) return false;
  return (
    normalized === "::1" ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  );
};

const txtString = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return null;
};

const endpointFromService = (
  service: Service,
  pairedIds: readonly string[]
): LanDiscoveredEndpoint | null => {
  if (
    service.type !== SERVICE_TYPE ||
    !Number.isInteger(service.port) ||
    service.port < 1 ||
    service.port > 65_535 ||
    !service.txt ||
    typeof service.txt !== "object"
  ) {
    return null;
  }
  const keys = Object.keys(service.txt).sort();
  if (keys.join(",") !== "caps,id,v") return null;
  const version = txtString(service.txt.v);
  const prefix = txtString(service.txt.id);
  const capability = txtString(service.txt.caps);
  if (
    version !== "1" ||
    !prefix ||
    !/^[a-f0-9]{16}$/.test(prefix) ||
    (capability !== "r" && capability !== "rw")
  ) {
    return null;
  }
  const matches = pairedIds.filter((peerId) => peerId.startsWith(prefix));
  if (matches.length !== 1) return null;
  const candidates = [
    service.referer?.address,
    ...(service.addresses ?? []),
  ].filter((value): value is string => typeof value === "string");
  const host = candidates.find(isPrivateLanAddress);
  if (!host) return null;
  return {
    serverId: matches[0]!,
    host,
    port: service.port,
    capabilities: { read: true, write: capability === "rw" },
  };
};

export const advertiseLanPeer = (options: {
  serverId: string;
  port: number;
  allowWrite: boolean;
  host?: string;
  factory?: LanDiscoveryFactory;
}): LanAdvertisement => {
  if (!/^[a-f0-9]{64}$/.test(options.serverId)) {
    throw new Error("Cannot advertise an invalid LAN peer identity");
  }
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65_535
  ) {
    throw new Error("Cannot advertise an invalid LAN port");
  }
  if (options.host && !isPrivateLanAddress(options.host)) {
    throw new Error("LAN discovery host must be private or loopback");
  }
  const bonjour = (options.factory ?? defaultFactory)();
  const service = bonjour.publish({
    name: `eas-local-cache-${options.serverId.slice(0, 8)}`,
    type: SERVICE_TYPE,
    protocol: "tcp",
    port: options.port,
    ...(options.host ? { host: options.host } : {}),
    txt: {
      v: "1",
      id: options.serverId.slice(0, PEER_PREFIX_LENGTH),
      caps: options.allowWrite ? "rw" : "r",
    },
    probe: true,
  });
  return {
    stop: async () => {
      await new Promise<void>((resolve) => service.stop(() => resolve()));
      await new Promise<void>((resolve) => bonjour.destroy(() => resolve()));
    },
  };
};

export const discoverPairedEndpoints = async (
  pairedServerIds: readonly string[],
  options: { windowMs?: number; factory?: LanDiscoveryFactory } = {}
): Promise<LanDiscoveredEndpoint[]> => {
  const validIds = [
    ...new Set(
      pairedServerIds.filter((peerId) => /^[a-f0-9]{64}$/.test(peerId))
    ),
  ].slice(0, 8);
  if (validIds.length === 0) return [];
  const bonjour = (options.factory ?? defaultFactory)();
  const endpoints = new Map<string, LanDiscoveredEndpoint>();
  let browser: Browser | null = null;
  try {
    browser = bonjour.find(
      { type: SERVICE_TYPE, protocol: "tcp" },
      (service) => {
        const endpoint = endpointFromService(service, validIds);
        if (endpoint) endpoints.set(endpoint.serverId, endpoint);
      }
    );
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.max(0, Math.min(options.windowMs ?? 300, 2_000)))
    );
  } finally {
    browser?.stop();
    await new Promise<void>((resolve) => bonjour.destroy(() => resolve()));
  }
  return [...endpoints.values()];
};

export const discoveryTxtForTesting = endpointFromService;
