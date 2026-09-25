'use client';

import { useId } from 'react';
import type { ActivityPoint, StatusMixItem } from '@/lib/dashboard';

const CHART_COLORS = ['#1779ba', '#2aa4df', '#6c63d9', '#2c9b70', '#f0a43c', '#d75d69', '#7b8794'];

export function ActivityTrendChart({
  points,
  valueLabel = 'Invoice amount',
}: {
  points: ActivityPoint[];
  valueLabel?: string;
}) {
  const gradientId = useId().replaceAll(':', '');
  const width = 760;
  const height = 260;
  const padX = 34;
  const padTop = 18;
  const padBottom = 42;
  const chartHeight = height - padTop - padBottom;
  const chartWidth = width - padX * 2;
  const max = Math.max(...points.map((point) => point.amount), 1);
  const coordinates = points.map((point, index) => ({
    ...point,
    x: padX + (points.length === 1 ? chartWidth / 2 : (index / Math.max(1, points.length - 1)) * chartWidth),
    y: padTop + chartHeight - (point.amount / max) * chartHeight,
  }));
  const linePath = coordinates.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const areaPath = coordinates.length
    ? `${linePath} L ${coordinates[coordinates.length - 1].x.toFixed(1)} ${(padTop + chartHeight).toFixed(1)} L ${coordinates[0].x.toFixed(1)} ${(padTop + chartHeight).toFixed(1)} Z`
    : '';

  if (!points.length) return <ChartEmpty title="No activity yet" detail="Invoice activity will appear here as data builds." />;

  return <div className="dashTrend">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${valueLabel} by week`}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2aa4df" stopOpacity=".28" />
          <stop offset="100%" stopColor="#2aa4df" stopOpacity=".02" />
        </linearGradient>
      </defs>
      {[0, .25, .5, .75, 1].map((fraction) => {
        const y = padTop + chartHeight * fraction;
        return <line key={fraction} x1={padX} x2={width - padX} y1={y} y2={y} className="dashGridLine" />;
      })}
      {areaPath && <path d={areaPath} fill={`url(#${gradientId})`} />}
      {linePath && <path d={linePath} className="dashTrendLine" />}
      {coordinates.map((point) => <g key={point.key}>
        <circle cx={point.x} cy={point.y} r="4.5" className="dashTrendPoint">
          <title>{`${point.label}: ${money(point.amount)} across ${point.count} invoice${point.count === 1 ? '' : 's'}`}</title>
        </circle>
        <text x={point.x} y={height - 14} textAnchor="middle" className="dashAxisLabel">{point.label}</text>
      </g>)}
    </svg>
  </div>;
}

export function StatusDonut({
  items,
  centerValue,
  centerLabel = 'Invoices',
}: {
  items: StatusMixItem[];
  centerValue?: string | number;
  centerLabel?: string;
}) {
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const displayItems = items.length <= CHART_COLORS.length
    ? items
    : [
        ...items.slice(0, CHART_COLORS.length - 1),
        {
          status: 'OTHER',
          label: 'Other',
          count: items.slice(CHART_COLORS.length - 1).reduce((sum, item) => sum + item.count, 0),
          amount: items.slice(CHART_COLORS.length - 1).reduce((sum, item) => sum + item.amount, 0),
        },
      ];
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  if (!total) return <ChartEmpty title="No statuses yet" detail="FactorCloud status distribution will appear here." />;

  return <div className="dashDonutLayout">
    <div className="dashDonut">
      <svg viewBox="0 0 150 150" role="img" aria-label="FactorCloud invoice status mix">
        <circle cx="75" cy="75" r={radius} className="dashDonutTrack" />
        {displayItems.map((item, index) => {
          const length = (item.count / total) * circumference;
          const circle = <circle
            key={item.status}
            cx="75"
            cy="75"
            r={radius}
            fill="none"
            stroke={CHART_COLORS[index]}
            strokeWidth="18"
            strokeDasharray={`${length} ${Math.max(0, circumference - length)}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 75 75)"
            className="dashDonutSegment"
          >
            <title>{`${item.label}: ${item.count} (${Math.round((item.count / total) * 100)}%)`}</title>
          </circle>;
          offset += length;
          return circle;
        })}
      </svg>
      <div className="dashDonutCenter"><strong>{centerValue ?? total}</strong><span>{centerLabel}</span></div>
    </div>
    <div className="dashLegend">
      {displayItems.map((item, index) => <div key={item.status}>
        <span className="dashLegendDot" style={{ background: CHART_COLORS[index] }} />
        <span>{item.label}</span>
        <strong>{item.count}</strong>
        <small>{Math.round((item.count / total) * 100)}%</small>
      </div>)}
    </div>
  </div>;
}

export function RankBars({
  items,
  formatter = money,
  emptyTitle = 'No ranking data yet',
}: {
  items: Array<{ id: string; label: string; value: number; detail?: string }>;
  formatter?: (value: number) => string;
  emptyTitle?: string;
}) {
  const max = Math.max(...items.map((item) => item.value), 1);
  if (!items.length) return <ChartEmpty title={emptyTitle} detail="This view will populate as activity builds." />;

  return <div className="dashRankBars">
    {items.map((item, index) => <div className="dashRankRow" key={item.id}>
      <div className="dashRankPosition">{index + 1}</div>
      <div className="dashRankBody">
        <div className="dashRankLabel"><strong>{item.label}</strong><span>{item.detail || ''}</span></div>
        <div className="dashRankTrack"><span style={{ width: `${Math.max(3, (item.value / max) * 100)}%` }} /></div>
      </div>
      <strong className="dashRankValue">{formatter(item.value)}</strong>
    </div>)}
  </div>;
}

export function ChartEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className="dashChartEmpty"><span className="dashChartEmptyIcon">↗</span><strong>{title}</strong><small>{detail}</small></div>;
}

export function money(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}
