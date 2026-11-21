import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ProtectError, isProcessingRefusal } from "../src/device/protect.ts";

/**
 * Telling "this image will never go up" from "the controller had a bad
 * minute". Both arrive as a 500, so getting this wrong either retries a
 * doomed GIF all day or sets a good one aside for a blip.
 */
describe("isProcessingRefusal", () => {
  const body =
    '{"error":"Failed to process and persist files. File: /tmp/1795247152442-x, FileType: animations","name":"UNKNOWN_ERROR"}';

  it("recognises Protect failing to process the upload", () => {
    assert.equal(isProcessingRefusal(new ProtectError("POST /files/animations failed with 500", 500, body)), true);
  });

  it("treats too large and unsupported type as the image's fault too", () => {
    assert.equal(isProcessingRefusal(new ProtectError("x", 413, "")), true);
    assert.equal(isProcessingRefusal(new ProtectError("x", 415, "")), true);
  });

  it("leaves any other 500, and anything that is not from Protect, to be retried", () => {
    assert.equal(isProcessingRefusal(new ProtectError("x", 500, '{"error":"Internal"}')), false);
    assert.equal(isProcessingRefusal(new ProtectError("x", 502, body)), false);
    assert.equal(isProcessingRefusal(new Error("Failed to process")), false);
  });
});
