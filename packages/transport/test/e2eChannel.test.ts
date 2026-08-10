/**
 * E2E channel conformance. fixtures/channel.json carries a Swift-derived key
 * schedule (fixed identity + ephemeral seeds) and an AEAD frame with a fixed
 * nonce — sealing the fixture plaintext through a full TS handshake must
 * reproduce Swift's bytes exactly.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair } from "@domo/protocol";
import { E2EChannel, HandshakeError, openWithKey, sealWithKey } from "@domo/transport";

const fixturesDir = fileURLToPath(new URL("../../../fixtures", import.meta.url));
const f = JSON.parse(fs.readFileSync(path.join(fixturesDir, "channel.json"), "utf8"));

const idA = KeyPair.fromRawRepresentation(Buffer.from(f.initiatorIdentitySeedBase64, "base64"));
const idB = KeyPair.fromRawRepresentation(Buffer.from(f.responderIdentitySeedBase64, "base64"));
const ephASeed = Buffer.from(f.initiatorEphemeralSeedBase64, "base64");
const ephBSeed = Buffer.from(f.responderEphemeralSeedBase64, "base64");

describe("E2E channel golden vectors", () => {
  it("AEAD framing matches Swift byte-for-byte (fixed nonce)", () => {
    const key = Buffer.from(f.aead.keyBase64, "base64");
    const nonce = Buffer.from(f.aead.nonceBase64, "base64");
    const plaintext = Buffer.from(f.aead.plaintextBase64, "base64");
    expect(sealWithKey(key, plaintext, nonce).toString("base64")).toBe(f.aead.combinedBase64);
    expect(openWithKey(key, Buffer.from(f.aead.combinedBase64, "base64")).equals(plaintext)).toBe(
      true,
    );
  });

  it("handshake with fixture seeds reproduces Swift's key schedule", () => {
    const { channel: initiator, msg1 } = E2EChannel.initiate(idA, idB.publicKeyBase64, ephASeed);
    const m1 = JSON.parse(msg1.toString("utf8"));
    expect(m1.e).toBe(f.initiatorEphemeralPublicBase64);
    expect(m1.id).toBe(idA.publicKeyBase64);

    const { channel: responder, msg2 } = E2EChannel.respond(
      idB,
      idA.publicKeyBase64,
      msg1,
      ephBSeed,
    );
    const m2 = JSON.parse(msg2.toString("utf8"));
    expect(m2.e).toBe(f.responderEphemeralPublicBase64);
    initiator.receiveResponse(msg2);
    expect(initiator.isEstablished).toBe(true);
    expect(responder.isEstablished).toBe(true);

    // Initiator's send key must be Swift's i2r key: sealing the fixture
    // plaintext with the fixture nonce must reproduce Swift's sealed frame.
    const plaintext = Buffer.from(f.aead.plaintextBase64, "base64");
    const nonce = Buffer.from(f.aead.nonceBase64, "base64");
    expect(initiator.seal(plaintext, nonce).toString("base64")).toBe(f.aead.combinedBase64);
    // And the responder can open Swift's sealed frame.
    const opened = responder.open(Buffer.from(f.aead.combinedBase64, "base64"));
    expect(opened.equals(plaintext)).toBe(true);
  });

  it("Swift handshake signatures verify under the same layouts", () => {
    const ePubA = Buffer.from(f.initiatorEphemeralPublicBase64, "base64");
    const ePubB = Buffer.from(f.responderEphemeralPublicBase64, "base64");
    const msg1Signed = Buffer.concat([Buffer.from(f.initContext, "utf8"), ePubA]);
    const msg2Signed = Buffer.concat([Buffer.from(f.respContext, "utf8"), ePubB, ePubA]);
    expect(
      KeyPair.verify(Buffer.from(f.msg1SignatureBase64, "base64"), msg1Signed, idA.publicKeyBase64),
    ).toBe(true);
    expect(
      KeyPair.verify(Buffer.from(f.msg2SignatureBase64, "base64"), msg2Signed, idB.publicKeyBase64),
    ).toBe(true);
  });
});

describe("E2E channel behavior", () => {
  it("full handshake, both directions, tamper rejection", () => {
    const agent = new KeyPair();
    const device = new KeyPair();
    const { channel: initiator, msg1 } = E2EChannel.initiate(agent, device.publicKeyBase64);
    const { channel: responder, msg2 } = E2EChannel.respond(device, agent.publicKeyBase64, msg1);
    initiator.receiveResponse(msg2);

    const a2d = initiator.seal(Buffer.from("to device"));
    expect(responder.open(a2d).toString()).toBe("to device");
    const d2a = responder.seal(Buffer.from("to agent"));
    expect(initiator.open(d2a).toString()).toBe("to agent");

    const tampered = Buffer.from(a2d);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => responder.open(tampered)).toThrow(HandshakeError);
  });

  it("rejects a MITM identity substitution", () => {
    const agent = new KeyPair();
    const device = new KeyPair();
    const mitm = new KeyPair();
    // Broker swaps in its own handshake: device expects the *agent's* pinned key.
    const { msg1 } = E2EChannel.initiate(mitm, device.publicKeyBase64);
    expect(() => E2EChannel.respond(device, agent.publicKeyBase64, msg1)).toThrow(
      "unexpected peer identity",
    );
  });

  it("rejects a forged signature over a swapped ephemeral", () => {
    const agent = new KeyPair();
    const device = new KeyPair();
    const { msg1 } = E2EChannel.initiate(agent, device.publicKeyBase64);
    const parsed = JSON.parse(msg1.toString("utf8"));
    // Swap the ephemeral but keep the identity + signature.
    const { msg1: other } = E2EChannel.initiate(agent, device.publicKeyBase64);
    parsed.e = JSON.parse(other.toString("utf8")).e;
    expect(() =>
      E2EChannel.respond(device, agent.publicKeyBase64, Buffer.from(JSON.stringify(parsed))),
    ).toThrow("bad initiator signature");
  });
});
