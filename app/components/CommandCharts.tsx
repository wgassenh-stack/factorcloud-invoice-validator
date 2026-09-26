'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgingSummary, DayVolume, DsoPoint, ExposureItem, MonthlyCash } from '@/lib/analytics';

// Palette validated with the dataviz validator (light surface #fcfcfb): categorical blue/orange,
// an ordinal blue ramp for aging, a single-hue sequential ramp for magnitude, and status colors
// kept for real status only (always with an icon and a label).
export const VIZ = {
  blue: '#2a78d6',
  orange: '#eb6834',
  aging: ['#86b6ef', '#3987e5', '#1c5cab', '#0d366b'],
  seq: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#1c5cab', '#0d366b'],
  empty: '#ecebe5',
  grid: '#e1e0d9',
  baseline: '#c3c2b7',
  ink: '#0b0b0b',
  secondary: '#52514e',
  muted: '#898781',
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
};

export function money(value: number, digits = 0): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}

export function compactMoney(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}K`;
  return `$${Math.round(value)}`;
}

// --- motion helpers ------------------------------------------------------------------------------

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** A number that counts up to its value when it first appears (instant with reduced motion). */
export function CountUp({ value, format = (v: number) => Math.round(v).toLocaleString('en-US'), duration = 900 }: { value: number; format?: (value: number) => string; duration?: number }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    if (prefersReducedMotion()) { setShown(value); from.current = value; return; }
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(origin + (value - origin) * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
      else from.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);
  return <span className="vizCountUp">{format(shown)}</span>;
}

// --- tooltip -------------------------------------------------------------------------------------

type TipState = { x: number; y: number; content: ReactNode } | null;

function useTooltip(fallbackWidth = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<TipState>(null);
  // Charts draw at the container's real pixel width so text stays a readable size at any width.
  const [width, setWidth] = useState(fallbackWidth);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(260, Math.round(entry.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const show = useCallback((event: React.MouseEvent | React.FocusEvent, content: ReactNode) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    let x: number;
    let y: number;
    if ('clientX' in event) { x = event.clientX - box.left; y = event.clientY - box.top; }
    else {
      const target = (event.target as Element).getBoundingClientRect();
      x = target.left + target.width / 2 - box.left;
      y = target.top - box.top;
    }
    setTip({ x, y, content });
  }, []);
  const hide = useCallback(() => setTip(null), []);
  const node = tip ? <div className="vizTooltip" role="status" style={{ left: tip.x, top: tip.y }}>{tip.content}</div> : null;
  return { ref, show, hide, node, width };
}

function TipRow({ color, label, value }: { color?: string; label: string; value: string }) {
  return <div className="vizTipRow">{color && <i style={{ background: color }} />}<span>{label}</span><strong>{value}</strong></div>;
}

// --- legend & table ------------------------------------------------------------------------------

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return <div className="vizLegend">{items.map((item) => <span key={item.label}><i style={{ background: item.color }} />{item.label}</span>)}</div>;
}

export function ChartTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  return <details className="vizTable">
    <summary>View as table</summary>
    <div className="vizTableWrap"><table>
      <caption>{caption}</caption>
      <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
    </table></div>
  </details>;
}

export function StatusFlag({ level, children }: { level: 'REVIEW' | 'HIGH' | 'GOOD'; children: ReactNode }) {
  const icon = level === 'HIGH' ? '▲' : level === 'REVIEW' ? '!' : '✓';
  return <span className={`vizFlag ${level.toLowerCase()}`}><b aria-hidden="true">{icon}</b>{children}</span>;
}

// --- aging ---------------------------------------------------------------------------------------

export function AgingBars({ aging }: { aging: AgingSummary }) {
  const tip = useTooltip();
  const max = Math.max(...aging.rows.map((row) => row.total), 1);
  if (!aging.rows.length) return <VizEmpty title="No open balances" detail="Funded invoices that are still unpaid will be aged here." />;
  const pct = (value: number) => aging.openBalance > 0 ? `${Math.round((value / aging.openBalance) * 100)}%` : '0%';

  return <div className="vizAging" ref={tip.ref} onMouseLeave={tip.hide}>
    <div className="vizAgingTotals">
      {aging.buckets.map((bucket, i) => <div key={bucket} className="vizAgingTotal">
        <span><i style={{ background: VIZ.aging[i] }} />{bucket}</span>
        <strong>{compactMoney(aging.totals[i])}</strong>
        <small>{pct(aging.totals[i])} of open A/R</small>
      </div>)}
    </div>
    <div className="vizAgingRows">
      {aging.rows.map((row, rowIndex) => <div className="vizAgingRow" key={row.key}>
        <span className="vizAgingLabel" title={row.label}>{row.label}</span>
        <div className="vizAgingTrack" style={{ width: `${Math.max(4, (row.total / max) * 100)}%` }}>
          {row.buckets.map((value, i) => value > 0 && <span
            key={i}
            tabIndex={0}
            className="vizAgingSeg"
            style={{ flexGrow: value, background: VIZ.aging[i], animationDelay: `${rowIndex * 60}ms` }}
            onMouseMove={(e) => tip.show(e, <><strong>{row.label}</strong><TipRow color={VIZ.aging[i]} label={aging.buckets[i]} value={money(value)} /><TipRow label="Share of this row" value={`${Math.round((value / row.total) * 100)}%`} /></>)}
            onFocus={(e) => tip.show(e, <><strong>{row.label}</strong><TipRow color={VIZ.aging[i]} label={aging.buckets[i]} value={money(value)} /></>)}
            onBlur={tip.hide}
          />)}
        </div>
        <strong className="vizAgingValue">{compactMoney(row.total)}</strong>
      </div>)}
    </div>
    {tip.node}
    <ChartTable caption="Open balance by age" head={['Group', ...aging.buckets, 'Total']} rows={aging.rows.map((row) => [row.label, ...row.buckets.map((v) => money(v)), money(row.total)])} />
  </div>;
}

// --- treemap -------------------------------------------------------------------------------------

type Rect = { x: number; y: number; w: number; h: number };

/** Squarified treemap layout (Bruls et al.) over values sorted descending. */
function squarify<T extends { value: number }>(items: T[], rect: Rect): (T & Rect)[] {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!items.length || total <= 0) return [];
  const scale = (rect.w * rect.h) / total;
  const nodes = items.map((item) => ({ item, area: item.value * scale }));
  const out: (T & Rect)[] = [];
  let free = { ...rect };
  let row: typeof nodes = [];

  const worst = (r: typeof nodes, side: number) => {
    const s = r.reduce((a, n) => a + n.area, 0);
    const max = Math.max(...r.map((n) => n.area));
    const min = Math.min(...r.map((n) => n.area));
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  const layoutRow = (r: typeof nodes) => {
    const s = r.reduce((a, n) => a + n.area, 0);
    if (free.w >= free.h) {
      const w = s / free.h;
      let y = free.y;
      for (const n of r) { const h = n.area / w; out.push({ ...n.item, x: free.x, y, w, h }); y += h; }
      free = { x: free.x + w, y: free.y, w: free.w - w, h: free.h };
    } else {
      const h = s / free.w;
      let x = free.x;
      for (const n of r) { const w = n.area / h; out.push({ ...n.item, x, y: free.y, w, h }); x += w; }
      free = { x: free.x, y: free.y + h, w: free.w, h: free.h - h };
    }
  };

  for (const node of nodes) {
    const side = Math.min(free.w, free.h);
    if (!row.length || worst([...row, node], side) <= worst(row, side)) row.push(node);
    else { layoutRow(row); row = [node]; }
  }
  if (row.length) layoutRow(row);
  return out;
}

export function ExposureTreemap({ items, noun = 'client', hrefFor }: { items: ExposureItem[]; noun?: string; hrefFor?: (id: string) => string }) {
  const tip = useTooltip();
  const width = tip.width;
  const height = Math.round(Math.min(340, Math.max(240, width * 0.62)));
  const shown = useMemo(() => {
    const top = items.slice(0, 14);
    const rest = items.slice(14);
    if (rest.length) top.push({ id: 'other', name: `Other (${rest.length})`, value: rest.reduce((s, i) => s + i.value, 0), share: rest.reduce((s, i) => s + i.share, 0), invoiceCount: rest.reduce((s, i) => s + i.invoiceCount, 0), level: 'NORMAL' });
    return top;
  }, [items]);
  const tiles = useMemo(() => squarify(shown, { x: 0, y: 0, w: width, h: height }), [shown, width, height]);
  if (!tiles.length) return <VizEmpty title="No open exposure" detail={`Open balances by ${noun} will appear here.`} />;
  const maxShare = Math.max(...shown.map((i) => i.share), 0.0001);
  const fillFor = (share: number, id: string) => id === 'other' ? '#d9d8d1' : VIZ.seq[Math.min(VIZ.seq.length - 1, Math.floor((share / maxShare) * (VIZ.seq.length - 0.01)))];
  const darkText = (fill: string) => ['#cde2fb', '#9ec5f4', '#d9d8d1'].includes(fill);
  const flagged = shown.filter((i) => i.level !== 'NORMAL');

  return <div className="vizTreemap" ref={tip.ref} onMouseLeave={tip.hide}>
    {flagged.length > 0 && <div className="vizTreemapFlags">{flagged.map((item) => <StatusFlag key={item.id} level={item.level as 'REVIEW' | 'HIGH'}>{item.name} holds {Math.round(item.share * 100)}% of open A/R</StatusFlag>)}</div>}
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Open balance by ${noun}`}>
      {tiles.map((tile, i) => {
        const fill = fillFor(tile.share, tile.id);
        const text = darkText(fill) ? VIZ.ink : '#ffffff';
        const big = tile.w > 90 && tile.h > 46;
        const content = <><strong>{tile.name}</strong><TipRow label="Open balance" value={money(tile.value)} /><TipRow label="Share" value={`${(tile.share * 100).toFixed(1)}%`} /><TipRow label="Open invoices" value={String(tile.invoiceCount)} />{tile.level !== 'NORMAL' && <StatusFlag level={tile.level as 'REVIEW' | 'HIGH'}>{tile.level === 'HIGH' ? 'High concentration' : 'Concentration to review'}</StatusFlag>}</>;
        const inner = <g className="vizTile" style={{ animationDelay: `${i * 35}ms` }} tabIndex={0} onMouseMove={(e) => tip.show(e, content)} onFocus={(e) => tip.show(e, content)} onBlur={tip.hide}>
          <rect x={tile.x + 1} y={tile.y + 1} width={Math.max(0, tile.w - 2)} height={Math.max(0, tile.h - 2)} rx={4} fill={fill} />
          {tile.level !== 'NORMAL' && <rect x={tile.x + 3} y={tile.y + 3} width={Math.max(0, tile.w - 6)} height={Math.max(0, tile.h - 6)} rx={3} fill="none" stroke={tile.level === 'HIGH' ? VIZ.critical : VIZ.warning} strokeWidth={2.5} />}
          {big && <>
            <text x={tile.x + 10} y={tile.y + 22} fill={text} className="vizTileName">{clip(tile.name, Math.floor((tile.w - 14) / 7.4))}</text>
            <text x={tile.x + 10} y={tile.y + 40} fill={text} className="vizTileValue">{compactMoney(tile.value)} · {Math.round(tile.share * 100)}%</text>
          </>}
          {!big && tile.w > 40 && tile.h > 22 && <text x={tile.x + 6} y={tile.y + 16} fill={text} className="vizTileValue">{Math.round(tile.share * 100)}%</text>}
        </g>;
        return hrefFor && tile.id !== 'other' ? <a key={tile.id} href={hrefFor(tile.id)}>{inner}</a> : <g key={tile.id}>{inner}</g>;
      })}
    </svg>
    {tip.node}
    <div className="vizScale"><span>Smaller share</span>{VIZ.seq.map((c) => <i key={c} style={{ background: c }} />)}<span>Larger share</span></div>
    <ChartTable caption={`Open balance by ${noun}`} head={[noun[0].toUpperCase() + noun.slice(1), 'Open balance', 'Share', 'Open invoices']} rows={items.map((i) => [i.name, money(i.value), `${(i.share * 100).toFixed(1)}%`, i.invoiceCount])} />
  </div>;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

