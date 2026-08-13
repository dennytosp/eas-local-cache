import type { EntryLock } from "../cache/lock";
import type { CachePlatform } from "../cache/paths";
import { NonceReplayGuard, verifyAuthHeaders } from "./auth";
import type { LanAuthorizedClient } from "./types";

export type LanCapability = "read" | "write";

export type LanAuthenticatedClient = {
  clientId: string;
  capabilities: readonly LanCapability[];
};

export type LanAuthenticationRequest = {
  clientId: string;
  timestamp: string;
  nonce: string;
  contentSha256: string;
  signature: string;
  contentLength: number;
  method: string;
  pathname: string;
  allowPendingPairing: boolean;
};

export type PreparedLanEntry = {
  packagePath: string;
  sizeBytes: number;
  sha256: string;
  cleanup?: () => void | Promise<void>;
};

export type LanServerOptions = {
  host?: string;
  port?: number;
  certificatePem: string;
  privateKeyPem: string;
  serverId: string;
  allowWrite?: boolean;
  incomingDirectory: string;
  transferLocksRoot?: string;
  authenticate: (
    request: LanAuthenticationRequest
  ) => LanAuthenticatedClient | null | Promise<LanAuthenticatedClient | null>;
  pair?: (
    body: unknown,
    context: { remoteAddress: string }
  ) => unknown | Promise<unknown>;
  acknowledgePairing?: (
    pairingId: string,
    client: LanAuthenticatedClient
  ) => unknown | Promise<unknown>;
  prepareEntry: (
    platform: CachePlatform,
    entryId: string,
    deadlineMs: number
  ) => PreparedLanEntry | null | Promise<PreparedLanEntry | null>;
  importEntry: (
    platform: CachePlatform,
    entryId: string,
    packagePath: string,
    transferLock: EntryLock | undefined,
    deadlineMs: number
  ) =>
    | "created"
    | "existing"
    | "conflict"
    | Promise<"created" | "existing" | "conflict">;
  globalTransferLimit?: number;
  perClientTransferLimit?: number;
  requestInactivityMs?: number;
  operationTimeoutMs?: number;
};

export const createLanServerAuthenticator = (options: {
  findClient: (
    clientId: string
  ) => LanAuthorizedClient | null | Promise<LanAuthorizedClient | null>;
  allowPendingClient?: (
    client: LanAuthorizedClient,
    request: LanAuthenticationRequest
  ) => boolean | Promise<boolean>;
  replayGuard?: NonceReplayGuard;
}): LanServerOptions["authenticate"] => {
  const replayGuard = options.replayGuard ?? new NonceReplayGuard();
  return async (request) => {
    const client = await options.findClient(request.clientId);
    if (!client) return null;
    const statusAllowed =
      client.status === "active" ||
      (request.allowPendingPairing &&
        client.status === "pending" &&
        options.allowPendingClient &&
        (await options.allowPendingClient(client, request)));
    if (!statusAllowed) return null;
    try {
      verifyAuthHeaders({
        headers: {
          clientId: request.clientId,
          timestamp: request.timestamp,
          nonce: request.nonce,
          contentSha256: request.contentSha256,
          signature: request.signature,
        },
        secret: client.secret,
        method: request.method,
        pathname: request.pathname,
        contentLength: request.contentLength,
        replayGuard,
      });
      return {
        clientId: client.clientId,
        capabilities: [
          ...(client.capabilities.read ? (["read"] as const) : []),
          ...(client.capabilities.write ? (["write"] as const) : []),
        ],
      };
    } catch {
      return null;
    }
  };
};

export type LanServerHandle = {
  host: string;
  port: number;
  url: string;
  close: (drainMs?: number) => Promise<void>;
};
