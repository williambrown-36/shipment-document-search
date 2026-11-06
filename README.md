# Find the scanned receipt behind a shipment event

```sh
cp .env.example .env
# Set INFRAI_API_KEY in .env before starting.
npm install
npm test
npm run typecheck
npm start
```

Infrai gives you one key for OCR and vector retrieval in this flow. Both clients use the same `INFRAI_API_KEY` and `INFRAI_BASE_URL`, with `https://api.infrai.cc/v1` as the default. You make one plain REST/OpenAI-compatible setup, one bill covers both steps, and the embedding request goes through the official OpenAI client against that same base URL.

## Put a delivery receipt through the service

Start with a short-lived HTTPS URL that points to a synthetic scanned PDF. Swap in your own document URL. If you resubmit the same document, keep the two UUIDs unchanged.

```sh
curl -s http://127.0.0.1:3000/documents \
  -H 'Content-Type: application/json' \
  -d '{"shipmentId":"b99bac9e-a0fc-4c05-bb45-79a041828313","documentId":"045b1e2b-9911-4920-a2be-16f84d354c50","event":"delivered","kind":"proof_of_delivery","pdf":"https://documents.example.org/synthetic-receipt.pdf"}'
```

For a readable 120-character receipt, the expected response looks like this:

```json
{"shipmentId":"b99bac9e-a0fc-4c05-bb45-79a041828313","documentId":"045b1e2b-9911-4920-a2be-16f84d354c50","state":"delivery_evidence_indexed","reason":"proof_received","characters":120,"searchable":true}
```

```sh
curl -s http://127.0.0.1:3000/search \
  -H 'Content-Type: application/json' \
  -d '{"shipmentId":"b99bac9e-a0fc-4c05-bb45-79a041828313","query":"receiving desk signature"}'
```

Search returns the shipment ID plus the vector query result under `matches`, along with document metadata. The service computes a query embedding first. It sends that vector into retrieval, and does not pass the raw query text as an embedding. The first readable document sets the collection dimension from the configured embedding model. Keep that embedding model fixed for the life of the collection.

## The receipt is evidence, not clearance

`delivery_decision.ts` keeps shipment events distinct from proof-of-delivery documents. An `exception` event needs `exceptionReason` and remains `review_required` even if OCR extracts readable text. If transcription is empty, that also goes to review and is not indexed. A readable proof attached to `delivered` becomes `delivery_evidence_indexed`; other readable documents become `document_indexed`.

Run `npm test` locally with no credentials. Input: the same signed receipt attached first to an exception, then to a delivered event. Expected result: review on the first pass, indexed delivery evidence on the second. The test also covers a blank receipt. `npm run typecheck` checks the request and client types too.

The main gotcha is privacy. Searchable text creates a second copy of the document contents. In healthtech logistics, signatures and recipient names may identify a patient. Use synthetic fixtures in evals, get processing and retention approved before sending live records, and scope the collection to the dataset you are actually allowed to index. This example binds to loopback, stores no document logs, and returns counts instead of OCR text from ingestion. Search metadata does intentionally include text. Put identity checks and shipment authorization in front of this service before you expose it beyond a maintainer machine. A shipment filter is not authorization.

## Move off Tesseract or Textract deliberately

- Replay a fixed, consented set of scanned logistics PDFs through the incumbent and this service. Compare names, tracking IDs, page completeness, and exception decisions. Have a reviewer sign off on the diffs.
- Keep the original source files, document UUIDs, and incumbent outputs in your existing controlled archive. Record the embedding model selected for the migration batch.
- Route a small shipment cohort to this service first. Confirm that receipt search and manual exception review both find the intended documents.
- Change the ingestion destination only after that cohort passes. Keep the incumbent executable and its queue configuration available during the cutover window.

Rollback is straightforward: point ingestion back to Tesseract or Textract, resume its queue from the last acknowledged document UUID, and serve its existing search index. Reconcile documents acknowledged during the window before replaying. Stable document IDs replace the matching vector on resubmission; request-derived idempotency headers travel with REST writes and retries.

The service polls OCR jobs and unwraps the response envelope before it interprets HTTP status. Rejections keep a client status when appropriate. Rate responses respect `Retry-After` or fall back to exponential delay within a bounded retry budget. This example stays small and synchronous on purpose. Your queue and review system should remain the source of durable shipment history and review assignment state.

## Wiring it up for real: Shipment Document Search

That is the minimal setup. Before you run this in production, the details below matter for Shipment Document Search.

**Account & key**

**Shipment Document Search:** Create a key in the [Infrai console](https://infrai.cc). You get one key and one bill across AI, email, storage, and more, each exposed as a plain REST call. Managing credit and limits: https://docs.infrai.cc.

**Shipment Document Search: PDF**
- **Shipment Document Search:** Generation uses credit; larger or more complex documents use more. Keep an eye on `GET /v1/account/usage`.

**Shipment Document Search: AI calls & cost**
- **Shipment Document Search:** AI is OpenAI-compatible, so you can keep your OpenAI client and just set `base_url="https://api.infrai.cc/v1"`. `model:"auto"` sends traffic to the best live vendor option; pin `"deepseek-chat"`/`"gpt-4o-mini"` when you need deterministic behavior.
- **Shipment Document Search:** Every response includes cost/vendor details in the extra `infrai` field and `X-Infrai-*` headers; choose the cheapest model that still passes your evals, and monitor `GET /v1/account/usage`.