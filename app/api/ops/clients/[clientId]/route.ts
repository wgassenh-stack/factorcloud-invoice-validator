import { NextResponse } from 'next/server';
import { getCompany, listInvoices } from '@/lib/factorcloud';
import { requireFactorSession } from '@/lib/portal-auth';
import { collectRiskInvoiceRecords, summarizeRisk, type RiskThresholds } from '@/lib/risk';
import { apiErrorResponse } from '@/lib/api-errors';
import { clientPosition } from '@/lib/client-position';
import { demoRequest } from '@/lib/demo-request';
import { demoFundingData, demoFundingSettings } from '@/lib/demo-funding';
import { laneOf, listRuns, loadSettings, type EngineRun } from '@/lib/funding-engine';
import { getCashReserveBalance, getClientCreditLimit } from '@/lib/funding-api';
import { settingsForClient, type RuleSettings } from '@/lib/rules/settings';
import { databaseAuthEnabled } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(_req: Request, context: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await context.params;
  if (!clientId) return NextResponse.json({ error: 'Client id is required.' }, { status: 400 });

  try {
    const session = await requireFactorSession();
    const demo = await demoRequest();
    const [list, client, creditLimit, cashReserve, automation] = await Promise.all([
      listInvoices({ client: clientId }), getCompany(clientId),
      demo ? Promise.resolve(null) : getClientCreditLimit(clientId).catch(() => undefined),
      demo ? Promise.resolve(null) : getCashReserveBalance(clientId).catch(() => undefined),
      automationFor(session.factorId, clientId, demo),
    ]);
    const allRecords = collectRiskInvoiceRecords(list.raw);
    const records = allRecords.filter((record) => record.companyClientId === clientId);
    const debtorIds = [...new Set(records.map((record) => record.companyDebtorId).filter((id): id is string => Boolean(id)))].slice(0, 50);
    const debtorEntries = await Promise.all(debtorIds.map(async (id) => {
      try { const debtor = await getCompany(id); return [id, debtor.companyName || debtor.compCode || id] as const; }
      catch { return [id, id] as const; }
    }));
    const debtorNames = Object.fromEntries(debtorEntries);

    const thresholds: RiskThresholds = {
      concentrationReview: percentEnv('RISK_CONCENTRATION_REVIEW_PCT', 30),
      concentrationHigh: percentEnv('RISK_CONCENTRATION_HIGH_PCT', 50),
      volumeSpikeRatio: numberEnv('RISK_VOLUME_SPIKE_RATIO', 1.5),
    };
    const summary = summarizeRisk(records, debtorNames, new Date().toISOString().slice(0, 10), thresholds);

    return NextResponse.json({
      client: {
        id: clientId,
        name: client.companyName || client.compCode || clientId,
        code: client.compCode || null,
        phone: client.phone || null,
        city: client.city || null,
        state: client.stateCode || null,
      },
      records,
      debtorNames,
      summary,
      position: clientPosition(records, new Date().toISOString().slice(0, 10)),
      creditLimit: creditLimit ?? null,
      creditLimitReadable: creditLimit !== undefined,
      cashReserve: cashReserve ?? null,
      automation: automation.policy,
      work: automation.work,
      source: {
        returnedInvoiceCount: allRecords.length,
        clientInvoiceCount: records.length,
        complete: list.complete,
        incompleteReason: list.incompleteReason ?? null,
        note: `${completenessNote(list)} Only invoices that positively match this FactorCloud client ID are included.`,
      },
    });
  } catch (err) {
    return apiErrorResponse(err, 'ops-client', 502);
  }
}

function percentEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  const pct = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  return pct / 100;
}

function numberEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function completenessNote(list: { complete: boolean; incompleteReason?: string; pages: number }): string {
  return list.complete
    ? `Includes every matching FactorCloud invoice (${list.pages} page${list.pages === 1 ? '' : 's'} read).`
    : `These figures may be incomplete: ${list.incompleteReason ?? 'FactorCloud\'s invoice list could not be read to the end.'}`;
}

type Policy = { mode: RuleSettings['mode']; paused: boolean; custom: boolean; perInvoice: number; perClientPerDay: number; rulesOff: string[] } | null;
const RULE_NAMES: Record<string, string> = { creditLimit: 'Debtor credit limit', clientCreditLimit: 'Client credit limit', slowDebtor: 'Debtor pays on time', newDebtor: 'Known debtor', concentration: 'Concentration', cashReserve: 'Cash reserve', volumeSpike: 'Volume spike', newClient: 'Established client' };

/** The automation rules that apply to this client, and its decisions still waiting on the factor. */
async function automationFor(factorId: string, clientId: string, demo: boolean): Promise<{ policy: Policy; work: { waiting: EngineRun[]; recent: EngineRun[] } | null }> {
  try {
    const settings = demo ? demoFundingSettings() : databaseAuthEnabled() ? await loadSettings(factorId) : null;
    if (!settings) return { policy: null, work: null };
    const effective = settingsForClient(settings, clientId);
    const policy = {
      mode: effective.mode, paused: settings.paused, custom: Boolean(settings.clientOverrides[clientId]),
      perInvoice: effective.caps.perInvoice, perClientPerDay: effective.caps.perClientPerDay,
      rulesOff: Object.entries(effective.rules).filter(([, r]) => !r.enabled).map(([k]) => RULE_NAMES[k] ?? k),
    };
    const runs = demo ? demoFundingData(null).runs.filter((r) => r.factorCloudClientId === clientId) : await listRuns(factorId, { clientId, limit: 100 });
    const waiting = runs.filter((r) => ['decision', 'suggestions', 'exceptions', 'review'].includes(laneOf(r))).slice(0, 20);
    const recent = runs.filter((r) => r.state === 'FUNDED').slice(0, 5);
    return { policy, work: { waiting, recent } };
  } catch (err) {
    console.error('[ops-client] automation', err);
    return { policy: null, work: null };
  }
}
