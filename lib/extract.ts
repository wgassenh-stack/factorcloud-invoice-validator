import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { ExtractedFields } from './types';
import { normalizeDate, normalizeMoney } from './normalize';

// AI is used only to read documents into structured fields. All matching and
// PASS/REVIEW/FAIL decisions are deterministic code in lib/rules.ts.

const MODEL = process.env.EXTRACTION_MODEL || 'claude-opus-5';

const ExtractionSchema = z.object({
  documentType: z
    .enum(['invoice', 'bol', 'pod', 'rate_confirmation', 'other'])
    .describe('invoice = freight/carrier invoice; bol = bill of lading; pod = proof of delivery / delivery receipt; rate_confirmation = broker rate confirmation or load tender'),
  invoiceNumber: z.string().nullable().describe('Invoice number exactly as printed'),
  referenceNumber: z.string().nullable().describe('Load number, PRO number, shipment or reference number that ties the paperwork together'),
  clientName: z.string().nullable().describe('The company that issued the invoice / performed the work (the carrier or seller)'),
  debtorName: z.string().nullable().describe('The company being billed / that pays (bill-to, customer, broker or shipper paying the freight)'),
  debtorAddress: z.string().nullable().describe('Debtor street address line(s), without city/state/ZIP'),
  debtorCity: z.string().nullable(),
  debtorState: z.string().nullable().describe('Two-letter state code when possible'),
  debtorZip: z.string().nullable(),
  debtorPhone: z.string().nullable(),
  debtorEmail: z.string().nullable(),
  debtorEin: z.string().nullable(),
  invoiceAmount: z.number().nullable().describe('Total amount due in US dollars (for a rate confirmation: the total agreed rate)'),
  invoiceDate: z.string().nullable().describe('Invoice date (or document date) as YYYY-MM-DD'),
  dueDate: z.string().nullable().describe('Due date as YYYY-MM-DD if printed'),
  signaturePresent: z.boolean().nullable().describe('For BOL/POD: true if a receiver signature is visible'),
  uncertainFields: z.array(z.string()).describe('Names of fields above you could not read confidently (blurry, handwritten, ambiguous, conflicting)'),
  notes: z.string().nullable().describe('Brief note on anything a reviewer should know, e.g. which of two addresses was used'),
});

const SYSTEM = `You extract data from freight factoring paperwork (invoices, bills of lading, proofs of delivery, rate confirmations) for an invoice intake system.

Read the document and fill every field you can find. Rules:
- Copy values as printed; do not guess or invent. Use null for anything not on the document.
- The debtor is the party being billed (bill-to / customer), not the company issuing the invoice. On a rate confirmation the debtor is usually the broker.
- If a value is hard to read, handwritten, cut off, or the document shows conflicting values, still give your best reading but list the field name in uncertainFields and explain briefly in notes.
- Dates must be YYYY-MM-DD. Amounts are plain numbers without currency symbols.`;

const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
type ImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

export function isSupportedFile(type: string): boolean {
  return type === 'application/pdf' || (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(type);
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured.');
  client ??= new Anthropic({ apiKey });
  return client;
}

export async function extractDocument(file: File): Promise<ExtractedFields> {
  const data = Buffer.from(await file.arrayBuffer()).toString('base64');
  const source: Anthropic.Beta.BetaContentBlockParam =
    file.type === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: file.type as ImageType, data } };

  const response = await anthropic().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: [source, { type: 'text', text: `File name: ${file.name}\nExtract the fields.` }],
      },
    ],
    output_config: { format: betaZodOutputFormat(ExtractionSchema) },
  });

  if (response.stop_reason === 'refusal') throw new Error(`The model declined to read ${file.name}.`);
  if (response.stop_reason === 'max_tokens') throw new Error(`Extraction of ${file.name} was cut off.`);
  const parsed = response.parsed_output;
  if (!parsed) throw new Error(`Could not parse extraction output for ${file.name}.`);

  // Canonicalize the formats the rules engine relies on.
  return {
    ...parsed,
    invoiceAmount: normalizeMoney(parsed.invoiceAmount),
    invoiceDate: normalizeDate(parsed.invoiceDate) || parsed.invoiceDate,
    dueDate: normalizeDate(parsed.dueDate) || parsed.dueDate,
  };
}
