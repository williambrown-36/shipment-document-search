import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryDecision } from "../src/delivery_decision.ts";

test("a readable delivery receipt does not clear a shipment exception", () => {
  const receipt = { shipmentId: "shipment-42", kind: "proof_of_delivery" as const };
  assert.equal(deliveryDecision({ ...receipt, event: "exception" }, "Signed by receiving desk").state, "review_required");
  assert.equal(deliveryDecision({ ...receipt, event: "delivered" }, "Signed by receiving desk").state, "delivery_evidence_indexed");
  assert.equal(deliveryDecision({ ...receipt, event: "delivered" }, "  ").reason, "empty_text");
});
