import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

interface AuthUser {
  username: string;
  role: string;
}

interface Region {
  id: number;
  vultr_region_id: string;
  name: string;
  city: string;
  country: string;
  continent: string;
}

interface Instance {
  id: number;
  vultr_instance_id: string;
  region_id: string;
  label: string;
  ip_address: string;
  status: string;
  last_seen_at: string | null;
}

interface JobRun {
  id: number;
  region_id: string;
  instance_id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  orch_count: number | null;
}

interface InstanceStatus {
  component: string;
  status: string;
  message: string;
  created_at: string;
}

interface Wallet {
  address: string;
  path: string;
  subfolder: string | null;
}


export default function AdminRoute() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.ok) {
        setUser(await res.json());
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const handleLogin = async (username: string, password: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password })
      });
      if (!res.ok) return false;
      const data = await res.json();
      setUser(data.user);
      return true;
    } catch {
      return false;
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include'
    });
    setUser(null);
    navigate('/');
  };

  if (loading) {
    return (
      <div className="app">
        <div className="loading" style={{ padding: '4rem 0' }}>Loading...</div>
      </div>
    );
  }

  if (!user) {
    return <AdminLogin onLogin={handleLogin} onBack={() => navigate('/')} />;
  }

  return <AdminPortal user={user} onLogout={handleLogout} />;
}

function AdminLogin({ onLogin, onBack }: { onLogin: (u: string, p: string) => Promise<boolean>; onBack: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    const ok = await onLogin(username, password);
    if (!ok) setError('Invalid username or password');
    setSubmitting(false);
  };

  return (
    <div className="login-container">
      <div className="login-box">
        <h1>Livepeer Capabilities Monitor</h1>
        <h2>Admin Login</h2>
        {error && <div className="login-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="login-field">
            <label>Username</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="login-field">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </div>
          <button type="submit" disabled={submitting}>
            {submitting ? 'Logging in...' : 'Login'}
          </button>
        </form>
        <button onClick={onBack} style={{ marginTop: 12, background: 'transparent', color: '#94a3b8' }}>
          &larr; Back to Dashboard
        </button>
      </div>
    </div>
  );
}

function ChangePassword({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }
    if (newPassword.length < 6) {
      setError('New password must be at least 6 characters');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSuccess(data.message || 'Password changed successfully');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        setError(data.detail || 'Failed to change password');
      }
    } catch (e) {
      setError('Network error');
    }
    setSubmitting(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>Change Password</h3>
        {error && <div className="info-message" style={{background: '#7f1d1d26', border: '1px solid #991b1b'}}>{error}</div>}
        {success && <div className="info-message">{success}</div>}
        <form onSubmit={handleSubmit}>
          <div className="login-field">
            <label>Current Password</label>
            <input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required />
          </div>
          <div className="login-field">
            <label>New Password</label>
            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required />
          </div>
          <div className="login-field">
            <label>Confirm New Password</label>
            <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required />
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
            <button type="submit" disabled={submitting}>{submitting ? 'Saving...' : 'Change Password'}</button>
            <button type="button" onClick={onClose} style={{ background: 'transparent', color: '#94a3b8' }}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function getLatestStatus(statuses: InstanceStatus[]): Record<string, InstanceStatus> {
  const latest: Record<string, InstanceStatus> = {};
  for (const s of statuses) {
    const existing = latest[s.component];
    if (!existing || new Date(s.created_at) > new Date(existing.created_at)) {
      latest[s.component] = s;
    }
  }
  return latest;
}

function StatusBadge({ status }: { status: string }) {
  const color = status === 'ok' || status === 'complete' || status === 'downloaded' || status === 'started'
    ? '#22c55e'
    : status === 'error' || status === 'timeout'
    ? '#ef4444'
    : status === 'pending'
    ? '#f59e0b'
    : '#94a3b8';
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 6px',
      borderRadius: '4px',
      fontSize: '0.7rem',
      fontWeight: 600,
      background: color + '22',
      color: color,
      border: `1px solid ${color}44`,
      marginRight: '4px',
      marginBottom: '2px',
      whiteSpace: 'nowrap'
    }}>
      {status}
    </span>
  );
}

