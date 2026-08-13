import * as crypto from "crypto";

import {
  NonceReplayGuard,
  readAuthHeaderValues,
  verifyAuthHeaders,
} from "./auth";
import { updateLanState } from "./state";
import { readLanState } from "./state";
import type {
  LanAuthenticationRequest,
  LanAuthenticatedClient,
} from "./server";
import type { LanCapabilities } from "./types";

const PAIRING_ID_BYTES = 16;
const PAIRING_TTL_MS = 5 * 60_000;
const exactObject = (
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

const capabilityMatches = (actual: string, expected: string): boolean => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(actual)) return false;
  const actualBytes = Buffer.from(actual, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  return (
    actualBytes.length === 32 &&
    expectedBytes.length === 32 &&
    crypto.timingSafeEqual(actualBytes, expectedBytes)
  );
};

const isFreshPendingClient = (updatedAt: string, nowMs: number): boolean => {
  const updatedAtMs = Date.parse(updatedAt);
  const ageMs = nowMs - updatedAtMs;
  return Number.isFinite(updatedAtMs) && ageMs >= 0 && ageMs < PAIRING_TTL_MS;
};

export type LanPairingWindow = {
  capability: string;
  expiresAt: string;
  allowWrite: boolean;
};

export type LanServerCoordinator = {
  pair: (body: unknown) => Promise<unknown>;
  authenticate: (
    request: LanAuthenticationRequest
  ) => Promise<LanAuthenticatedClient | null>;
  acknowledgePairing: (
    pairingId: string,
    client: LanAuthenticatedClient
  ) => Promise<void>;
  discardPendingPairing: () => Promise<void>;
};

