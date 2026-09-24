import 'server-only';

import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { z } from 'zod';
import type { ExtractedFields } from './types';
import { normalizeDate, normalizeMoney } from './normalize';

const MODEL = process.env.EXTRACTION_MODEL || 'gemini-3.1-flash-lite';
const THINKING = process.env.EXTRACTION_THINKING || 'minimal';

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

export async function extractDocument(file: File): Promise<ExtractedFields> {
  const data = Buffer.from(await file.arrayBuffer()).toString('base64');
  const response = await gemini().models.generateContent({
    model: MODEL,
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
  return {
    ...parsed,
    invoiceAmount: normalizeMoney(parsed.invoiceAmount),
    documentDate: normalizeDate(parsed.documentDate) || parsed.documentDate,
    invoiceDate: normalizeDate(parsed.invoiceDate) || parsed.invoiceDate,
    dueDate: normalizeDate(parsed.dueDate) || parsed.dueDate,
  };
}