// --- cash in vs out ------------------------------------------------------------------------------

export function CashFlowBars({ months }: { months: MonthlyCash[] }) {
  const tip = useTooltip();
  const width = tip.width;
  const height = 280;
  const pad = { l: 54, r: 12, t: 16, b: 34 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const max = niceMax(Math.max(...months.flatMap((m) => [m.advanced, m.collected]), 1));
  const band = innerW / Math.max(1, months.length);
  const barW = Math.max(3, Math.min(18, (band - 8) / 2));
  const y = (v: number) => pad.t + innerH - (v / max) * innerH;
  const [active, setActive] = useState<number | null>(null);
  if (!months.some((m) => m.advanced || m.collected)) return <VizEmpty title="No cash movement yet" detail="Advances and collections will chart here once invoices are funded." />;

  return <div className="vizCash" ref={tip.ref} onMouseLeave={() => { tip.hide(); setActive(null); }}>
    <Legend items={[{ label: 'Advanced to clients', color: VIZ.blue }, { label: 'Collected from debtors', color: VIZ.orange }]} />
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Cash advanced and collected by month">
      {[0, 0.25, 0.5, 0.75, 1].map((f) => <g key={f}>
        <line x1={pad.l} x2={width - pad.r} y1={y(max * f)} y2={y(max * f)} stroke={f === 0 ? VIZ.baseline : VIZ.grid} strokeWidth={1} />
        <text x={pad.l - 8} y={y(max * f) + 4} textAnchor="end" className="vizAxis">{compactMoney(max * f)}</text>
      </g>)}
      {months.map((m, i) => {
        const cx = pad.l + band * i + band / 2;
        const content = <><strong>{new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m.key}-01T00:00:00Z`))}</strong><TipRow color={VIZ.blue} label="Advanced" value={money(m.advanced)} /><TipRow color={VIZ.orange} label="Collected" value={money(m.collected)} /><TipRow label="Fees earned" value={money(m.fees)} /><TipRow label="Net" value={money(m.collected - m.advanced)} /></>;
        return <g key={m.key} onMouseMove={(e) => { setActive(i); tip.show(e, content); }} onFocus={(e) => { setActive(i); tip.show(e, content); }} onBlur={() => { tip.hide(); setActive(null); }} tabIndex={0} className="vizCashGroup">
          <rect x={pad.l + band * i} y={pad.t} width={band} height={innerH} fill={active === i ? 'rgba(42,120,214,.06)' : 'transparent'} />
          <Bar x={cx - barW - 1} y={y(m.advanced)} w={barW} h={pad.t + innerH - y(m.advanced)} fill={VIZ.blue} delay={i * 40} />
          <Bar x={cx + 1} y={y(m.collected)} w={barW} h={pad.t + innerH - y(m.collected)} fill={VIZ.orange} delay={i * 40 + 20} />
          {(band >= 34 || i % 2 === (months.length - 1) % 2) && <text x={cx} y={height - 12} textAnchor="middle" className="vizAxis">{m.label}</text>}
        </g>;
      })}
    </svg>
    {tip.node}
    <ChartTable caption="Cash by month" head={['Month', 'Advanced', 'Collected', 'Fees']} rows={months.map((m) => [m.key, money(m.advanced), money(m.collected), money(m.fees)])} />
  </div>;
}

/** A vertical bar with a 4px rounded top anchored square to the baseline. */
function Bar({ x, y, w, h, fill, delay = 0 }: { x: number; y: number; w: number; h: number; fill: string; delay?: number }) {
  if (h <= 0) return null;
  const r = Math.min(4, w / 2, h);
  const d = `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
  return <path d={d} fill={fill} className="vizBar" style={{ animationDelay: `${delay}ms`, transformOrigin: `${x}px ${y + h}px` }} />;
}

function niceMax(value: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  const n = value / exp;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * exp;
}

// --- DSO -----------------------------------------------------------------------------------------

export function DsoLine({ points, target }: { points: DsoPoint[]; target?: number }) {
  const tip = useTooltip();
  const [hover, setHover] = useState<number | null>(null);
  const width = tip.width;
  const height = 250;
  const pad = { l: 40, r: 56, t: 18, b: 34 };
  const valued = points.filter((p) => p.days != null) as (DsoPoint & { days: number })[];
  if (valued.length < 2) return <VizEmpty title="Not enough payments yet" detail="Days to collect will trend here after a couple of months of payments." />;
  const lo = Math.max(0, Math.floor((Math.min(...valued.map((p) => p.days), target ?? Infinity) - 5) / 5) * 5);
  const hi = Math.ceil((Math.max(...valued.map((p) => p.days), target ?? 0) + 5) / 5) * 5;
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const x = (i: number) => pad.l + (i / Math.max(1, points.length - 1)) * innerW;
  const y = (v: number) => pad.t + innerH - ((v - lo) / (hi - lo)) * innerH;
  const coords = points.map((p, i) => p.days == null ? null : { ...p, cx: x(i), cy: y(p.days) });
  const path = coords.reduce((d, c, i) => c ? `${d}${d && coords[i - 1] ? 'L' : 'M'}${c.cx.toFixed(1)},${c.cy.toFixed(1)}` : d, '');
  const last = [...coords].reverse().find(Boolean)!;
  const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) / 4) * i);

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    const index = Math.round(((px - pad.l) / innerW) * (points.length - 1));
    const clamped = Math.max(0, Math.min(points.length - 1, index));
    setHover(clamped);
    const p = points[clamped];
    tip.show(event, <><strong>{new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${p.key}-01T00:00:00Z`))}</strong><TipRow color={VIZ.blue} label="Days to collect" value={p.days == null ? 'No payments' : `${p.days.toFixed(1)} days`} /><TipRow label="Invoices paid" value={String(p.paidCount)} /></>);
  };

  return <div className="vizDso" ref={tip.ref}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Average days to collect by month" onMouseMove={onMove} onMouseLeave={() => { setHover(null); tip.hide(); }}>
      {ticks.map((t) => <g key={t}>
        <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke={t === lo ? VIZ.baseline : VIZ.grid} />
        <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="vizAxis">{Math.round(t)}</text>
      </g>)}
      {target != null && <g><line x1={pad.l} x2={width - pad.r} y1={y(target)} y2={y(target)} stroke={VIZ.muted} strokeDasharray="4 4" /><text x={pad.l + 6} y={y(target) - 6} className="vizAxis">Target {target} days</text></g>}
      <path d={path} fill="none" stroke={VIZ.blue} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="vizLine" />
      {hover != null && coords[hover] && <g>
        <line x1={coords[hover]!.cx} x2={coords[hover]!.cx} y1={pad.t} y2={pad.t + innerH} stroke={VIZ.muted} strokeWidth={1} />
        <circle cx={coords[hover]!.cx} cy={coords[hover]!.cy} r={5} fill={VIZ.blue} stroke="#fcfcfb" strokeWidth={2} />
      </g>}
      <circle cx={last.cx} cy={last.cy} r={4.5} fill={VIZ.blue} stroke="#fcfcfb" strokeWidth={2} />
      <text x={last.cx + 9} y={last.cy + 4} className="vizDirectLabel">{last.days!.toFixed(0)}d</text>
      {points.map((p, i) => (width > 520 || i % 2 === points.length % 2) && <text key={p.key} x={x(i)} y={height - 12} textAnchor="middle" className="vizAxis">{p.label}</text>)}
    </svg>
    {tip.node}
    <ChartTable caption="Average days to collect" head={['Month', 'Days', 'Invoices paid']} rows={points.map((p) => [p.key, p.days == null ? '-' : p.days.toFixed(1), p.paidCount])} />
  </div>;
}

// --- calendar heatmap ----------------------------------------------------------------------------

export function CalendarHeatmap({ days, metric = 'count' }: { days: DayVolume[]; metric?: 'count' | 'amount' }) {
  const tip = useTooltip();
  const gap = 3;
  const weeks = Math.ceil(days.length / 7);
  const labelW = 28;
  const cell = Math.max(8, Math.min(18, Math.floor((tip.width - labelW) / weeks) - gap));
  const width = labelW + weeks * (cell + gap);
  const height = 18 + 7 * (cell + gap);
  const values = days.map((d) => d[metric]);
  const nonzero = values.filter((v) => v > 0).sort((a, b) => a - b);
  // Quantile steps so one busy day doesn't wash out the rest.
  const cuts = [0.2, 0.4, 0.6, 0.8, 0.95].map((q) => nonzero[Math.floor(q * (nonzero.length - 1))] ?? 0);
  const step = (v: number) => v <= 0 ? -1 : cuts.findIndex((c) => v <= c) === -1 ? VIZ.seq.length - 1 : cuts.findIndex((c) => v <= c);
  const total = values.reduce((a, b) => a + b, 0);
  const busiest = days.reduce((best, d) => d[metric] > best[metric] ? d : best, days[0]);
  const monthLabels = days.filter((d, i) => i % 7 === 0 && Number(d.date.slice(8)) <= 7);
  if (!days.length) return null;

  return <div className="vizCalendar" ref={tip.ref} onMouseLeave={tip.hide}>
    <div className="vizCalendarScroll">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label="Invoices submitted per day">
        {monthLabels.map((d) => {
          const index = days.indexOf(d);
          return <text key={d.date} x={labelW + Math.floor(index / 7) * (cell + gap)} y={10} className="vizAxis">{new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(new Date(`${d.date}T00:00:00Z`))}</text>;
        })}
        {['Mon', '', 'Wed', '', 'Fri', '', ''].map((label, i) => label && <text key={label} x={0} y={18 + i * (cell + gap) + cell - 2} className="vizAxis">{label}</text>)}
        {days.map((d, i) => {
          const s = step(d[metric]);
          const content = <><strong>{new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d.date}T00:00:00Z`))}</strong><TipRow label="Invoices" value={String(d.count)} /><TipRow label="Amount" value={money(d.amount)} /></>;
          return <rect key={d.date} className="vizDay" style={{ animationDelay: `${Math.floor(i / 7) * 14}ms` }} tabIndex={0} x={labelW + Math.floor(i / 7) * (cell + gap)} y={18 + (i % 7) * (cell + gap)} width={cell} height={cell} rx={3} fill={s < 0 ? VIZ.empty : VIZ.seq[s]} onMouseMove={(e) => tip.show(e, content)} onFocus={(e) => tip.show(e, content)} onBlur={tip.hide} />;
        })}
      </svg>
    </div>
    <div className="vizCalendarFoot">
      <span>{metric === 'count' ? `${total.toLocaleString('en-US')} invoices` : money(total)} in {weeks} weeks · busiest {busiest ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${busiest.date}T00:00:00Z`)) : '-'}</span>
      <div className="vizScale"><span>Less</span><i style={{ background: VIZ.empty }} />{VIZ.seq.map((c) => <i key={c} style={{ background: c }} />)}<span>More</span></div>
    </div>
    {tip.node}
  </div>;
}

// --- lifecycle -----------------------------------------------------------------------------------

export function LifecyclePipeline({ stages }: { stages: { stage: string; label: string; count: number; amount: number }[] }) {
  const tip = useTooltip();
  const total = stages.reduce((sum, s) => sum + s.amount, 0) || 1;
  const colors = [VIZ.seq[1], VIZ.seq[2], VIZ.seq[3], VIZ.seq[5]];
  return <div className="vizPipeline" ref={tip.ref} onMouseLeave={tip.hide}>
    <div className="vizPipelineBar">
      {stages.map((s, i) => s.amount > 0 && <span key={s.stage} tabIndex={0} style={{ flexGrow: s.amount, background: colors[i], animationDelay: `${i * 90}ms` }}
        onMouseMove={(e) => tip.show(e, <><strong>{s.label}</strong><TipRow color={colors[i]} label="Invoices" value={String(s.count)} /><TipRow label="Amount" value={money(s.amount)} /></>)} />)}
    </div>
    <ol className="vizStages">
      {stages.map((s, i) => <li key={s.stage}>
        <span className="vizStageDot" style={{ background: colors[i] }}>{i + 1}</span>
        <div><strong>{s.label}</strong><small>{s.count} invoice{s.count === 1 ? '' : 's'}</small></div>
        <b>{compactMoney(s.amount)}</b>
        <em>{Math.round((s.amount / total) * 100)}%</em>
      </li>)}
    </ol>
    {tip.node}
  </div>;
}

/** Where one invoice is on Submitted → Verified → Funded → Paid, with dates where known. */
export function InvoiceTracker({ stage, dates }: { stage: 'SUBMITTED' | 'VERIFIED' | 'FUNDED' | 'PAID'; dates: Partial<Record<'SUBMITTED' | 'VERIFIED' | 'FUNDED' | 'PAID', string | null>> }) {
  const order = ['SUBMITTED', 'VERIFIED', 'FUNDED', 'PAID'] as const;
  const labels = { SUBMITTED: 'Submitted', VERIFIED: 'Verified', FUNDED: 'Funded', PAID: 'Paid' };
  const reached = order.indexOf(stage);
  return <ol className="vizTracker" aria-label={`Invoice is ${labels[stage].toLowerCase()}`}>
    {order.map((key, i) => <li key={key} className={i < reached ? 'done' : i === reached ? 'current' : ''} style={{ animationDelay: `${i * 140}ms` }}>
      <span className="vizTrackerDot" aria-hidden="true">{i <= reached ? '✓' : ''}</span>
      <strong>{labels[key]}</strong>
      <small>{dates[key] ? shortDate(dates[key]!) : i <= reached ? 'Done' : 'Pending'}</small>
    </li>)}
  </ol>;
}

function shortDate(value: string): string {
  const d = new Date(value.length <= 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d) : value;
}

// --- empty & skeleton ----------------------------------------------------------------------------

export function VizEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className="vizEmpty">
    <svg viewBox="0 0 64 40" aria-hidden="true"><rect x="4" y="22" width="10" height="14" rx="2" /><rect x="20" y="14" width="10" height="22" rx="2" /><rect x="36" y="18" width="10" height="18" rx="2" /><rect x="52" y="8" width="10" height="28" rx="2" /></svg>
    <strong>{title}</strong>
    <small>{detail}</small>
  </div>;
}

export function Skeleton({ height = 160, lines = 0 }: { height?: number; lines?: number }) {
  return <div className="vizSkeleton" aria-hidden="true">
    <div className="vizSkeletonBlock" style={{ height }} />
    {Array.from({ length: lines }, (_, i) => <div key={i} className="vizSkeletonLine" style={{ width: `${88 - i * 14}%` }} />)}
  </div>;
}

export function DashboardSkeleton({ metrics = 5 }: { metrics?: number }) {
  return <div className="vizDashSkeleton" aria-label="Loading dashboard">
    <div className="vizSkeletonMetrics">{Array.from({ length: metrics }, (_, i) => <div key={i} className="vizSkeletonCard"><div className="vizSkeletonLine" style={{ width: '40%' }} /><div className="vizSkeletonLine big" style={{ width: '70%' }} /><div className="vizSkeletonLine" style={{ width: '55%' }} /></div>)}</div>
    <div className="vizSkeletonGrid"><div className="vizSkeletonCard tall"><Skeleton height={220} /></div><div className="vizSkeletonCard tall"><Skeleton height={220} /></div></div>
  </div>;
}