export const createLanServerCoordinator = (input: {
  providerRoot: string;
  serverId: string;
  pairingWindow?: LanPairingWindow | null;
  now?: () => number;
  replayGuard?: NonceReplayGuard;
}): LanServerCoordinator => {
  const now = input.now ?? Date.now;
  const replayGuard = input.replayGuard ?? new NonceReplayGuard();
  let reservedClientId: string | null = null;
  let reservedPairingId: string | null = null;
  let consumed = false;

  return {
    pair: async (body) => {
      if (
        !input.pairingWindow ||
        consumed ||
        now() >= Date.parse(input.pairingWindow.expiresAt) ||
        !exactObject(body, ["clientId", "capability"]) ||
        typeof body.clientId !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(body.clientId) ||
        typeof body.capability !== "string" ||
        !capabilityMatches(body.capability, input.pairingWindow.capability) ||
        (reservedClientId !== null && reservedClientId !== body.clientId)
      ) {
        throw new Error("LAN pairing was rejected");
      }
      reservedClientId = body.clientId;
      let result: {
        pairingId: string;
        serverId: string;
        secret: string;
        capabilities: LanCapabilities;
        expiresAt: string;
      } | null = null;
      await updateLanState(input.providerRoot, (state) => {
        const currentTime = now();
        state.authorizedClients = state.authorizedClients.filter(
          (client) =>
            client.status !== "pending" ||
            isFreshPendingClient(client.updatedAt, currentTime) ||
            client.clientId === body.clientId
        );
        const existing = state.authorizedClients.find(
          (client) => client.clientId === body.clientId
        );
        const capabilities = {
          read: true,
          write: input.pairingWindow!.allowWrite,
        };
        if (
          existing?.status === "pending" &&
          existing.pairingId &&
          isFreshPendingClient(existing.updatedAt, currentTime) &&
          reservedClientId === existing.clientId
        ) {
          result = {
            pairingId: existing.pairingId,
            serverId: input.serverId,
            secret: existing.secret,
            capabilities: existing.capabilities,
            expiresAt: input.pairingWindow!.expiresAt,
          };
          return;
        }
        const timestamp = new Date(currentTime).toISOString();
        const client = {
          clientId: body.clientId as string,
          secret: crypto.randomBytes(32).toString("base64url"),
          capabilities,
          status: "pending" as const,
          pairingId: crypto.randomBytes(PAIRING_ID_BYTES).toString("base64url"),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const index = state.authorizedClients.findIndex(
          (candidate) => candidate.clientId === body.clientId
        );
        if (index === -1) state.authorizedClients.push(client);
        else state.authorizedClients[index] = client;
        result = {
          pairingId: client.pairingId,
          serverId: input.serverId,
          secret: client.secret,
          capabilities,
          expiresAt: input.pairingWindow!.expiresAt,
        };
      });
      if (!result) throw new Error("LAN pairing was rejected");
      const paired = result as {
        pairingId: string;
        serverId: string;
        secret: string;
        capabilities: LanCapabilities;
        expiresAt: string;
      };
      reservedPairingId = paired.pairingId;
      return paired;
    },

    authenticate: async (request) => {
      const state = readLanState(input.providerRoot);
      const client = state?.authorizedClients.find(
        (candidate) => candidate.clientId === request.clientId
      );
      const pendingAllowed =
        client?.status === "pending" &&
        request.allowPendingPairing &&
        request.method === "POST" &&
        request.pathname === "/v1/pair/ack" &&
        input.pairingWindow !== null &&
        input.pairingWindow !== undefined &&
        !consumed &&
        reservedClientId === client.clientId &&
        client.pairingId !== null &&
        now() < Date.parse(input.pairingWindow.expiresAt) &&
        isFreshPendingClient(client.updatedAt, now());
      if (
        !client ||
        client.status === "revoked" ||
        (client.status === "pending" && !pendingAllowed)
      ) {
        return null;
      }
      try {
        verifyAuthHeaders({
          headers: readAuthHeaderValues({
            "x-elc-client-id": request.clientId,
            "x-elc-timestamp": request.timestamp,
            "x-elc-nonce": request.nonce,
            "x-elc-content-sha256": request.contentSha256,
            "x-elc-signature": request.signature,
          }),
          secret: client.secret,
          method: request.method,
          pathname: request.pathname,
          contentLength: request.contentLength,
          now: now(),
          replayGuard,
        });
      } catch {
        return null;
      }
      return {
        clientId: client.clientId,
        capabilities: [
          ...(client.capabilities.read ? (["read"] as const) : []),
          ...(client.capabilities.write ? (["write"] as const) : []),
        ],
      };
    },

    acknowledgePairing: async (pairingId, authenticated) => {
      const pairingWindow = input.pairingWindow;
      const currentTime = now();
      if (
        !pairingWindow ||
        consumed ||
        reservedClientId !== authenticated.clientId ||
        currentTime >= Date.parse(pairingWindow.expiresAt)
      ) {
        throw new Error("LAN pairing acknowledgement failed");
      }
      let acknowledged = false;
      await updateLanState(input.providerRoot, (state) => {
        const client = state.authorizedClients.find(
          (candidate) => candidate.clientId === authenticated.clientId
        );
        if (
          !client ||
          client.status !== "pending" ||
          client.pairingId !== pairingId ||
          !isFreshPendingClient(client.updatedAt, currentTime)
        ) {
          return;
        }
        client.status = "active";
        client.pairingId = null;
        client.updatedAt = new Date(currentTime).toISOString();
        acknowledged = true;
      });
      if (!acknowledged) throw new Error("LAN pairing acknowledgement failed");
      reservedClientId = null;
      reservedPairingId = null;
      consumed = true;
    },

    discardPendingPairing: async () => {
      const clientId = reservedClientId;
      const pairingId = reservedPairingId;
      if (!clientId || !pairingId || consumed) return;
      await updateLanState(input.providerRoot, (state) => {
        state.authorizedClients = state.authorizedClients.filter(
          (client) =>
            client.clientId !== clientId ||
            client.status !== "pending" ||
            client.pairingId !== pairingId
        );
      });
      reservedClientId = null;
      reservedPairingId = null;
    },
  };
};

export const createPairingWindow = (input: {
  allowWrite: boolean;
  now?: number;
}): LanPairingWindow => ({
  capability: crypto.randomBytes(32).toString("base64url"),
  expiresAt: new Date((input.now ?? Date.now()) + PAIRING_TTL_MS).toISOString(),
  allowWrite: input.allowWrite,
});
