import { createServer } from "node:http";
import { z } from "zod";
import { createDocumentClient, digest, InfraiError } from "./document_client.ts";
import { deliveryDecision } from "./delivery_decision.ts";

const documentBody = z.object({
  shipmentId: z.string().uuid(),
  documentId: z.string().uuid(),
  event: z.enum(["in_transit", "delivered", "exception"]),
  kind: z.enum(["proof_of_delivery", "exception_report"]),
  exceptionReason: z.string().min(1).max(300).optional(),
  pdf: z.string().url().refine(value => value.startsWith("https://"), "Use an HTTPS document URL")
}).strict().superRefine((value, ctx) => {
  if (value.event === "exception" && !value.exceptionReason) {
    ctx.addIssue({ code: "custom", path: ["exceptionReason"], message: "Record an exception reason" });
  }
});
const searchBody = z.object({ shipmentId: z.string().uuid(), query: z.string().min(1).max(2000) }).strict();
const client = createDocumentClient();
// One credential connects document recognition and shipment retrieval.
const collection = "shipment_documents";

createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method !== "POST" || !["/documents", "/search"].includes(req.url ?? "")) {
      send(404, { error: "Route not found" });
      return;
    }
    let raw = "";
    for await (const chunk of req) {
      raw += chunk.toString();
      if (Buffer.byteLength(raw) > 16384) { send(413, { error: "Body too large" }); return; }
    }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { send(400, { error: "Invalid JSON" }); return; }
    if (req.url === "/search") {
      const input = searchBody.parse(body);
      const embedding = await client.embed(input.query);
      const matches = await client.request("POST", "/vector/query", {
        collection, embedding, top_k: 5, filter: { shipmentId: input.shipmentId }, include_metadata: true
      });
      send(200, { shipmentId: input.shipmentId, matches });
      return;
    }
    const input = documentBody.parse(body);
    const text = await client.ocr(input.pdf);
    const decision = deliveryDecision({
      shipmentId: input.shipmentId,
      event: input.event,
      kind: input.kind,
      exceptionReason: input.exceptionReason
    }, text);
    if (text.trim()) {
      const embedding = await client.embed(text);
      await client.request("POST", "/vector/collection/create", {
        collection, dimension: embedding.length, metric: "cosine"
      });
      await client.request("POST", "/vector/upsert", {
        collection,
        vectors: [{ id: digest(`${input.shipmentId}:${input.documentId}`), embedding,
          metadata: { shipmentId: input.shipmentId, documentId: input.documentId, kind: input.kind, text } }]
      });
    }
    send(200, { shipmentId: input.shipmentId, documentId: input.documentId, ...decision,
      characters: text.length, searchable: Boolean(text.trim()) });
  } catch (error) {
    if (error instanceof z.ZodError) { send(400, { error: "Invalid request", fields: error.flatten() }); return; }
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      send(status, { error: error.code });
      return;
    }
    send(502, { error: "Document processing could not be completed" });
  }
}).listen(Number(process.env.PORT ?? 3000), "127.0.0.1", () => {
  console.log("Shipment document service listening on loopback");
});
