export type ShipmentEvent = "in_transit" | "delivered" | "exception";
export type DeliveryDocument = {
  shipmentId: string;
  event: ShipmentEvent;
  kind: "proof_of_delivery" | "exception_report";
  exceptionReason?: string;
};

export function deliveryDecision(document: DeliveryDocument, text: string) {
  if (!text.trim()) return { state: "review_required", reason: "empty_text" } as const;
  if (document.event === "exception") {
    return { state: "review_required", reason: "shipment_exception" } as const;
  }
  if (document.event === "delivered" && document.kind === "proof_of_delivery") {
    return { state: "delivery_evidence_indexed", reason: "proof_received" } as const;
  }
  return { state: "document_indexed", reason: "shipment_updated" } as const;
}
