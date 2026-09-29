import 'server-only';

import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { z } from 'zod';
import type { ExtractedFields, ExtractionUsage } from './types';
import { normalizeDate, normalizeMoney } from './normalize';
import { demoExtraction } from './demo-data';
import { demoHeadlineDebtor, demoToday } from './demo-store';
import { portalConfig } from './portal-config';
import { demoRequest } from './demo-request';

const PRIMARY_MODEL = process.env.EXTRACTION_MODEL || 'gemini-3.5-flash-lite';
const THINKING = process.env.EXTRACTION_THINKING || 'minimal';
const DEFAULT_FALLBACKS = ['gemini-3.5-flash-lite', 'gemini-3.6-flash'];

function modelChain(): string[] {
  const configured = (process.env.EXTRACTION_FALLBACK_MODELS ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return [...new Set([PRIMARY_MODEL, ...(configured.length ? configured : DEFAULT_FALLBACKS)])];
}

function configuredThinkingLevel(): ThinkingLevel {
  switch (THINKING.toLowerCase()) {
    case 'low': return ThinkingLevel.LOW;
    case 'medium': return ThinkingLevel.MEDIUM;
    case 'high': return ThinkingLevel.HIGH;
    default: return ThinkingLevel.MINIMAL;
  }
}

const ExtractionSchema = z.object({
  documentType: z.enum(['invoice', 'bol', 'pod', 'rate_confirmation', 'other']),
  invoiceNumber: z.string().nullable(),
  referenceNumber: z.string().nullable(),
  documentDate: z.string().nullable(),
  clientName: z.string().nullable(),
  debtorName: z.string().nullable(),
  debtorAddress: z.string().nullable(),
  debtorCity: z.string().nullable(),
  debtorState: z.string().nullable(),
  debtorZip: z.string().nullable(),
  debtorPhone: z.string().nullable(),
  debtorEmail: z.string().nullable(),
  debtorEin: z.string().nullable(),
  invoiceAmount: z.number().nullable(),
  invoiceDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  signaturePresent: z.boolean().nullable(),
  uncertainFields: z.array(z.string()),
  notes: z.string().nullable(),
});

const responseSchema = {
  type: 'object',
  properties: {
    documentType: { type: 'string', enum: ['invoice', 'bol', 'pod', 'rate_confirmation', 'other'] },
    invoiceNumber: { type: ['string', 'null'], description: 'Invoice number only. Null if this document has no invoice number.' },
    referenceNumber: { type: ['string', 'null'], description: 'Best shared load, shipment, PRO, or reference identifier that can tie documents in this packet together.' },
    documentDate: { type: ['string', 'null'], description: 'Date printed for this specific document, YYYY-MM-DD.' },
    clientName: { type: ['string', 'null'], description: 'Carrier or seller that issued the invoice or performed the freight service.' },
    debtorName: { type: ['string', 'null'], description: 'Party expected to pay the invoice. Do not use shipper or consignee unless clearly identified as payer, bill-to, customer, or broker.' },
    debtorAddress: { type: ['string', 'null'] },
    debtorCity: { type: ['string', 'null'] },
    debtorState: { type: ['string', 'null'] },
    debtorZip: { type: ['string', 'null'] },
    debtorPhone: { type: ['string', 'null'] },
    debtorEmail: { type: ['string', 'null'] },
    debtorEin: { type: ['string', 'null'] },
    invoiceAmount: { type: ['number', 'null'], description: 'For an invoice, total amount due. For a rate confirmation, total agreed carrier rate. Usually null on BOL/POD.' },
    invoiceDate: { type: ['string', 'null'], description: 'Invoice date only, YYYY-MM-DD. On non-invoice documents use null unless an invoice date is explicitly printed.' },
    dueDate: { type: ['string', 'null'], description: 'Invoice due date if explicitly printed, YYYY-MM-DD.' },
    signaturePresent: { type: ['boolean', 'null'], description: 'For POD/BOL, whether a receiver/delivery signature is visibly present.' },
    uncertainFields: { type: 'array', items: { type: 'string' } },
    notes: { type: ['string', 'null'] },
  },
  required: [
    'documentType', 'invoiceNumber', 'referenceNumber', 'documentDate', 'clientName', 'debtorName',
    'debtorAddress', 'debtorCity', 'debtorState', 'debtorZip', 'debtorPhone', 'debtorEmail', 'debtorEin',
    'invoiceAmount', 'invoiceDate', 'dueDate', 'signaturePresent', 'uncertainFields', 'notes',
  ],
  additionalProperties: false,
};

const SYSTEM = `You extract structured facts from freight factoring paperwork.

The files may be carrier invoices, bills of lading (BOL), proofs of delivery (POD), rate confirmations/load tenders, or other freight paperwork.

Rules:
- Copy values from the document. Never invent a value.
- Use null when a field is not actually present or cannot be identified.
- invoiceDate means the date of an invoice only. For a BOL, POD, or rate confirmation, put that document's own date in documentDate and normally leave invoiceDate null.
- debtor means the party expected to pay the factored invoice. On an invoice this is normally Bill To / Customer. On a rate confirmation it is usually the broker. A shipper or consignee on a BOL/POD is not automatically the debtor.
- clientName is the carrier/seller performing the service.
- referenceNumber should be the best shared shipment/load identifier that could tie this file to the other paperwork.
- invoiceAmount is the invoice total on invoices and the agreed carrier rate on rate confirmations. Do not infer an amount from freight weights or unrelated totals.
- If text is blurry, handwritten, cut off, ambiguous, or internally conflicting, return your best reading but put the field name in uncertainFields and explain briefly in notes.
- Dates must be YYYY-MM-DD and monetary amounts plain numbers.
- Classification and extraction only. Do not decide whether the document should pass validation.`;

const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export function isSupportedFile(type: string): boolean {
  return type === 'application/pdf' || SUPPORTED_IMAGE_TYPES.includes(type);
}

let client: GoogleGenAI | null = null;
function gemini(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY || process.env.AI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');
  client ??= new GoogleGenAI({ apiKey });
  return client;
}

/** Pre-demo check: the key works and the reading model is available (a metadata call, nothing is read). */
export async function checkExtraction(): Promise<{ state: 'ok' | 'warn' | 'fail'; detail: string }> {
  if (!(process.env.GEMINI_API_KEY || process.env.AI_API_KEY)) {
    return (await demoRequest())
      ? { state: 'ok', detail: 'Demo data: uploads get canned readings, no key needed.' }
      : { state: 'warn', detail: 'GEMINI_API_KEY is not set, so uploads cannot be read.' };
  }
  try {
    await gemini().models.get({ model: PRIMARY_MODEL });
    return { state: 'ok', detail: `Key works; ${PRIMARY_MODEL} is available.` };
  } catch (err) {
    const refusal = readerRefusal(err);
    if (refusal === 'daily-limit') return { state: 'fail', detail: "The Gemini key has used up today's allowance, so uploads will fail until it resets. Raise the limit (billing) in Google AI Studio." };
    if (refusal) return { state: 'warn', detail: 'Gemini is busy or rate-limited right now. Run the check again in a minute.' };
    return { state: 'fail', detail: `Gemini refused the key or the model (${PRIMARY_MODEL}). Check GEMINI_API_KEY and EXTRACTION_MODEL.` };
  }
}

/** A busy or overloaded reader rather than a problem with the file: worth trying again. */
export function transientGeminiError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /\b(429|500|502|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|temporar/i.test(text);
}

/**
 * Why the reader refused: its daily allowance is used up (no point retrying today), too many
 * requests this minute, or Google's side is overloaded. Null for any other failure.
 */
export function readerRefusal(err: unknown): 'daily-limit' | 'rate-limit' | 'overloaded' | null {
  if (!transientGeminiError(err)) return null;
  const text = err instanceof Error ? err.message : String(err);
  if (/PerDay/i.test(text)) return 'daily-limit';
  if (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test(text)) return 'rate-limit';
  return 'overloaded';
}

/**
 * How long the reader asked us to wait before trying again, when it said so (Gemini puts a
 * `retryDelay` such as "7s" in its rate-limit errors).
 */
export function readerRetryAfterMs(err: unknown): number | null {
  const text = err instanceof Error ? err.message : String(err);
  const match = /retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/i.exec(text);
  return match ? Math.round(Number(match[1]) * 1000) : null;
}

function pricingFor(model: string): { input: number; output: number } | null {
  if (model === 'gemini-3.1-flash-lite') return { input: 0.25, output: 1.5 };
  if (model === 'gemini-3.5-flash-lite') return { input: 0.3, output: 2.5 };
  if (model === 'gemini-3.6-flash') return { input: 1.5, output: 7.5 };
  return null;
}

export async function extractDocument(file: File): Promise<{ fields: ExtractedFields; usage: ExtractionUsage }> {
  // Demo mode without an extraction key: canned fields, with a pause so the processing view plays.
  if ((await demoRequest()) && !(process.env.GEMINI_API_KEY || process.env.AI_API_KEY)) {
    await new Promise((resolve) => setTimeout(resolve, 1400 + Math.random() * 900));
    return demoExtraction(file.name, demoToday(), portalConfig.clientName, demoHeadlineDebtor());
  }
  const data = Buffer.from(await file.arrayBuffer()).toString('base64');
  const models = modelChain();
  let lastError: unknown = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      const response = await gemini().models.generateContent({
        model,
        contents: [
          { inlineData: { mimeType: file.type, data } },
          { text: `File name: ${file.name}\nExtract the document fields.` },
        ],
        config: {
          systemInstruction: SYSTEM,
          thinkingConfig: { thinkingLevel: configuredThinkingLevel() },
          responseMimeType: 'application/json',
          responseSchema: responseSchema as never,
        },
      });

      if (!response.text) throw new Error(`Gemini returned no extraction for ${file.name}.`);
      const parsed = ExtractionSchema.parse(JSON.parse(response.text));
      const fields: ExtractedFields = {
        ...parsed,
        invoiceAmount: normalizeMoney(parsed.invoiceAmount),
        documentDate: normalizeDate(parsed.documentDate) || parsed.documentDate,
        invoiceDate: normalizeDate(parsed.invoiceDate) || parsed.invoiceDate,
        dueDate: normalizeDate(parsed.dueDate) || parsed.dueDate,
      };

      const meta = response.usageMetadata;
      const inputTokens = meta?.promptTokenCount ?? 0;
      const outputTokens = meta?.candidatesTokenCount ?? 0;
      const thinkingTokens = meta?.thoughtsTokenCount ?? 0;
      const totalTokens = meta?.totalTokenCount ?? inputTokens + outputTokens + thinkingTokens;
      const pricing = pricingFor(model);
      const estimatedCostUsd = pricing
        ? (inputTokens / 1_000_000) * pricing.input + ((outputTokens + thinkingTokens) / 1_000_000) * pricing.output
        : null;

      return {
        fields,
        usage: { model, inputTokens, outputTokens, thinkingTokens, totalTokens, estimatedCostUsd },
      };
    } catch (err) {
      lastError = err;
      if (!transientGeminiError(err) || i === models.length - 1) throw err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Gemini could not read ${file.name}.`);
}
