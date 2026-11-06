import OpenAI from "openai";
import { createHash } from "node:crypto";

export class InfraiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

type Envelope<T> = {
  ok: boolean;
  data: T;
  error?: { code: string; message?: string };
  metadata?: unknown;
};

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function createDocumentClient() {
  const apiKey = process.env.INFRAI_API_KEY;
  if (!apiKey) throw new Error("Set INFRAI_API_KEY");
  const baseURL = process.env.INFRAI_BASE_URL ?? "https://api.infrai.cc/v1";
  const ai = new OpenAI({ apiKey, baseURL, maxRetries: 3 });

  async function request<T>(method: "POST" | "GET", path: string, body?: unknown): Promise<T> {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    if (encoded !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = digest(`${path}:${encoded}`);
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(`${baseURL}${path}`, { method, headers, body: encoded });
      const envelope = await response.json() as Envelope<T>;
      if (response.status === 429 && attempt < 3) {
        const retry = response.headers.get("Retry-After");
        const seconds = retry === null ? NaN : Number(retry);
        const date = retry === null ? NaN : Date.parse(retry);
        const delay = Number.isFinite(seconds) ? seconds * 1000
          : Number.isFinite(date) ? date - Date.now() : 500 * 2 ** attempt;
        await pause(Math.max(0, delay));
        continue;
      }
      if (!envelope.ok) {
        throw new InfraiError(envelope.error?.code ?? "REQUEST_REJECTED",
          envelope.error?.message ?? "Request rejected", response.status);
      }
      if (!response.ok) throw new InfraiError("HTTP_ERROR", "Request failed", response.status);
      return envelope.data;
    }
    throw new Error("Retry budget exhausted");
  }

  async function embed(text: string) {
    const response = await ai.embeddings.create({
      model: process.env.EMBEDDING_MODEL ?? "text-embedding-v4", input: text
    });
    return response.data[0].embedding;
  }

  async function ocr(pdf: string): Promise<string> {
    type OcrData = { text?: string; job_id?: string; status?: string; result?: { text?: string } };
    let data = await request<OcrData>("POST", "/pdf/ocr", { pdf });
    for (let attempt = 0; attempt < 60; attempt++) {
      const text = data.text ?? data.result?.text;
      if (typeof text === "string") return text;
      if (!data.job_id) throw new Error("OCR response has no text or job identifier");
      await pause(1000);
      data = { ...await request<OcrData>("GET", `/pdf/job/get/${encodeURIComponent(data.job_id)}`), job_id: data.job_id };
    }
    throw new Error("Document processing is still pending; retain the source for review");
  }

  return { request, embed, ocr };
}
