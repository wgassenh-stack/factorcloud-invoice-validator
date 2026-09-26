'use client';

import { useState } from 'react';
import { CountUp, compactMoney, money } from './CommandCharts';

/**
 * What the portal is worth to a factor, from its own volume and a few adjustable assumptions.
 * Everything here is an estimate; the assumptions are on screen so the math is never hidden.
 */
export function RoiPanel({ invoicesPerMonth, avgInvoice, flagRate, wide = false }: { invoicesPerMonth: number; avgInvoice: number; flagRate: number; wide?: boolean }) {
  const [volume, setVolume] = useState(Math.max(10, Math.round(invoicesPerMonth)));
  const [minutes, setMinutes] = useState(12);
  const [rate, setRate] = useState(38);
  const [daysFaster, setDaysFaster] = useState(1.5);

  const hours = (volume * minutes) / 60;
  const labor = hours * rate;
  const flagged = Math.round(volume * flagRate);
  // Cash reaches clients sooner: value of that time at a 12% annual cost of capital.
  const acceleration = volume * avgInvoice * 0.9 * (daysFaster / 365) * 0.12;
  const annual = (labor + acceleration) * 12;

  return <div className={`roiPanel ${wide ? 'wide' : ''}`}>
    <div className="roiHero">
      <span>Estimated annual value</span>
      <strong><CountUp value={annual} format={(v) => money(v)} /></strong>
      <small>{compactMoney(labor)} staff time + {compactMoney(acceleration)} faster funding, per month</small>
    </div>
    <div className="roiStats">
      <div><strong><CountUp value={hours} format={(v) => v.toFixed(0)} /></strong><span>staff hours saved / month</span></div>
      <div><strong><CountUp value={flagged} /></strong><span>packets flagged before funding / month</span></div>
      <div><strong>{daysFaster.toFixed(1)}d</strong><span>sooner from submit to funded</span></div>
    </div>
    <div className="roiInputs">
      <Slider label="Invoices per month" value={volume} min={10} max={Math.max(2000, volume * 2)} step={10} onChange={setVolume} display={volume.toLocaleString('en-US')} />
      <Slider label="Minutes saved per invoice" value={minutes} min={2} max={30} step={1} onChange={setMinutes} display={`${minutes} min`} />
      <Slider label="Loaded staff cost" value={rate} min={18} max={80} step={1} onChange={setRate} display={`$${rate}/hr`} />
      <Slider label="Days faster to fund" value={daysFaster} min={0} max={4} step={0.5} onChange={setDaysFaster} display={`${daysFaster.toFixed(1)} days`} />
    </div>
    <p className="roiNote">Estimates. Monthly volume comes from your data; the other inputs are adjustable assumptions (7% of packets flagged, 12% cost of capital).</p>
  </div>;
}

function Slider({ label, value, min, max, step, onChange, display }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; display: string }) {
  const pct = ((value - min) / (max - min)) * 100;
  return <label className="roiSlider">
    <span><em>{label}</em><b>{display}</b></span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ '--pct': `${pct}%` } as React.CSSProperties} />
  </label>;
}
