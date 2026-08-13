export type LanCapabilities = {
  read: boolean;
  write: boolean;
};

export type LanEndpoint = {
  host: string;
  port: number;
};

export type LanServerIdentity = {
  peerId: string;
  certificatePem: string;
  privateKeyPem: string;
  createdAt: string;
  expiresAt: string;
};

export type LanOutboundPeer = {
  peerId: string;
  alias: string | null;
  certificatePem: string;
  endpoint: LanEndpoint;
  secret: string;
  capabilities: LanCapabilities;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastSuccessAt: string | null;
};

export type LanAuthorizedClientStatus = "pending" | "active" | "revoked";

export type LanAuthorizedClient = {
  clientId: string;
  secret: string;
  capabilities: LanCapabilities;
  status: LanAuthorizedClientStatus;
  pairingId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LanState = {
  schema: 1;
  clientId: string;
  serverIdentity: LanServerIdentity | null;
  outboundPeers: LanOutboundPeer[];
  authorizedClients: LanAuthorizedClient[];
};