function AdminPortal({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [regions, setRegions] = useState<Region[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [jobs, setJobs] = useState<JobRun[]>([]);
  const [vultrRegions, setVultrRegions] = useState<Array<{id: string; city: string; country: string; continent: string}>>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [vultrError, setVultrError] = useState('');
  const [selectedRegion, setSelectedRegion] = useState('');
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [instanceStatuses, setInstanceStatuses] = useState<Record<string, InstanceStatus[]>>({});

  // Wallet state
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [walletAddress, setWalletAddress] = useState('');
  const [walletSubfolder, setWalletSubfolder] = useState('');

  // Fetch initial data once on mount
  useEffect(() => {
    (async () => {
      try {
        const [rRes, iRes, jRes, wRes] = await Promise.all([
          fetch('/api/regions', { credentials: 'include' }),
          fetch('/api/instances', { credentials: 'include' }),
          fetch('/api/jobs', { credentials: 'include' }),
          fetch('/api/wallets', { credentials: 'include' })
        ]);
        if (rRes.ok) setRegions(await rRes.json());
        if (iRes.ok) setInstances(await iRes.json());
        if (jRes.ok) setJobs(await jRes.json());
        if (wRes.ok) {
          const wData = await wRes.json();
          setWallets(wData.wallets || []);
        }
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/vultr/regions', { credentials: 'include' });
        if (res.ok) {
          setVultrRegions(await res.json());
          setVultrError('');
        } else {
          const data = await res.json().catch(() => ({}));
          setVultrError(data.detail || `Vultr API error (${res.status})`);
        }
      } catch (e) {
        setVultrError(String(e));
      }
    })();
  }, []);

  // Poll instance statuses every 5 seconds
  useEffect(() => {
    const fetchStatuses = async () => {
      const statuses: Record<string, InstanceStatus[]> = {};
      for (const inst of instances) {
        try {
          const res = await fetch(`/api/instances/${inst.vultr_instance_id}/status`, { credentials: 'include' });
          if (res.ok) {
            const data = await res.json();
            statuses[inst.vultr_instance_id] = data.statuses || [];
          }
        } catch (e) {
          // ignore fetch errors for individual instances
        }
      }
      setInstanceStatuses(statuses);
    };

    fetchStatuses();
    const interval = setInterval(fetchStatuses, 5000);
    return () => clearInterval(interval);
  }, [instances]);

  const addRegion = async () => {
    if (!selectedRegion) return;
    const vr = vultrRegions.find(r => r.id === selectedRegion);
    if (!vr) return;
    setLoading(true);
    try {
      const res = await fetch('/api/regions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          vultr_region_id: vr.id,
          name: `${vr.city}, ${vr.country}`,
          city: vr.city,
          country: vr.country,
          continent: vr.continent
        })
      });
      if (res.ok) {
        setMessage(`Added region ${vr.city}`);
        setRegions(prev => [...prev, { id: 0, vultr_region_id: vr.id, name: `${vr.city}, ${vr.country}`, city: vr.city, country: vr.country, continent: vr.continent }]);
      } else {
        setMessage('Failed to add region');
      }
    } catch (e) {
      setMessage('Error adding region');
    }
    setLoading(false);
  };

  const removeRegion = async (id: number) => {
    if (!confirm('Remove this region?')) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/regions/${id}`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) {
        setRegions(prev => prev.filter(r => r.id !== id));
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  const createInstance = async (regionId: string) => {
    setLoading(true);
    setVultrError('');
    try {
      const res = await fetch('/api/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ region_id: regionId })
      });
      if (res.ok) {
        setMessage('Instance created');
      } else {
        const data = await res.json().catch(() => ({}));
        if (res.status === 429) setVultrError(data.detail || 'Vultr API rate limited');
        else setMessage('Failed to create instance');
      }
    } catch (e) {
      setMessage('Error creating instance');
    }
    setLoading(false);
  };

  const destroyInstance = async (instanceId: string) => {
    if (!confirm('Destroy this instance?')) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/instances/${instanceId}`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) {
        setInstances(prev => prev.filter(i => i.vultr_instance_id !== instanceId));
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  const syncInstances = async () => {
    setLoading(true);
    setVultrError('');
    try {
      const res = await fetch('/api/instances/sync', { method: 'POST', credentials: 'include' });
      if (res.ok) {
        setMessage('Synced with Vultr');
      } else {
        const data = await res.json().catch(() => ({}));
        if (res.status === 429) setVultrError(data.detail || 'Vultr API rate limited');
        else setMessage('Sync failed');
      }
    } catch (e) {
      setMessage('Sync failed');
    }
    setLoading(false);
  };

  const triggerJobs = async () => {
    setLoading(true);
    setVultrError('');
    try {
      const res = await fetch('/api/jobs/trigger', { method: 'POST', credentials: 'include' });
      if (res.ok) {
        setMessage('Jobs triggered');
      } else {
        const data = await res.json().catch(() => ({}));
        setVultrError(data.detail || 'Failed to trigger jobs');
      }
    } catch (e) {
      setMessage('Error triggering jobs');
    }
    setLoading(false);
  };

  // Wallet handlers
  const fetchWallets = async () => {
    try {
      const res = await fetch('/api/wallets', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setWallets(data.wallets || []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const addWallet = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage('');
    setVultrError('');
    if (!walletAddress.trim()) return;
    setLoading(true);
    try {
      const res = await fetch('/api/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          address: walletAddress.trim(),
          subfolder: walletSubfolder.trim() || null
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setMessage(`Wallet marker created: ${data.address}`);
        setWalletAddress('');
        setWalletSubfolder('');
        await fetchWallets();
      } else {
        setVultrError(data.detail || 'Failed to create wallet marker');
      }
    } catch (e) {
      setMessage('Error creating wallet marker');
    }
    setLoading(false);
  };

  return (
    <div className="app">
      <header>
        <h1>Admin Portal</h1>
        <div className="header-actions">
          <span style={{ color: '#94a3b8' }}>Logged in as {user.username}</span>
          <button onClick={() => setShowChangePassword(true)}>Change Password</button>
          <button onClick={onLogout}>Logout</button>
        </div>
      </header>

      {showChangePassword && <ChangePassword onClose={() => setShowChangePassword(false)} />}
      <div className="modal-body">
        {message && <div className="info-message">{message}</div>}
        {vultrError && <div className="info-message" style={{background: '#7f1d1d26', border: '1px solid #991b1b'}}>{vultrError}</div>}

        <section>
          <h3>Job Control</h3>
          <div className="admin-actions">
            <button onClick={triggerJobs} disabled={loading}>Trigger Worker Spawn (All Regions)</button>
            <span style={{color: '#94a3b8', fontSize: '0.85rem', marginLeft: 12}}>Auto-runs every 15 minutes</span>
          </div>
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr><th>Region</th><th>Instance</th><th>Status</th><th>Started</th><th>Completed</th></tr>
              </thead>
              <tbody>
                {jobs.map(j => (
                  <tr key={j.id}>
                    <td>{j.region_id}</td>
                    <td className="mono small">{j.instance_id}</td>
                    <td>{j.status}</td>
                    <td>{new Date(j.started_at).toLocaleString()}</td>
                    <td>{j.completed_at ? new Date(j.completed_at).toLocaleString() : '\u2014'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h3>Wallets</h3>
          <form onSubmit={addWallet} className="admin-form" style={{gap: 8, flexWrap: 'wrap'}}>
            <input
              type="text"
              placeholder="0x... Ethereum address"
              value={walletAddress}
              onChange={e => setWalletAddress(e.target.value)}
              style={{ minWidth: 320 }}
              required
            />
            <input
              type="text"
              placeholder="Subfolder (optional)"
              value={walletSubfolder}
              onChange={e => setWalletSubfolder(e.target.value)}
              style={{ minWidth: 160 }}
            />
            <button type="submit" disabled={loading}>Add Wallet Marker</button>
          </form>
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr><th>Address</th><th>Subfolder</th><th>Path</th></tr>
              </thead>
              <tbody>
                {wallets.length === 0 && (
                  <tr><td colSpan={3} style={{ color: '#64748b', textAlign: 'center' }}>No wallet markers found</td></tr>
                )}
                {wallets.map((w, idx) => (
                  <tr key={idx}>
                    <td className="mono small">{w.address}</td>
                    <td>{w.subfolder || '\u2014'}</td>
                    <td className="mono small" style={{ fontSize: '0.75rem' }}>{w.path}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h3>Regions</h3>
          <div className="admin-form">
            <select value={selectedRegion} onChange={e => setSelectedRegion(e.target.value)}>
              <option value="">Select Vultr region...</option>
              {vultrRegions.map(r => (
                <option key={r.id} value={r.id}>{r.city}, {r.country} ({r.continent})</option>
              ))}
            </select>
            <button onClick={addRegion} disabled={loading || !selectedRegion}>Add Region</button>
          </div>
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr><th>Region</th><th>City</th><th>Country</th><th>Action</th></tr>
              </thead>
              <tbody>
                {regions.map(r => (
                  <tr key={r.id}>
                    <td>{r.vultr_region_id}</td>
                    <td>{r.city}</td>
                    <td>{r.country}</td>
                    <td>
                      <button className="detail-link" onClick={() => removeRegion(r.id)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h3>Instances</h3>
          <div className="admin-actions">
            <button onClick={syncInstances} disabled={loading}>Sync with Vultr</button>
          </div>
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr><th>ID</th><th>Label</th><th>Region</th><th>IP</th><th>Status</th><th>Worker Status</th><th>Last Seen</th><th>Action</th></tr>
              </thead>
              <tbody>
                {instances.map(i => (
                  <tr key={i.id}>
                    <td className="mono small">{i.vultr_instance_id}</td>
                    <td>{i.label}</td>
                    <td>{i.region_id}</td>
                    <td className="mono">{i.ip_address}</td>
                    <td>{i.status}</td>
                    <td>
                      {(() => {
                        const statuses = instanceStatuses[i.vultr_instance_id] || [];
                        const latest = getLatestStatus(statuses);
                        const components = Object.values(latest).sort((a, b) => a.component.localeCompare(b.component));
                        return components.length > 0 ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', maxWidth: 220 }}>
                            {components.map(s => (
                              <span key={s.component} title={`${s.component}: ${s.message || s.status}`}>
                                <StatusBadge status={s.status} />
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span style={{ color: '#64748b', fontSize: '0.8rem' }}>No status yet</span>
                        );
                      })()}
                    </td>
                    <td>{i.last_seen_at ? new Date(i.last_seen_at).toLocaleString() : 'Never'}</td>
                    <td>
                      <button className="detail-link" onClick={() => destroyInstance(i.vultr_instance_id)}>Destroy</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {regions.length > 0 && (
            <div className="admin-form" style={{marginTop: 12}}>
              <select onChange={e => e.target.value && createInstance(e.target.value)}>
                <option value="">Create instance in region...</option>
                {regions.map(r => (
                  <option key={r.id} value={r.vultr_region_id}>{r.city}, {r.country}</option>
                ))}
              </select>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
