import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { GPUComputeInfo, HardwareInformation, Orchestrator, CapabilityPrice } from './types';

const GATEWAY_TYPES = [
  { key: 'transcoding', label: 'Transcoding' },
  { key: 'ai-batch', label: 'AI Batch' },
  { key: 'ai-lv2v', label: 'LV2V' },
];

const ICON_PERSON = '\u{1F464}';
const ICON_GPU = '\u{26A1}';
const ICON_WARNING = '\u{26A0}';
const ICON_CLOSE = '\u{2715}';
const HEVC_ENCODE_CAP = '16';

// Aggregate orchestrators by address, summing GPU counts across all URIs
interface TopOrchEntry {
  address: string;
  uris: string[];
  gpuCount: number;
  hevcCapacity: number;
  regions: string[];
}

function aggregateByAddress(orchs: Orchestrator[]): TopOrchEntry[] {
  const map = new Map<string, TopOrchEntry>();
  for (const orch of orchs) {
    let entry = map.get(orch.address);
    if (!entry) {
      entry = { address: orch.address, uris: [], gpuCount: 0, hevcCapacity: 0, regions: [] };
      map.set(orch.address, entry);
    }
    entry.uris.push(orch.orch_uri);
    entry.hevcCapacity += orch.capabilities?.capacities?.[HEVC_ENCODE_CAP] ?? 0;
    const advertisedModels = getAdvertisedModels(orch);
    if (orch.hardware) {
      for (const hw of orch.hardware) {
        if (advertisedModels.size > 0 && !advertisedModels.has(hw.model_id)) continue;
        if (hw.gpu_info) entry.gpuCount += Object.keys(hw.gpu_info).length;
      }
    }
    for (const r of orch.regions || []) {
      if (!entry.regions.includes(r)) entry.regions.push(r);
    }
  }
  return [...map.values()];
}

type SortDir = 'asc' | 'desc' | null;

interface SortState {
  column: string;
  direction: SortDir;
}

function SortableHeader({ label, sortKey, sortState, onSort }: {
  label: string;
  sortKey: string;
  sortState: SortState;
  onSort: (key: string) => void;
}) {
  const isActive = sortState.column === sortKey;
  let arrow = '';
  if (isActive) {
    arrow = sortState.direction === 'asc' ? ' ▲' : ' ▼';
  }
  return (
    <th className={`sortable-header ${isActive ? 'active' : ''}`} onClick={() => onSort(sortKey)} title="Click to sort">
      {label}{arrow}
    </th>
  );
}

