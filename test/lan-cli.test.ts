import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { parseCliArguments, runCli } from "../src/cli";

describe("trusted LAN CLI parser", () => {
  it("parses a bounded foreground server configuration", () => {
    expect(
      parseCliArguments([
        "serve",
        "--host",
        "0.0.0.0",
        "--port",
        "43123",
        "--advertise-host",
        "192.168.1.20",
        "--allow-write",
        "--pairing",
        "--pairing-file",
        "/tmp/easlc-pairing-test",
        "--no-discovery",
        "--json",
      ])
    ).toEqual(
      expect.objectContaining({
        command: "serve",
        host: "0.0.0.0",
        port: 43123,
        advertiseHost: "192.168.1.20",
        allowWrite: true,
        pairing: true,
        discovery: false,
        json: true,
      })
    );
  });

  it("accepts hidden and file pairing input but never a positional URI", () => {
    expect(
      parseCliArguments(["pair", "--stdin", "--alias", "workstation"])
    ).toEqual(
      expect.objectContaining({
        command: "pair",
        stdin: true,
        alias: "workstation",
      })
    );
    expect(() => parseCliArguments(["pair", "easlc://pair/v1/secret"])).toThrow(
      "Unknown option"
    );
    expect(() =>
      parseCliArguments(["pair", "--stdin", "--pairing-file", "pair.txt"])
    ).toThrow("Use only one");
  });

  it("parses peer status and exact trust actions", () => {
    expect(parseCliArguments(["peers", "--check", "--require-online"])).toEqual(
      expect.objectContaining({
        command: "peers",
        check: true,
        requireOnline: true,
      })
    );
    expect(parseCliArguments(["peers", "revoke", "a".repeat(64)])).toEqual(
      expect.objectContaining({
        command: "peers",
        peerAction: "revoke",
        peerId: "a".repeat(64),
      })
    );
  });

  it("rejects invalid ports and command-specific option leakage", () => {
    expect(() => parseCliArguments(["serve", "--port", "65536"])).toThrow();
    expect(() => parseCliArguments(["serve", "--port", "1.5"])).toThrow();
    expect(() => parseCliArguments(["stats", "--port", "0"])).toThrow(
      "Server options"
    );
    expect(() => parseCliArguments(["stats", "--check"])).toThrow(
      "Peer status options"
    );
    expect(() => parseCliArguments(["peers", "--require-online"])).toThrow(
      "requires --check"
    );
    expect(() =>
      parseCliArguments(["serve", "--pairing-file", "/tmp/easlc-pairing-test"])
    ).toThrow("requires --pairing");
    expect(() => parseCliArguments(["serve", "--host", "::"])).toThrow(
      "--advertise-host"
    );
  });

  it("never removes a pre-existing pairing output file", async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "easlc-cli-pairing-file-")
    );
    const pairingFile = path.join(projectRoot, "pairing.secret");
    fs.writeFileSync(pairingFile, "belongs-to-user", { mode: 0o600 });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        await runCli([
          "serve",
          "--project-root",
          projectRoot,
          "--host",
          "127.0.0.1",
          "--no-discovery",
          "--pairing",
          "--pairing-file",
          pairingFile,
          "--json",
        ])
      ).toBe(1);
      expect(fs.readFileSync(pairingFile, "utf8")).toBe("belongs-to-user");
    } finally {
      error.mockRestore();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
