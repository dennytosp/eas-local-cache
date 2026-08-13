import * as crypto from "crypto";

import type { LanServerIdentity } from "./types";

const CERTIFICATE_VALIDITY_DAYS = 365;
const CERTIFICATE_CLOCK_SKEW_MS = 5 * 60_000;

const toIsoString = (value: string): string => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Invalid LAN certificate timestamp");
  }
  return value;
};

export const getCertificateDer = (certificatePem: string): Buffer => {
  try {
    return new crypto.X509Certificate(certificatePem).raw;
  } catch {
    throw new Error("Invalid LAN server certificate");
  }
};

export const getCertificatePeerId = (certificatePem: string): string =>
  crypto
    .createHash("sha256")
    .update(getCertificateDer(certificatePem))
    .digest("hex");

export const certificateMatchesPeerId = (
  certificatePem: string,
  peerId: string
): boolean => {
  if (!/^[a-f0-9]{64}$/.test(peerId)) {
    return false;
  }
  const actual = Buffer.from(getCertificatePeerId(certificatePem), "hex");
  const expected = Buffer.from(peerId, "hex");
  return crypto.timingSafeEqual(actual, expected);
};

export const createServerIdentity = async (
  now = new Date()
): Promise<LanServerIdentity> => {
  const { generate } = await import("selfsigned");
  const notBeforeDate = new Date(now.getTime() - CERTIFICATE_CLOCK_SKEW_MS);
  const notAfterDate = new Date(
    now.getTime() + CERTIFICATE_VALIDITY_DAYS * 24 * 60 * 60_000
  );
  const generated = await generate(
    [{ name: "commonName", value: "eas-local-cache" }],
    {
      keyType: "rsa",
      keySize: 2048,
      algorithm: "sha256",
      notBeforeDate,
      notAfterDate,
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyEncipherment: true,
          critical: true,
        },
        { name: "extKeyUsage", serverAuth: true },
      ],
    }
  );

  const certificate = new crypto.X509Certificate(generated.cert);
  const certificatePem = certificate.toString();
  return {
    peerId: getCertificatePeerId(certificatePem),
    certificatePem,
    privateKeyPem: generated.private,
    createdAt: now.toISOString(),
    expiresAt: new Date(certificate.validTo).toISOString(),
  };
};

export const validateServerIdentity = (
  identity: LanServerIdentity,
  options: { now?: Date; allowExpired?: boolean } = {}
): void => {
  const createdAt = toIsoString(identity.createdAt);
  const expiresAt = toIsoString(identity.expiresAt);
  if (new Date(expiresAt).getTime() <= new Date(createdAt).getTime()) {
    throw new Error("Invalid LAN certificate validity period");
  }
  if (!certificateMatchesPeerId(identity.certificatePem, identity.peerId)) {
    throw new Error("LAN server certificate identity mismatch");
  }

  let certificate: crypto.X509Certificate;
  let publicFromPrivate: crypto.KeyObject;
  try {
    certificate = new crypto.X509Certificate(identity.certificatePem);
    publicFromPrivate = crypto.createPublicKey(
      crypto.createPrivateKey(identity.privateKeyPem)
    );
  } catch {
    throw new Error("Invalid LAN server private key");
  }

  const certificatePublic = certificate.publicKey.export({
    type: "spki",
    format: "der",
  });
  const privatePublic = publicFromPrivate.export({
    type: "spki",
    format: "der",
  });
  if (
    certificatePublic.length !== privatePublic.length ||
    !crypto.timingSafeEqual(certificatePublic, privatePublic)
  ) {
    throw new Error("LAN server certificate and private key do not match");
  }

  const certificateExpiresAt = new Date(certificate.validTo).toISOString();
  if (certificateExpiresAt !== expiresAt) {
    throw new Error("LAN server certificate expiry mismatch");
  }
  if (
    !options.allowExpired &&
    new Date(expiresAt).getTime() <= (options.now ?? new Date()).getTime()
  ) {
    throw new Error("LAN server certificate has expired");
  }
  if (
    certificate.subject !== "CN=eas-local-cache" ||
    certificate.issuer !== "CN=eas-local-cache" ||
    certificate.ca ||
    !certificate.verify(certificate.publicKey) ||
    !certificate.keyUsage?.includes("1.3.6.1.5.5.7.3.1") ||
    (certificate.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2_048
  ) {
    throw new Error("Invalid LAN server certificate profile");
  }
  const notBefore = new Date(certificate.validFrom).getTime();
  if (
    !options.allowExpired &&
    notBefore >
      (options.now ?? new Date()).getTime() + CERTIFICATE_CLOCK_SKEW_MS
  ) {
    throw new Error("LAN server certificate is not valid yet");
  }
};