function Top5Orchestrators({ entries, label, icon, allRegionDetails }: {
  entries: TopOrchEntry[];
  label: string;
  icon: string;
  allRegionDetails: Record<string, { code: string; city: string; country: string }>;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="top5-section">
      <h3 className="top5-title">{icon} Top 5 Orchestrators by {label}</h3>
      <div className="top5-grid">
        {entries.slice(0, 5).map((entry, i) => (
          <div key={entry.address} className="top5-card">
            <div className="top5-rank">#{i + 1}</div>
            <div className="top5-address" title={entry.address}>
              {entry.address.slice(0, 10)}...{entry.address.slice(-8)}
            </div>
            <div className="top5-value">
              <span className="top5-number">{entry[label === 'GPUs' ? 'gpuCount' : 'hevcCapacity'] as number}</span>
              <span className="top5-label">{label}</span>
            </div>
            <div className="top5-uris">
              {entry.uris.slice(0, 2).map((u, j) => (
                <span key={j} className="top5-uri" title={u}>{u}</span>
              ))}
              {entry.uris.length > 2 && <span className="top5-uri">+{entry.uris.length - 2}</span>}
            </div>
            <div className="top5-regions">
              {entry.regions.map(r => (
                <span key={r} className="tag region" title={`${allRegionDetails[r]?.city || ''} ${allRegionDetails[r]?.country || ''}`}>{r.toUpperCase()}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function applySort<T>(items: T[], getter: (item: T) => string | number, direction: SortDir): T[] {
  if (!direction) return items;
  return [...items].sort((a, b) => {
    const va = getter(a);
    const vb = getter(b);
    if (typeof va === 'number' && typeof vb === 'number') return direction === 'asc' ? va - vb : vb - va;
    return direction === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
  });
}

function orchMatches(orch: Orchestrator, q: string): boolean {
  if (!q) return true;
  const ql = q.toLowerCase();
  if (orch.address?.toLowerCase().includes(ql)) return true;
  if (orch.orch_uri?.toLowerCase().includes(ql)) return true;
  if (orch.capabilities?.version?.toLowerCase().includes(ql)) return true;
  if (orch.hardware) {
    for (const hw of orch.hardware) {
      if (hw.pipeline?.toLowerCase().includes(ql)) return true;
      if (hw.model_id?.toLowerCase().includes(ql)) return true;
      if (hw.gpu_info) {
        for (const gpu of Object.values(hw.gpu_info)) {
          if (gpu.name?.toLowerCase().includes(ql)) return true;
          if (gpu.id?.toLowerCase().includes(ql)) return true;
        }
      }
    }
  }
  if (orch.regions) {
    for (const r of orch.regions) {
      if (String(r).toLowerCase().includes(ql)) return true;
    }
  }
  return false;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

interface GPUEntry {
  gpu: GPUComputeInfo;
  orchAddress: string;
  orchUri: string;
  pipeline: string;
  modelId: string;
  region: string;
}

function extractGPUs(orchs: Orchestrator[], region: string): GPUEntry[] {
  const entries: GPUEntry[] = [];
  for (const orch of orchs) {
    if (!orch.hardware) continue;
    for (const hw of orch.hardware) {
      if (!hw.gpu_info) continue;
      for (const gpu of Object.values(hw.gpu_info)) {
        entries.push({ gpu, orchAddress: orch.address, orchUri: orch.orch_uri, pipeline: hw.pipeline, modelId: hw.model_id, region });
      }
    }
  }
  return entries;
}

function analyzeGPUs(entries: GPUEntry[]) {
  const byId = new Map<string, GPUEntry[]>();
  for (const e of entries) {
    const list = byId.get(e.gpu.id) || [];
    list.push(e);
    byId.set(e.gpu.id, list);
  }

  const uniqueGPUs: GPUEntry[] = [];
  const duplicates: Array<{ id: string; entries: GPUEntry[] }> = [];
  let duplicateCount = 0;

  for (const [id, list] of byId.entries()) {
    if (list.length === 1) {
      uniqueGPUs.push(list[0]);
    } else {
      duplicates.push({ id, entries: list });
      duplicateCount += list.length - 1;
    }
  }

  const byType = new Map<string, number>();
  for (const e of uniqueGPUs) {
    const name = e.gpu.name || 'Unknown';
    byType.set(name, (byType.get(name) || 0) + 1);
  }
  for (const dup of duplicates) {
    const name = dup.entries[0]?.gpu.name || 'Unknown';
    byType.set(name, (byType.get(name) || 0) + 1);
  }

  const totalUniqueCount = uniqueGPUs.length + duplicates.length;

  return {
    uniqueGPUs,
    duplicateCount,
    duplicates: duplicates.sort((a, b) => b.entries.length - a.entries.length),
    byType: new Map([...byType.entries()].sort((a, b) => b[1] - a[1])),
    totalUniqueCount,
  };
}

function countHEVCEncode(orchs: Orchestrator[]): number {
  let count = 0;
  for (const orch of orchs) {
    const caps = orch.capabilities?.capacities;
    if (caps && HEVC_ENCODE_CAP in caps) {
      count += caps[HEVC_ENCODE_CAP];
    }
  }
  return count;
}

function getCapabilityNames(orch: Orchestrator, capsMap: Record<string, string>, excludeCapIds?: string[]): string[] {
  if (!orch.capabilities?.capacities) return [];
  const names: string[] = [];
  for (const [id, count] of Object.entries(orch.capabilities.capacities)) {
    if (excludeCapIds?.includes(id)) continue;
    const name = capsMap[id] ?? `ID:${id}`;
    names.push(`${name} (\u00d7${count})`);
  }
  return names;
}

function getModelConstraints(orch: Orchestrator): string[] {
  const models: string[] = [];
  const pc = orch.capabilities?.constraints?.PerCapability;
  if (!pc) return models;
  for (const [, capData] of Object.entries(pc)) {
    if (capData.models) {
      for (const [modelName, modelInfo] of Object.entries(capData.models)) {
        const warm = modelInfo.warm ? 'warm' : 'cold';
        const inUse = modelInfo.capacityInUse !== undefined ? `, inUse:${modelInfo.capacityInUse}` : '';
        models.push(`${modelName} (${warm}${inUse})`);
      }
    }
  }
  return models;
}

function getAdvertisedModels(orch: Orchestrator): Set<string> {
  const models = new Set<string>();
  const pc = orch.capabilities?.constraints?.PerCapability;
  if (!pc) return models;
  for (const capData of Object.values(pc)) {
    if (capData.models) {
      for (const modelName of Object.keys(capData.models)) {
        models.add(modelName);
      }
    }
  }
  return models;
}

interface PipelineInfo {
  pipeline: string;
  models: string[];
  orchCount: number;
  gpuCount: number;
  modelGpuCounts: Record<string, number>;
  modelInUseCounts: Record<string, number>;
}

function extractPipelines(orchs: Orchestrator[], filterByAdvertised: boolean = false): PipelineInfo[] {
  const byPipeline = new Map<string, { models: Set<string>; orchs: Set<string>; gpuCount: number; modelGpuCounts: Map<string, number>; modelInUseCounts: Map<string, number> }>();
  for (const orch of orchs) {
    if (!orch.hardware) continue;
    const advertisedModels = filterByAdvertised ? getAdvertisedModels(orch) : null;

    // Build model -> inUse map from PerCapability constraints
    const modelInUse: Map<string, number> = new Map();
    const pc = orch.capabilities?.constraints?.PerCapability;
    if (pc) {
      for (const capData of Object.values(pc)) {
        if (capData.models) {
          for (const [modelName, modelInfo] of Object.entries(capData.models)) {
            if (modelInfo.capacityInUse !== undefined) {
              modelInUse.set(modelName, (modelInUse.get(modelName) || 0) + modelInfo.capacityInUse);
            }
          }
        }
      }
    }

    for (const hw of orch.hardware) {
      if (filterByAdvertised && advertisedModels && advertisedModels.size > 0 && !advertisedModels.has(hw.model_id)) continue;
      const p = hw.pipeline || 'unknown';
      const existing = byPipeline.get(p) || { models: new Set<string>(), orchs: new Set<string>(), gpuCount: 0, modelGpuCounts: new Map<string, number>(), modelInUseCounts: new Map<string, number>() };
      if (hw.model_id) {
        existing.models.add(hw.model_id);
        const gpuCountForHw = hw.gpu_info ? Object.keys(hw.gpu_info).length : 0;
        existing.modelGpuCounts.set(hw.model_id, (existing.modelGpuCounts.get(hw.model_id) || 0) + gpuCountForHw);
        const inUse = modelInUse.get(hw.model_id) || 0;
        if (inUse > 0) {
          existing.modelInUseCounts.set(hw.model_id, (existing.modelInUseCounts.get(hw.model_id) || 0) + inUse);
        }
      }
      existing.orchs.add(orch.address);
      existing.gpuCount += hw.gpu_info ? Object.keys(hw.gpu_info).length : 0;
      byPipeline.set(p, existing);
    }
  }
  return [...byPipeline.entries()]
    .map(([pipeline, info]) => ({
      pipeline,
      models: [...info.models].sort(),
      orchCount: info.orchs.size,
      gpuCount: info.gpuCount,
      modelGpuCounts: Object.fromEntries([...info.modelGpuCounts.entries()].sort((a, b) => b[1] - a[1])),
      modelInUseCounts: Object.fromEntries([...info.modelInUseCounts.entries()].sort((a, b) => b[1] - a[1])),
    }))
    .sort((a, b) => b.orchCount - a.orchCount);
}

interface CapabilityDetail {
  id: string;
  name: string;
  count: number;
  models: Array<{ name: string; warm: boolean; runnerVersion?: string; capacityInUse?: number }>;
}

function extractCapabilities(orchs: Orchestrator[], capsMap: Record<string, string>, excludeCapIds?: string[]): CapabilityDetail[] {
  const byCap = new Map<string, { count: number; models: Map<string, { warm: boolean; runnerVersion?: string; capacityInUse?: number }> }>();
  for (const orch of orchs) {
    const caps = orch.capabilities?.capacities;
    if (!caps) continue;
    for (const [id, count] of Object.entries(caps)) {
      if (excludeCapIds?.includes(id)) continue;
      const existing = byCap.get(id) || { count: 0, models: new Map() };
      existing.count += count;
      byCap.set(id, existing);
    }
    const pc = orch.capabilities?.constraints?.PerCapability;
    if (pc) {
      for (const [capId, capData] of Object.entries(pc)) {
        if (excludeCapIds?.includes(capId)) continue;
        const capEntry = byCap.get(capId) || { count: 0, models: new Map() };
        if (capData.models) {
          for (const [modelName, modelInfo] of Object.entries(capData.models)) {
            const existing = capEntry.models.get(modelName) || { warm: false };
            if (modelInfo.warm) existing.warm = true;
            if (modelInfo.runnerVersion) existing.runnerVersion = modelInfo.runnerVersion;
            if (modelInfo.capacityInUse !== undefined) existing.capacityInUse = (existing.capacityInUse ?? 0) + modelInfo.capacityInUse;
            capEntry.models.set(modelName, existing);
          }
        }
        byCap.set(capId, capEntry);
      }
    }
  }
  return [...byCap.entries()]
    .map(([id, info]) => ({
      id,
      name: capsMap[id] ?? `ID:${id}`,
      count: info.count,
      models: [...info.models.entries()].map(([name, m]) => ({ name, ...m })).sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.count - a.count);
}

function DuplicateModal({ duplicates, onClose }: { duplicates: Array<{ id: string; entries: GPUEntry[] }>; onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{ICON_WARNING} Duplicate GPU IDs ({duplicates.length} unique IDs, {duplicates.reduce((s, d) => s + d.entries.length - 1, 0)} duplicates)</h2>
          <button className="modal-close" onClick={onClose}>{ICON_CLOSE}</button>
        </div>
        <div className="modal-body">
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr><th>GPU ID</th><th>Name</th><th>Appearances</th><th>Seen On</th></tr>
              </thead>
              <tbody>
                {duplicates.map((dup) => (
                  <tr key={dup.id} className="duplicate-row">
                    <td className="mono">{dup.id}</td>
                    <td>{dup.entries[0]?.gpu.name || 'Unknown'}</td>
                    <td>{dup.entries.length}</td>
                    <td>
                      <div className="tag-list">
                        {dup.entries.map((e, i) => (
                          <span key={i} className="tag dup" title={`${e.orchAddress} @ ${e.orchUri} | ${e.region}`}>
                            {e.orchAddress.slice(0, 8)}... ({e.region})
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

interface GatewayData {
  gateway_type: string;
  orchestrators: Orchestrator[];
  capabilities_names: Record<string, string>;
  regions: Record<string, { instance_id: string; orch_count: number; last_seen: string }>;
  region_details: Record<string, { code: string; city: string; country: string }>;
}

// Sub-tab definitions per gateway type
const AI_SUB_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'orchestrators', label: 'Orchestrators' },
  { key: 'gpus', label: 'GPUs' },
  { key: 'pipelines', label: 'Pipelines' },
  { key: 'capabilities', label: 'Capabilities' },
  { key: 'prices', label: 'Prices' },
];

const TRANSCODING_SUB_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'transcoders', label: 'Transcoders' },
  { key: 'capabilities', label: 'Capabilities' },
  { key: 'prices', label: 'Prices' },
];

function getSubTabs(gatewayKey: string): typeof AI_SUB_TABS {
  return gatewayKey === 'transcoding' ? TRANSCODING_SUB_TABS : AI_SUB_TABS;
}

export default function Dashboard() {
  const [gatewayData, setGatewayData] = useState<Record<string, GatewayData>>({});
  const [initialLoad, setInitialLoad] = useState(true);
  const initialLoadRef = useRef(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [justUpdated, setJustUpdated] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('transcoding');
  const [activeSubTab, setActiveSubTab] = useState<string>('overview');
  const [showDupModal, setShowDupModal] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState<string>('');
  const [searchText, setSearchText] = useState<string>('');
  const [rawSearch, setRawSearch] = useState<string>('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [suggestions, setSuggestions] = useState<Array<{ type: string; value: string }>>([]);
  const [suggestionActive, setSuggestionActive] = useState<number>(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Sort state per table
  const [sortState, setSortState] = useState<Map<string, SortState>>(new Map());

  const handleSort = useCallback((table: string, column: string) => {
    setSortState(prev => {
      const next = new Map(prev);
      const current = next.get(table);
      if (current?.column === column) {
        if (current.direction === 'asc') next.set(table, { column, direction: 'desc' });
        else if (current.direction === 'desc') next.set(table, { column, direction: null });
        else next.set(table, { column, direction: 'asc' });
      } else {
        next.set(table, { column, direction: 'asc' });
      }
      return next;
    });
  }, []);

  const getSort = useCallback((table: string): SortState => {
    return sortState.get(table) || { column: '', direction: null };
  }, [sortState]);

  // Debounce rawSearch -> searchText (300ms)
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setSearchText(rawSearch);
    }, 300);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [rawSearch]);

  // Collect autocomplete suggestions when rawSearch has >= 2 chars
  const collectSearchSuggestions = useCallback((q: string, data: Record<string, GatewayData>) => {
    if (q.length < 2) return [];
    const ql = q.toLowerCase();
    const seen = new Set<string>();
    const results: Array<{ type: string; value: string }> = [];
    const add = (type: string, value: string) => {
      const key = `${type}:${value.toLowerCase()}`;
      if (!seen.has(key) && results.length < 8 && value.toLowerCase().includes(ql)) {
        seen.add(key);
        results.push({ type, value });
      }
    };
    for (const gw of Object.values(data)) {
      for (const orch of gw.orchestrators || []) {
        add('addr', orch.address);
        add('uri', orch.orch_uri);
        if (orch.regions) for (const r of orch.regions) add('region', String(r));
        if (orch.capabilities?.version) add('version', orch.capabilities.version);
        if (orch.hardware) {
          for (const hw of orch.hardware) {
            add('pipeline', hw.pipeline);
            add('model', hw.model_id);
            if (hw.gpu_info) {
              for (const gpu of Object.values(hw.gpu_info)) {
                add('gpu', gpu.name);
                add('gpu_id', gpu.id);
              }
            }
          }
        }
      }
    }
    return results;
  }, []);

  useEffect(() => {
    setSuggestions(collectSearchSuggestions(rawSearch, gatewayData));
    setSuggestionActive(-1);
  }, [rawSearch, gatewayData, collectSearchSuggestions]);

  const handleSearchClear = useCallback(() => {
    setRawSearch('');
    setSearchText('');
    searchInputRef.current?.focus();
  }, []);

  const handleSuggestionSelect = useCallback((value: string) => {
    setRawSearch(value);
    setSearchText(value);
    setSuggestions([]);
    searchInputRef.current?.focus();
  }, []);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSuggestionActive(prev => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSuggestionActive(prev => Math.max(prev - 1, -1));
    } else if (e.key === 'Enter' && suggestionActive >= 0) {
      e.preventDefault();
      handleSuggestionSelect(suggestions[suggestionActive].value);
    } else if (e.key === 'Escape') {
      setSuggestions([]);
      searchInputRef.current?.blur();
    }
  }, [suggestions, suggestionActive, handleSuggestionSelect]);

  const fetchData = useCallback(async () => {
    setError(null);
    const isFirst = initialLoadRef.current;
    if (!isFirst) setRefreshing(true);
    try {
      const res = await fetch('/api/capabilities/aggregated');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const byType: Record<string, GatewayData> = {};
      for (const gw of json.gateways || []) {
        byType[gw.gateway_type] = gw;
      }
      setGatewayData(byType);
      initialLoadRef.current = false;
      setInitialLoad(false);
      setRefreshing(false);
      setLastUpdated(new Date());
      setJustUpdated(true);
      setTimeout(() => setJustUpdated(false), 600);
    } catch (err) {
      setError((err as Error).message);
      initialLoadRef.current = false;
      setInitialLoad(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Collect all unique region codes across all gateway types
  const allRegions = useMemo(() => {
    const codes = new Set<string>();
    for (const gw of Object.values(gatewayData)) {
      for (const code of Object.keys(gw.regions || {})) {
        codes.add(code);
      }
    }
    return [...codes].sort();
  }, [gatewayData]);

  // Build a combined region_details lookup from all gateways
  const allRegionDetails = useMemo(() => {
    const map: Record<string, { code: string; city: string; country: string }> = {};
    for (const gw of Object.values(gatewayData)) {
      for (const [code, detail] of Object.entries(gw.region_details || {})) {
        map[code] = detail;
      }
    }
    return map;
  }, [gatewayData]);

  const activeGateway = gatewayData[activeTab];
  const orchs = activeGateway?.orchestrators || [];
  const subTabs = useMemo(() => getSubTabs(activeTab), [activeTab]);

  // Reset sub-tab to overview when switching gateway tabs
  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab);
    setActiveSubTab('overview');
  }, []);

  // Filter orchestrators by selected region and search text
  const filteredOrchs = useMemo(() => {
    return orchs.filter(o => {
      if (selectedRegion && !(o.regions && o.regions.includes(selectedRegion))) return false;
      if (!orchMatches(o, searchText)) return false;
      return true;
    });
  }, [orchs, selectedRegion, searchText]);

  // Global GPU entries (filtered by region and search text)
  const gpuEntries = useMemo(() => {
    const entries: GPUEntry[] = [];
    for (const gw of Object.values(gatewayData)) {
      if (gw.gateway_type === 'transcoding') continue;
      const filtered = (gw.orchestrators || []).filter(o => {
        if (selectedRegion && !(o.regions && o.regions.includes(selectedRegion))) return false;
        if (!orchMatches(o, searchText)) return false;
        return true;
      });
      for (const regionId in gw.regions || {}) {
        if (selectedRegion && regionId !== selectedRegion) continue;
        entries.push(...extractGPUs(filtered, regionId));
      }
    }
    return entries;
  }, [gatewayData, selectedRegion, searchText]);

  const globalAnalysis = useMemo(() => analyzeGPUs(gpuEntries), [gpuEntries]);

  const totalHEVC = useMemo(() => {
    const transcoding = gatewayData['transcoding'];
    const filtered = (transcoding?.orchestrators || []).filter(o => {
      if (selectedRegion && !(o.regions && o.regions.includes(selectedRegion))) return false;
      if (!orchMatches(o, searchText)) return false;
      return true;
    });
    return countHEVCEncode(filtered);
  }, [gatewayData, selectedRegion, searchText]);

  const totalOrchestrators = useMemo(() => {
    let count = 0;
    for (const gw of Object.values(gatewayData)) {
      const filtered = (gw.orchestrators || []).filter(o => {
        if (selectedRegion && !(o.regions && o.regions.includes(selectedRegion))) return false;
        if (!orchMatches(o, searchText)) return false;
        return true;
      });
      count += filtered.length;
    }
    return count;
  }, [gatewayData, selectedRegion, searchText]);

  const activeGpuEntries = useMemo(() => {
    return extractGPUs(filteredOrchs, activeTab);
  }, [filteredOrchs, activeTab]);

  const activeAnalysis = useMemo(() => analyzeGPUs(activeGpuEntries), [activeGpuEntries]);

  return (
    <div className="app">
      <header>
        <h1>Livepeer Network Capabilities</h1>
        <div className="header-actions">
          <button onClick={fetchData} disabled={refreshing}>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          {lastUpdated && (
            <span className={`last-updated ${justUpdated ? 'just-updated' : ''}`}>
              Last updated: {lastUpdated.toLocaleTimeString()}
            </span>
          )}
        </div>
      </header>

      {/* Search Bar */}
      <div className="search-bar">
        <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          ref={searchInputRef}
          type="text"
          className="search-input"
          placeholder="Search address, URI, GPU, model, pipeline, region..."
          value={rawSearch}
          onChange={e => setRawSearch(e.target.value)}
          onKeyDown={handleSearchKeyDown}
        />
        {rawSearch && (
          <button className="search-clear" onClick={handleSearchClear} title="Clear search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        )}
        {suggestions.length > 0 && (
          <div className="search-autocomplete">
            {suggestions.map((s, i) => (
              <div
                key={`${s.type}:${s.value}`}
                className={`search-suggestion ${i === suggestionActive ? 'active' : ''}`}
                onMouseDown={() => handleSuggestionSelect(s.value)}
              >
                <span className="suggest-type">{s.type}</span>
                <span className="suggest-value">
                  {(() => {
                    const idx = s.value.toLowerCase().indexOf(rawSearch.toLowerCase());
                    if (idx < 0) return s.value;
                    return (
                      <>
                        {s.value.slice(0, idx)}
                        <mark>{s.value.slice(idx, idx + rawSearch.length)}</mark>
                        {s.value.slice(idx + rawSearch.length)}
                      </>
                    );
                  })()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Region Filter */}
      <section className="region-filter">
        <button
          className={`region-btn ${!selectedRegion ? 'active' : ''}`}
          onClick={() => setSelectedRegion('')}
        >
          ALL
        </button>
        {allRegions.map(code => (
          <button
            key={code}
            className={`region-btn ${selectedRegion === code ? 'active' : ''}`}
            onClick={() => setSelectedRegion(code)}
            title={`${allRegionDetails[code]?.city || ''} ${allRegionDetails[code]?.country || ''}`}
          >
            {code.toUpperCase()}
          </button>
        ))}
      </section>

      <section className="summary-cards">
        <div className="card">
          <h3>{ICON_PERSON} Total Orchestrators</h3>
          <div className="card-value">{totalOrchestrators}</div>
          {(selectedRegion || searchText) && <div className="card-detail">filtered: {selectedRegion ? selectedRegion.toUpperCase() : ''}{selectedRegion && searchText ? ' + ' : ''}"{searchText}"</div>}
        </div>
        <div className="card">
          <h3>{ICON_GPU} Total AI GPUs</h3>
          <div className="card-value">{globalAnalysis.totalUniqueCount}</div>
          <div className="card-detail">
            {gpuEntries.length} entries &minus; {globalAnalysis.duplicateCount} duplicate entries
            {globalAnalysis.duplicateCount > 0 && (
              <button className="detail-link" onClick={() => setShowDupModal(true)}>(detail)</button>
            )}
          </div>
        </div>
        <div className="card">
          <h3>AI GPU Types</h3>
          <div className="card-value">{globalAnalysis.byType.size}</div>
        </div>
        <div className="card">
          <h3>GPU Transcoders</h3>
          <div className="card-value">{totalHEVC}</div>
          <div className="card-detail">total GPUs with HEVC encode capacity</div>
        </div>
      </section>

      <section className="gpu-explanation">
        <div className="explanation-box">
          <strong>How Total AI GPUs is counted:</strong>
          <p>
            Each GPU has a unique identifier (<code>gpu.id</code>). The same GPU may be advertised
            by multiple orchestrator addresses or across multiple pipelines. We deduplicate by <code>gpu.id</code> to count physical GPUs.
            Transcoding GPUs are excluded from this count.
          </p>
          <p>
            Total entries: <strong>{gpuEntries.length}</strong> &nbsp;|&nbsp;
            Unique AI GPUs: <strong>{globalAnalysis.totalUniqueCount}</strong> &nbsp;|&nbsp;
            Duplicates removed: <strong>{globalAnalysis.duplicateCount}</strong>
            {globalAnalysis.duplicateCount > 0 && (
              <>
                &nbsp;|&nbsp;
                <button className="detail-link" onClick={() => setShowDupModal(true)}>(detail)</button>
              </>
            )}
          </p>
        </div>
      </section>

      {showDupModal && globalAnalysis.duplicates.length > 0 && (
        <DuplicateModal duplicates={globalAnalysis.duplicates} onClose={() => setShowDupModal(false)} />
      )}

      {globalAnalysis.byType.size > 0 && (
        <section className="gpu-breakdown">
          <h2>AI GPU Count by Type (Unique)</h2>
          <div className="table-wrapper">
            <table className="data-table">
              <thead><tr><th>GPU Model</th><th>Count</th></tr></thead>
              <tbody>
                {[...globalAnalysis.byType.entries()].map(([name, count]) => (
                  <tr key={name}><td>{name}</td><td>{count}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Tabs */}
      <div className="tabs-container">
        <div className="tabs">
          {GATEWAY_TYPES.map(gw => {
            const data = gatewayData[gw.key];
            const gwOrchs = (data?.orchestrators || []).filter(o => {
              if (selectedRegion && !(o.regions && o.regions.includes(selectedRegion))) return false;
              if (!orchMatches(o, searchText)) return false;
              return true;
            });
            const orchCount = gwOrchs.length;
            const gpuCount = gw.key === 'transcoding'
              ? countHEVCEncode(gwOrchs)
              : analyzeGPUs(extractGPUs(gwOrchs, gw.key)).totalUniqueCount;
            return (
              <button
                key={gw.key}
                className={`tab ${activeTab === gw.key ? 'active' : ''}`}
                onClick={() => handleTabChange(gw.key)}
              >
                <span className="tab-label">{gw.label}</span>
                <span className="tab-badges">
                  <span className="tab-badge orch" title="Orchestrators">
                    {ICON_PERSON} {orchCount}
                  </span>
                  <span className="tab-badge gpu" title={gw.key === 'transcoding' ? 'GPU Transcoders' : 'Unique GPUs'}>
                    {ICON_GPU} {gpuCount}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div className={`tab-content ${refreshing ? 'refreshing' : ''} ${justUpdated ? 'data-flash' : ''}`}>
          {initialLoad && <div className="loading">Loading...</div>}
          {error && !initialLoad && (
            <div className="error">
              <strong>Error:</strong> {error}
            </div>
          )}

          {!initialLoad && activeGateway && (
            <>
              {filteredOrchs.length === 0 ? (
                <div className="empty">{selectedRegion ? `No orchestrators in ${selectedRegion.toUpperCase()}.` : 'No orchestrators available.'}</div>
              ) : (
                <>
                  <div className="section-summary">
                    <span>{ICON_PERSON} Orchestrators: <strong>{filteredOrchs.length}</strong></span>
                    {activeGateway.regions && Object.keys(activeGateway.regions).length > 0 && (
                      <span>Regions: <strong>{Object.keys(activeGateway.regions).length}</strong></span>
                    )}
                    {activeTab === 'transcoding' ? (
                      <span>GPU Transcoders: <strong>{countHEVCEncode(filteredOrchs)}</strong></span>
                    ) : (
                      <>
                        <span>{ICON_GPU} Total GPU entries: <strong>{activeGpuEntries.length}</strong></span>
                        <span>{ICON_GPU} Unique GPUs: <strong>{activeAnalysis.totalUniqueCount}</strong></span>
                        {activeAnalysis.duplicateCount > 0 && (
                          <span className="dup-badge">{ICON_WARNING} Duplicates: {activeAnalysis.duplicateCount}</span>
                        )}
                      </>
                    )}
                  </div>

                  {/* Sub-tabs */}
                  <div className="sub-tabs">
                    {subTabs.map(st => {
                      let badge = 0;
                      if (st.key === 'overview') badge = filteredOrchs.length;
                      else if (st.key === 'orchestrators') badge = filteredOrchs.length;
                      else if (st.key === 'gpus') badge = activeAnalysis.totalUniqueCount;
                      else if (st.key === 'pipelines') badge = extractPipelines(filteredOrchs, true).length;
                      else if (st.key === 'transcoders') badge = filteredOrchs.length;
                      else if (st.key === 'capabilities') badge = extractCapabilities(filteredOrchs, activeGateway.capabilities_names || {}, [HEVC_ENCODE_CAP]).length;
                      else if (st.key === 'prices') badge = filteredOrchs.reduce((s, o) => s + (o.capabilities_prices?.length || 0), 0);
                      if (st.key === 'prices' && badge === 0) return null;
                      return (
                        <button
                          key={st.key}
                          className={`sub-tab ${activeSubTab === st.key ? 'active' : ''}`}
                          onClick={() => setActiveSubTab(st.key)}
                        >
                          {st.label}
                          {badge > 0 && <span className="sub-tab-badge">{badge}</span>}
                        </button>
                      );
                    })}
                  </div>

                  {/* ── Overview ── */}
                  {activeSubTab === 'overview' && (
                    <>
                      {(() => {
                        const agg = aggregateByAddress(filteredOrchs);
                        if (activeTab === 'transcoding') {
                          const sorted = applySort(agg, (e: TopOrchEntry) => e.hevcCapacity, 'desc');
                          return sorted.some(e => e.hevcCapacity > 0) ? (
                            <Top5Orchestrators entries={sorted} label="HEVC Capacity" icon={ICON_GPU} allRegionDetails={allRegionDetails} />
                          ) : null;
                        } else {
                          const sorted = applySort(agg, (e: TopOrchEntry) => e.gpuCount, 'desc');
                          return sorted.some(e => e.gpuCount > 0) ? (
                            <Top5Orchestrators entries={sorted} label="GPUs" icon={ICON_GPU} allRegionDetails={allRegionDetails} />
                          ) : null;
                        }
                      })()}

                      {activeTab === 'transcoding' ? (
                        <section className="pipeline-details">
                          <h3>GPU Transcoders</h3>
                          <div className="table-wrapper">
                            <table className="data-table">
                              <thead>
                                <tr>
                                  <SortableHeader label="Address" sortKey="address" sortState={getSort('transcoders')} onSort={(k) => handleSort('transcoders', k)} />
                                  <SortableHeader label="URI" sortKey="uri" sortState={getSort('transcoders')} onSort={(k) => handleSort('transcoders', k)} />
                                  <SortableHeader label="HEVC Encode Capacity" sortKey="hevc" sortState={getSort('transcoders')} onSort={(k) => handleSort('transcoders', k)} />
                                  <SortableHeader label="Regions" sortKey="regions" sortState={getSort('transcoders')} onSort={(k) => handleSort('transcoders', k)} />
                                </tr>
                              </thead>
                              <tbody>
                                {applySort(filteredOrchs, (o: Orchestrator) => {
                                  const s = getSort('transcoders');
                                  switch (s.column) {
                                    case 'address': return o.address;
                                    case 'uri': return o.orch_uri;
                                    case 'hevc': return o.capabilities?.capacities?.[HEVC_ENCODE_CAP] ?? -1;
                                    case 'regions': return (o.regions || []).join(',');
                                    default: return o.address;
                                  }
                                }, getSort('transcoders').direction).map((orch, i) => {
                                  const hevcCapacity = orch.capabilities?.capacities?.[HEVC_ENCODE_CAP];
                                  return (
                                    <tr key={i}>
                                      <td className="mono" title={orch.address}>
                                        {orch.address.slice(0, 10)}...{orch.address.slice(-8)}
                                      </td>
                                      <td className="mono small">{orch.orch_uri}</td>
                                      <td className="mono">{hevcCapacity ?? '\u2014'}</td>
                                      <td>
                                        <div className="tag-list">
                                          {(orch.regions || []).map(r => (
                                            <span key={r} className="tag region" title={`${allRegionDetails[r]?.city || ''} ${allRegionDetails[r]?.country || ''}`}>{r.toUpperCase()}</span>
                                          ))}
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </section>
                      ) : (
                        (() => {
                          const pipelines = extractPipelines(filteredOrchs, true);
                          if (pipelines.length === 0) return null;
                          const sorted = applySort(pipelines, (p: PipelineInfo) => {
                            const s = getSort('pipelines');
                            switch (s.column) {
                              case 'pipeline': return p.pipeline;
                              case 'models': return p.models.join(',');
                              case 'orches': return p.orchCount;
                              case 'gpus': return p.gpuCount;
                              default: return p.pipeline;
                            }
                          }, getSort('pipelines').direction);
                          return (
                            <section className="pipeline-details">
                              <h3>Pipelines</h3>
                              <div className="table-wrapper">
                                <table className="data-table pipeline-table">
                                  <thead>
                                    <tr>
                                      <SortableHeader label="Pipeline" sortKey="pipeline" sortState={getSort('pipelines')} onSort={(k) => handleSort('pipelines', k)} />
                                      <SortableHeader label="Models (GPUs)" sortKey="models" sortState={getSort('pipelines')} onSort={(k) => handleSort('pipelines', k)} />
                                      <SortableHeader label="Orchs" sortKey="orches" sortState={getSort('pipelines')} onSort={(k) => handleSort('pipelines', k)} />
                                      <SortableHeader label="Total GPUs" sortKey="gpus" sortState={getSort('pipelines')} onSort={(k) => handleSort('pipelines', k)} />
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {sorted.map((p, i) => (
                                      <tr key={i}>
                                        <td className="mono">{p.pipeline}</td>
                                        <td>
                                          <div className="tag-list">
                                            {p.models.map((m, j) => {
                                              const inUse = p.modelInUseCounts[m];
                                              return (
                                                <span key={j} className="tag model" title={`${p.modelGpuCounts[m] ?? 0} GPU(s), ${inUse !== undefined ? inUse : 0} in use`}>
                                                  {m} ({p.modelGpuCounts[m] ?? 0} GPU{inUse !== undefined ? `, ${inUse} inUse` : ''})
                                                </span>
                                              );
                                            })}
                                          </div>
                                        </td>
                                        <td>{p.orchCount}</td>
                                        <td>{p.gpuCount}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </section>
                          );
                        })()
                      )}
                    </>
                  )}

                  {/* ── Orchestrators (AI tabs only) ── */}
                  {activeSubTab === 'orchestrators' && activeTab !== 'transcoding' && (
                    <>
                      <h3>Orchestrators</h3>
                      <div className="table-wrapper">
                        <table className="data-table orchestrators-table">
                          <thead>
                            <tr>
                              <SortableHeader label="Address" sortKey="address" sortState={getSort('orchestrators')} onSort={(k) => handleSort('orchestrators', k)} />
                              <SortableHeader label="URI" sortKey="uri" sortState={getSort('orchestrators')} onSort={(k) => handleSort('orchestrators', k)} />
                              <SortableHeader label="Version" sortKey="version" sortState={getSort('orchestrators')} onSort={(k) => handleSort('orchestrators', k)} />
                              <SortableHeader label="Capabilities" sortKey="capabilities" sortState={getSort('orchestrators')} onSort={(k) => handleSort('orchestrators', k)} />
                              <SortableHeader label="Models" sortKey="models" sortState={getSort('orchestrators')} onSort={(k) => handleSort('orchestrators', k)} />
                              <SortableHeader label="GPUs" sortKey="gpus" sortState={getSort('orchestrators')} onSort={(k) => handleSort('orchestrators', k)} />
                              <SortableHeader label="Regions" sortKey="regions" sortState={getSort('orchestrators')} onSort={(k) => handleSort('orchestrators', k)} />
                            </tr>
                          </thead>
                          <tbody>
                            {applySort(filteredOrchs, (o: Orchestrator) => {
                              const s = getSort('orchestrators');
                              switch (s.column) {
                                case 'address': return o.address;
                                case 'uri': return o.orch_uri;
                                case 'version': return o.capabilities?.version ?? '';
                                case 'capabilities': return (o.capabilities?.capacities ? Object.keys(o.capabilities.capacities).length : 0);
                                case 'models': return [...getAdvertisedModels(o)].join(',');
                                case 'gpus': {
                                  const am = getAdvertisedModels(o);
                                  return o.hardware ? o.hardware.reduce((sum, h) => sum + ((am.size === 0 || am.has(h.model_id)) && h.gpu_info ? Object.keys(h.gpu_info).length : 0), 0) : 0;
                                }
                                case 'regions': return (o.regions || []).join(',');
                                default: return o.address;
                              }
                            }, getSort('orchestrators').direction).map((orch, i) => {
                              const capNames = getCapabilityNames(orch, activeGateway.capabilities_names || {}, [HEVC_ENCODE_CAP]);
                              const modelConstraints = getModelConstraints(orch);
                              const advertisedModels = getAdvertisedModels(orch);
                              const gpuCount = orch.hardware
                                ? orch.hardware.reduce(
                                    (sum, h) => sum + ((advertisedModels.size === 0 || advertisedModels.has(h.model_id)) && h.gpu_info ? Object.keys(h.gpu_info).length : 0),
                                    0
                                  )
                                : 0;
                              return (
                                <tr key={i}>
                                  <td className="mono" title={orch.address}>
                                    {orch.address.slice(0, 10)}...{orch.address.slice(-8)}
                                  </td>
                                  <td className="mono small">{orch.orch_uri}</td>
                                  <td className="mono small">{orch.capabilities?.version ?? '\u2014'}</td>
                                  <td>
                                    {capNames.length > 0 ? (
                                      <div className="tag-list">
                                        {capNames.slice(0, 6).map((c, j) => (
                                          <span key={j} className="tag">{c}</span>
                                        ))}
                                        {capNames.length > 6 && (
                                          <span className="tag more">+{capNames.length - 6} more</span>
                                        )}
                                      </div>
                                    ) : (
                                      <span className="muted">\u2014</span>
                                    )}
                                  </td>
                                  <td>
                                    {modelConstraints.length > 0 ? (
                                      <div className="tag-list">
                                        {modelConstraints.map((m, j) => (
                                          <span key={j} className="tag model">{m}</span>
                                        ))}
                                      </div>
                                    ) : (
                                      <span className="muted">\u2014</span>
                                    )}
                                  </td>
                                  <td className="mono">{gpuCount}</td>
                                  <td>
                                    <div className="tag-list">
                                      {(orch.regions || []).map(r => (
                                        <span key={r} className="tag region" title={`${allRegionDetails[r]?.city || ''} ${allRegionDetails[r]?.country || ''}`}>{r.toUpperCase()}</span>
                                      ))}
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}

                  {/* ── GPUs (AI tabs only) ── */}
                  {activeSubTab === 'gpus' && activeTab !== 'transcoding' && activeAnalysis.totalUniqueCount > 0 && (
                    (() => {
                      interface GPURow { orch: Orchestrator; hw: HardwareInformation; gpu: GPUComputeInfo }
                      const gpuRows: GPURow[] = [];
                      for (const orch of filteredOrchs) {
                        const am = getAdvertisedModels(orch);
                        for (const hw of orch.hardware ?? []) {
                          if (am.size > 0 && !am.has(hw.model_id)) continue;
                          for (const gpu of Object.values(hw.gpu_info ?? {})) {
                            gpuRows.push({ orch, hw, gpu });
                          }
                        }
                      }
                      const sorted = applySort(gpuRows, (r: GPURow) => {
                        const s = getSort('gpu_details');
                        switch (s.column) {
                          case 'address': return r.orch.address;
                          case 'pipeline': return r.hw.pipeline ?? '';
                          case 'model': return r.hw.model_id ?? '';
                          case 'gpu_id': return r.gpu.id;
                          case 'gpu_name': return r.gpu.name ?? 'Unknown';
                          case 'compute': return r.gpu.major ?? 0;
                          case 'mem_total': return r.gpu.memory_total ?? 0;
                          case 'mem_free': return r.gpu.memory_free ?? 0;
                          case 'regions': return (r.orch.regions || []).join(',');
                          default: return r.orch.address;
                        }
                      }, getSort('gpu_details').direction);
                      return (
                        <>
                          <h3>GPU Details</h3>
                          <div className="table-wrapper">
                            <table className="data-table gpu-table">
                              <thead>
                                <tr>
                                  <SortableHeader label="Address" sortKey="address" sortState={getSort('gpu_details')} onSort={(k) => handleSort('gpu_details', k)} />
                                  <SortableHeader label="Pipeline" sortKey="pipeline" sortState={getSort('gpu_details')} onSort={(k) => handleSort('gpu_details', k)} />
                                  <SortableHeader label="Model" sortKey="model" sortState={getSort('gpu_details')} onSort={(k) => handleSort('gpu_details', k)} />
                                  <SortableHeader label="GPU ID" sortKey="gpu_id" sortState={getSort('gpu_details')} onSort={(k) => handleSort('gpu_details', k)} />
                                  <SortableHeader label="GPU Name" sortKey="gpu_name" sortState={getSort('gpu_details')} onSort={(k) => handleSort('gpu_details', k)} />
                                  <SortableHeader label="Compute" sortKey="compute" sortState={getSort('gpu_details')} onSort={(k) => handleSort('gpu_details', k)} />
                                  <SortableHeader label="Memory Total" sortKey="mem_total" sortState={getSort('gpu_details')} onSort={(k) => handleSort('gpu_details', k)} />
                                  <SortableHeader label="Memory Free" sortKey="mem_free" sortState={getSort('gpu_details')} onSort={(k) => handleSort('gpu_details', k)} />
                                  <SortableHeader label="Regions" sortKey="regions" sortState={getSort('gpu_details')} onSort={(k) => handleSort('gpu_details', k)} />
                                </tr>
                              </thead>
                              <tbody>
                                {sorted.map((r, ri) => (
                                  <tr key={ri}>
                                    <td className="mono small" title={r.orch.address}>
                                      {r.orch.address.slice(0, 8)}...{r.orch.address.slice(-6)}
                                    </td>
                                    <td>{r.hw.pipeline || '\u2014'}</td>
                                    <td>{r.hw.model_id || '\u2014'}</td>
                                    <td className="mono">{r.gpu.id.slice(0, 24)}...</td>
                                    <td>{r.gpu.name || 'Unknown'}</td>
                                    <td>{r.gpu.major}</td>
                                    <td>{formatBytes(r.gpu.memory_total)}</td>
                                    <td>{formatBytes(r.gpu.memory_free)}</td>
                                    <td>
                                      <div className="tag-list">
                                        {(r.orch.regions || []).map(reg => (
                                          <span key={reg} className="tag region" title={`${allRegionDetails[reg]?.city || ''} ${allRegionDetails[reg]?.country || ''}`}>{reg.toUpperCase()}</span>
                                        ))}
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      );
                    })()
                  )}

                  {/* ── Transcoders (transcoding tab only) ── */}
                  {activeSubTab === 'transcoders' && activeTab === 'transcoding' && (
                    <section className="pipeline-details">
                      <h3>GPU Transcoders</h3>
                      <div className="table-wrapper">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <SortableHeader label="Address" sortKey="address" sortState={getSort('transcoders')} onSort={(k) => handleSort('transcoders', k)} />
                              <SortableHeader label="URI" sortKey="uri" sortState={getSort('transcoders')} onSort={(k) => handleSort('transcoders', k)} />
                              <SortableHeader label="HEVC Encode Capacity" sortKey="hevc" sortState={getSort('transcoders')} onSort={(k) => handleSort('transcoders', k)} />
                              <SortableHeader label="Regions" sortKey="regions" sortState={getSort('transcoders')} onSort={(k) => handleSort('transcoders', k)} />
                            </tr>
                          </thead>
                          <tbody>
                            {applySort(filteredOrchs, (o: Orchestrator) => {
                              const s = getSort('transcoders');
                              switch (s.column) {
                                case 'address': return o.address;
                                case 'uri': return o.orch_uri;
                                case 'hevc': return o.capabilities?.capacities?.[HEVC_ENCODE_CAP] ?? -1;
                                case 'regions': return (o.regions || []).join(',');
                                default: return o.address;
                              }
                            }, getSort('transcoders').direction).map((orch, i) => {
                              const hevcCapacity = orch.capabilities?.capacities?.[HEVC_ENCODE_CAP];
                              return (
                                <tr key={i}>
                                  <td className="mono" title={orch.address}>
                                    {orch.address.slice(0, 10)}...{orch.address.slice(-8)}
                                  </td>
                                  <td className="mono small">{orch.orch_uri}</td>
                                  <td className="mono">{hevcCapacity ?? '\u2014'}</td>
                                  <td>
                                    <div className="tag-list">
                                      {(orch.regions || []).map(r => (
                                        <span key={r} className="tag region" title={`${allRegionDetails[r]?.city || ''} ${allRegionDetails[r]?.country || ''}`}>{r.toUpperCase()}</span>
                                      ))}
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  )}

                  {/* ── Pipelines (AI tabs only) ── */}
                  {activeSubTab === 'pipelines' && activeTab !== 'transcoding' && (
                    (() => {
                      const pipelines = extractPipelines(filteredOrchs, true);
                      if (pipelines.length === 0) return null;
                      const sorted = applySort(pipelines, (p: PipelineInfo) => {
                        const s = getSort('pipelines');
                        switch (s.column) {
                          case 'pipeline': return p.pipeline;
                          case 'models': return p.models.join(',');
                          case 'orches': return p.orchCount;
                          case 'gpus': return p.gpuCount;
                          default: return p.pipeline;
                        }
                      }, getSort('pipelines').direction);
                      return (
                        <section className="pipeline-details">
                          <h3>Pipelines</h3>
                          <div className="table-wrapper">
                            <table className="data-table pipeline-table">
                              <thead>
                                <tr>
                                  <SortableHeader label="Pipeline" sortKey="pipeline" sortState={getSort('pipelines')} onSort={(k) => handleSort('pipelines', k)} />
                                  <SortableHeader label="Models (GPUs)" sortKey="models" sortState={getSort('pipelines')} onSort={(k) => handleSort('pipelines', k)} />
                                  <SortableHeader label="Orchs" sortKey="orches" sortState={getSort('pipelines')} onSort={(k) => handleSort('pipelines', k)} />
                                  <SortableHeader label="Total GPUs" sortKey="gpus" sortState={getSort('pipelines')} onSort={(k) => handleSort('pipelines', k)} />
                                </tr>
                              </thead>
                              <tbody>
                                {sorted.map((p, i) => (
                                  <tr key={i}>
                                    <td className="mono">{p.pipeline}</td>
                                    <td>
                                      <div className="tag-list">
                                        {p.models.map((m, j) => {
                                          const inUse = p.modelInUseCounts[m];
                                          return (
                                            <span key={j} className="tag model" title={`${p.modelGpuCounts[m] ?? 0} GPU(s), ${inUse !== undefined ? inUse : 0} in use`}>
                                              {m} ({p.modelGpuCounts[m] ?? 0} GPU{inUse !== undefined ? `, ${inUse} inUse` : ''})
                                            </span>
                                          );
                                        })}
                                      </div>
                                    </td>
                                    <td>{p.orchCount}</td>
                                    <td>{p.gpuCount}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </section>
                      );
                    })()
                  )}

                  {/* ── Capabilities ── */}
                  {activeSubTab === 'capabilities' && (
                    (() => {
                      const caps = extractCapabilities(filteredOrchs, activeGateway.capabilities_names || {}, [HEVC_ENCODE_CAP]);
                      if (caps.length === 0) return null;
                      return (
                        <section className="capabilities-section">
                          <h3>Capabilities ({caps.length})</h3>
                          <div className="capability-list">
                            {caps.map((cap, i) => (
                              <div key={i} className="capability-item">
                                <div className="capability-header">
                                  <span className="capability-name">{cap.name}</span>
                                  <span className="capability-id">ID: {cap.id}</span>
                                </div>
                                <div className="capability-meta">
                                  <span className="capability-meta-item"><strong>Capacity:</strong> {cap.count}</span>
                                  {cap.models.length > 0 && (
                                    <span className="capability-meta-item"><strong>Models:</strong> {cap.models.length}</span>
                                  )}
                                </div>
                                {cap.models.length > 0 && (
                                  <div className="models-list">
                                    {cap.models.map((m, j) => (
                                      <span key={j} className={`model-tag ${m.warm ? 'warm' : ''}`} title={m.warm ? 'Warm (ready)' : 'Cold'}>
                                        {m.warm && <span className="warm-indicator" />}
                                        {m.name}
                                        {m.runnerVersion && <span className="runner-version">({m.runnerVersion})</span>}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </section>
                      );
                    })()
                  )}

                  {/* ── Prices ── */}
                  {activeSubTab === 'prices' && (
                    filteredOrchs.some(o => o.capabilities_prices && o.capabilities_prices.length > 0) && (() => {
                      interface PriceRow { orch: Orchestrator; price: CapabilityPrice }
                      const priceRows: PriceRow[] = [];
                      for (const orch of filteredOrchs) {
                        for (const price of orch.capabilities_prices ?? []) {
                          priceRows.push({ orch, price });
                        }
                      }
                      const sorted = applySort(priceRows, (r: PriceRow) => {
                        const s = getSort('prices');
                        switch (s.column) {
                          case 'address': return r.orch.address;
                          case 'capability': return activeGateway.capabilities_names?.[r.price.capability.toString()] ?? `ID:${r.price.capability}`;
                          case 'constraint': return r.price.constraint;
                          case 'price': return r.price.pricePerUnit;
                          case 'pixels': return r.price.pixelsPerUnit;
                          default: return r.orch.address;
                        }
                      }, getSort('prices').direction);
                      return (
                        <>
                          <h3>Capability Prices</h3>
                          <div className="table-wrapper">
                            <table className="data-table price-table">
                              <thead>
                                <tr>
                                  <SortableHeader label="Address" sortKey="address" sortState={getSort('prices')} onSort={(k) => handleSort('prices', k)} />
                                  <SortableHeader label="Capability" sortKey="capability" sortState={getSort('prices')} onSort={(k) => handleSort('prices', k)} />
                                  <SortableHeader label="Constraint" sortKey="constraint" sortState={getSort('prices')} onSort={(k) => handleSort('prices', k)} />
                                  <SortableHeader label="Price Per Unit" sortKey="price" sortState={getSort('prices')} onSort={(k) => handleSort('prices', k)} />
                                  <SortableHeader label="Pixels Per Unit" sortKey="pixels" sortState={getSort('prices')} onSort={(k) => handleSort('prices', k)} />
                                </tr>
                              </thead>
                              <tbody>
                                {sorted.map((r, ri) => (
                                  <tr key={ri}>
                                    <td className="mono small" title={r.orch.address}>
                                      {r.orch.address.slice(0, 8)}...{r.orch.address.slice(-6)}
                                    </td>
                                    <td>{activeGateway.capabilities_names?.[r.price.capability.toString()] ?? `ID:${r.price.capability}`}</td>
                                    <td className="mono small">{r.price.constraint}</td>
                                    <td className="mono">{r.price.pricePerUnit.toLocaleString()}</td>
                                    <td className="mono">{r.price.pixelsPerUnit.toLocaleString()}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      );
                    })()
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
