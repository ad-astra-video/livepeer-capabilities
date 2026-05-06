import { useState, useEffect, useCallback, useMemo } from 'react';
import type { GPUComputeInfo, Orchestrator } from './types';

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
}

function extractPipelines(orchs: Orchestrator[], filterByAdvertised: boolean = false): PipelineInfo[] {
  const byPipeline = new Map<string, { models: Set<string>; orchs: Set<string>; gpuCount: number; modelGpuCounts: Map<string, number> }>();
  for (const orch of orchs) {
    if (!orch.hardware) continue;
    const advertisedModels = filterByAdvertised ? getAdvertisedModels(orch) : null;
    for (const hw of orch.hardware) {
      if (filterByAdvertised && advertisedModels && advertisedModels.size > 0 && !advertisedModels.has(hw.model_id)) continue;
      const p = hw.pipeline || 'unknown';
      const existing = byPipeline.get(p) || { models: new Set<string>(), orchs: new Set<string>(), gpuCount: 0, modelGpuCounts: new Map<string, number>() };
      if (hw.model_id) {
        existing.models.add(hw.model_id);
        const gpuCountForHw = hw.gpu_info ? Object.keys(hw.gpu_info).length : 0;
        existing.modelGpuCounts.set(hw.model_id, (existing.modelGpuCounts.get(hw.model_id) || 0) + gpuCountForHw);
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
            if (modelInfo.capacityInUse !== undefined) existing.capacityInUse = modelInfo.capacityInUse;
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

export default function Dashboard() {
  const [gatewayData, setGatewayData] = useState<Record<string, GatewayData>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [activeTab, setActiveTab] = useState<string>('transcoding');
  const [showDupModal, setShowDupModal] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState<string>('');
  const [searchText, setSearchText] = useState<string>('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/capabilities/aggregated');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const byType: Record<string, GatewayData> = {};
      for (const gw of json.gateways || []) {
        byType[gw.gateway_type] = gw;
      }
      setGatewayData(byType);
      setLastUpdated(new Date());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
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
          <input
            type="text"
            className="search-input"
            placeholder="Search (address, URI, GPU, model, pipeline, region)..."
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
          />
          <button onClick={fetchData} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
          {lastUpdated && (
            <span className="last-updated">
              Last updated: {lastUpdated.toLocaleTimeString()}
            </span>
          )}
        </div>
      </header>

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
            const orchCount = data?.orchestrators?.length || 0;
            const gpuCount = gw.key === 'transcoding'
              ? countHEVCEncode(data?.orchestrators || [])
              : analyzeGPUs(extractGPUs(data?.orchestrators || [], gw.key)).totalUniqueCount;
            return (
              <button
                key={gw.key}
                className={`tab ${activeTab === gw.key ? 'active' : ''}`}
                onClick={() => setActiveTab(gw.key)}
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

        <div className="tab-content">
          {loading && <div className="loading">Loading...</div>}
          {error && (
            <div className="error">
              <strong>Error:</strong> {error}
            </div>
          )}

          {!loading && !error && activeGateway && (
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

                  {activeTab === 'transcoding' ? (
                    <section className="pipeline-details">
                      <h3>GPU Transcoders</h3>
                      <div className="table-wrapper">
                        <table className="data-table">
                          <thead>
                            <tr><th>Address</th><th>URI</th><th>HEVC Encode Capacity</th><th>Regions</th></tr>
                          </thead>
                          <tbody>
                            {filteredOrchs.map((orch, i) => {
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
                    <>
                      {(() => {
                        const pipelines = extractPipelines(filteredOrchs, true);
                        if (pipelines.length === 0) return null;
                        return (
                          <section className="pipeline-details">
                            <h3>Pipelines</h3>
                            <div className="table-wrapper">
                              <table className="data-table pipeline-table">
                                <thead>
                                  <tr><th>Pipeline</th><th>Models (GPUs)</th><th>Orchs</th><th>Total GPUs</th></tr>
                                </thead>
                                <tbody>
                                  {pipelines.map((p, i) => (
                                    <tr key={i}>
                                      <td className="mono">{p.pipeline}</td>
                                      <td>
                                        <div className="tag-list">
                                          {p.models.map((m, j) => (
                                            <span key={j} className="tag model" title={`${p.modelGpuCounts[m] ?? 0} GPU(s)`}>
                                              {m} ({p.modelGpuCounts[m] ?? 0})
                                            </span>
                                          ))}
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
                      })()}

                      <h3>Orchestrators</h3>
                      <div className="table-wrapper">
                        <table className="data-table orchestrators-table">
                          <thead>
                            <tr><th>Address</th><th>URI</th><th>Version</th><th>Capabilities</th><th>Models</th><th>GPUs</th><th>Regions</th></tr>
                          </thead>
                          <tbody>
                            {filteredOrchs.map((orch, i) => {
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

                      {activeAnalysis.totalUniqueCount > 0 && (
                        <>
                          <h3>GPU Details</h3>
                          <div className="table-wrapper">
                            <table className="data-table gpu-table">
                              <thead>
                                <tr>
                                  <th>Address</th><th>Pipeline</th><th>Model</th>
                                  <th>GPU ID</th><th>GPU Name</th><th>Compute</th>
                                  <th>Memory Total</th><th>Memory Free</th><th>Regions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {filteredOrchs.map((orch, oi) => {
                                  const advertisedModels = getAdvertisedModels(orch);
                                  return (orch.hardware ?? []).map((hw, hi) => {
                                    if (advertisedModels.size > 0 && !advertisedModels.has(hw.model_id)) return null;
                                    return Object.values(hw.gpu_info ?? {}).map((gpu, gi) => (
                                      <tr key={`${oi}-${hi}-${gi}`}>
                                        <td className="mono small" title={orch.address}>
                                          {orch.address.slice(0, 8)}...{orch.address.slice(-6)}
                                        </td>
                                        <td>{hw.pipeline || '\u2014'}</td>
                                        <td>{hw.model_id || '\u2014'}</td>
                                        <td className="mono">{gpu.id.slice(0, 24)}...</td>
                                        <td>{gpu.name || 'Unknown'}</td>
                                        <td>{gpu.major}</td>
                                        <td>{formatBytes(gpu.memory_total)}</td>
                                        <td>{formatBytes(gpu.memory_free)}</td>
                                        <td>
                                          <div className="tag-list">
                                            {(orch.regions || []).map(r => (
                                              <span key={r} className="tag region" title={`${allRegionDetails[r]?.city || ''} ${allRegionDetails[r]?.country || ''}`}>{r.toUpperCase()}</span>
                                            ))}
                                          </div>
                                        </td>
                                      </tr>
                                    ));
                                  });
                                })}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}

                      {filteredOrchs.some(o => o.capabilities_prices && o.capabilities_prices.length > 0) && (
                        <>
                          <h3>Capability Prices</h3>
                          <div className="table-wrapper">
                            <table className="data-table price-table">
                              <thead>
                                <tr><th>Address</th><th>Capability</th><th>Constraint</th><th>Price Per Unit</th><th>Pixels Per Unit</th></tr>
                              </thead>
                              <tbody>
                                {filteredOrchs.map((orch, oi) =>
                                  (orch.capabilities_prices ?? []).map((price, pi) => (
                                    <tr key={`${oi}-${pi}`}>
                                      <td className="mono small" title={orch.address}>
                                        {orch.address.slice(0, 8)}...{orch.address.slice(-6)}
                                      </td>
                                      <td>{activeGateway.capabilities_names?.[price.capability.toString()] ?? `ID:${price.capability}`}</td>
                                      <td className="mono small">{price.constraint}</td>
                                      <td className="mono">{price.pricePerUnit.toLocaleString()}</td>
                                      <td className="mono">{price.pixelsPerUnit.toLocaleString()}</td>
                                    </tr>
                                  ))
                                )}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}

                      {(() => {
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
                      })()}
                    </>
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
