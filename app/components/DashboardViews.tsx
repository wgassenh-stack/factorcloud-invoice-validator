'use client';

import { useEffect, useMemo, useState } from 'react';

export interface DashboardPreset {
  id: string;
  label: string;
  description: string;
  widgets: string[];
}

export interface DashboardWidgetOption {
  id: string;
  label: string;
  description: string;
}

interface SavedDashboardView extends DashboardPreset {
  custom: true;
}

interface StoredDashboardViews {
  activeId?: string;
  saved?: SavedDashboardView[];
}

export function DashboardViewSwitcher({
  storageKey,
  presets,
  widgets,
  onWidgetsChange,
}: {
  storageKey: string;
  presets: DashboardPreset[];
  widgets: DashboardWidgetOption[];
  onWidgetsChange: (widgets: string[]) => void;
}) {
  const [saved, setSaved] = useState<SavedDashboardView[]>([]);
  const [activeId, setActiveId] = useState(presets[0]?.id || '');
  const [builderOpen, setBuilderOpen] = useState(false);
  const [draftWidgets, setDraftWidgets] = useState<string[]>(presets[0]?.widgets || []);
  const [draftName, setDraftName] = useState('');
  const [baseViewId, setBaseViewId] = useState(presets[0]?.id || '');

  const allViews = useMemo(() => [...presets, ...saved], [presets, saved]);

  useEffect(() => {
    let stored: StoredDashboardViews = {};
    try {
      stored = JSON.parse(window.localStorage.getItem(storageKey) || '{}') as StoredDashboardViews;
    } catch {
      stored = {};
    }
    const storedSaved = Array.isArray(stored.saved) ? stored.saved.filter(validSavedView) : [];
    setSaved(storedSaved);
    const available = [...presets, ...storedSaved];
    const selected = available.find((view) => view.id === stored.activeId) || presets[0];
    if (!selected) return;
    setActiveId(selected.id);
    setBaseViewId(selected.id);
    setDraftWidgets(selected.widgets);
    onWidgetsChange(selected.widgets);
  }, [storageKey, presets, onWidgetsChange]);

  function persist(nextSaved: SavedDashboardView[], nextActiveId: string) {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ saved: nextSaved, activeId: nextActiveId }));
    } catch {
      // The dashboard still works when browser storage is unavailable; the custom view just will not persist.
    }
  }

  function select(view: DashboardPreset) {
    setActiveId(view.id);
    setBaseViewId(view.id);
    setDraftWidgets(view.widgets);
    setBuilderOpen(false);
    onWidgetsChange(view.widgets);
    persist(saved, view.id);
  }

  function openBuilder() {
    const current = allViews.find((view) => view.id === activeId) || presets[0];
    setBaseViewId(current?.id || presets[0]?.id || '');
    setDraftWidgets(current?.widgets || []);
    setDraftName('');
    setBuilderOpen(true);
  }

  function toggleWidget(widgetId: string) {
    const next = draftWidgets.includes(widgetId)
      ? draftWidgets.filter((id) => id !== widgetId)
      : [...draftWidgets, widgetId];
    setDraftWidgets(next);
    setActiveId('__draft__');
    onWidgetsChange(next);
  }

  function cancelBuilder() {
    const base = allViews.find((view) => view.id === baseViewId) || presets[0];
    if (base) select(base);
    else setBuilderOpen(false);
  }

  function saveView() {
    const trimmed = draftName.trim();
    if (!draftWidgets.length) return;
    const view: SavedDashboardView = {
      id: `custom-${Date.now()}`,
      label: trimmed || `Custom ${saved.length + 1}`,
      description: 'Saved custom dashboard',
      widgets: draftWidgets,
      custom: true,
    };
    const next = [...saved, view];
    setSaved(next);
    setActiveId(view.id);
    setBaseViewId(view.id);
    setDraftName('');
    setBuilderOpen(false);
    onWidgetsChange(view.widgets);
    persist(next, view.id);
  }

  function deleteView(id: string) {
    const next = saved.filter((view) => view.id !== id);
    setSaved(next);
    if (activeId === id || baseViewId === id) {
      const fallback = presets[0];
      if (fallback) {
        setActiveId(fallback.id);
        setBaseViewId(fallback.id);
        setDraftWidgets(fallback.widgets);
        onWidgetsChange(fallback.widgets);
        persist(next, fallback.id);
        return;
      }
    }
    persist(next, activeId);
  }

  return <section className="dashViewShell">
    <div className="dashViewBar">
      <div className="dashViewIntro">
        <span>Dashboard view</span>
        <strong>{allViews.find((view) => view.id === activeId)?.label || 'Customizing'}</strong>
      </div>
      <div className="dashViewTabs" role="tablist" aria-label="Dashboard views">
        {presets.map((view) => <button
          className={`dashViewTab ${activeId === view.id ? 'active' : ''}`}
          key={view.id}
          onClick={() => select(view)}
          type="button"
        >{view.label}</button>)}
        {saved.map((view) => <button
          className={`dashViewTab saved ${activeId === view.id ? 'active' : ''}`}
          key={view.id}
          onClick={() => select(view)}
          type="button"
        >{view.label}</button>)}
      </div>
      <button className={`dashCustomizeButton ${builderOpen ? 'active' : ''}`} type="button" onClick={() => builderOpen ? cancelBuilder() : openBuilder()}>
        {builderOpen ? 'Cancel' : '+ Customize'}
      </button>
    </div>

    {builderOpen && <div className="dashBuilder">
      <div className="dashBuilderHeader">
        <div><span>Build your own</span><strong>Choose what belongs on this dashboard</strong><small>Saved views stay on this browser for now.</small></div>
        <div className="dashBuilderSave">
          <input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="View name" aria-label="Custom dashboard view name" />
          <button type="button" onClick={saveView} disabled={!draftWidgets.length}>Save view</button>
        </div>
      </div>
      <div className="dashWidgetChoices">
        {widgets.map((widget) => {
          const selected = draftWidgets.includes(widget.id);
          return <button
            type="button"
            key={widget.id}
            className={`dashWidgetChoice ${selected ? 'selected' : ''}`}
            onClick={() => toggleWidget(widget.id)}
          >
            <span className="dashWidgetCheck">{selected ? '✓' : '+'}</span>
            <span><strong>{widget.label}</strong><small>{widget.description}</small></span>
          </button>;
        })}
      </div>
      {saved.length > 0 && <div className="dashSavedViews">
        <span>Saved views</span>
        {saved.map((view) => <div key={view.id}><strong>{view.label}</strong><small>{view.widgets.length} widgets</small><button type="button" onClick={() => deleteView(view.id)}>Remove</button></div>)}
      </div>}
    </div>}
  </section>;
}

function validSavedView(value: unknown): value is SavedDashboardView {
  if (!value || typeof value !== 'object') return false;
  const view = value as Partial<SavedDashboardView>;
  return typeof view.id === 'string'
    && typeof view.label === 'string'
    && typeof view.description === 'string'
    && Array.isArray(view.widgets)
    && view.widgets.every((item) => typeof item === 'string');
}
