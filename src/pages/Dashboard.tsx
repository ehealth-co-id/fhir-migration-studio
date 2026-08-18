import { useNavigate } from 'react-router-dom';
import {
  Database,
  CheckCircle2,
  XCircle,
  Clock,
  ArrowRightLeft,
  Download,
  Upload,
  GitCompare,
  Search,
} from 'lucide-react';
import { Topbar } from '../components/layout/Topbar';
import { StatCard } from '../components/ui/Card';
import { ServerCard } from '../components/server/ServerCard';
import { ProgressBar } from '../components/ui/ProgressBar';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { useMigrationStore } from '../store/migrationStore';
import { useLogStore } from '../store/logStore';
import { useExportStore } from '../store/exportStore';
import { useImportStore } from '../store/importStore';
import { computeOverallProgress } from '../types/migration';
import { MIGRATABLE_RESOURCE_TYPES } from '../types/fhir';
import type { FhirResourceType } from '../types/fhir';

const RESOURCE_ICONS: Partial<Record<FhirResourceType, string>> = {
  Patient: '👤',
  Appointment: '📅',
  Encounter: '🏥',
  Composition: '📄',
  Observation: '🔬',
  Condition: '⚕️',
  Specimen: '🧪',
  Immunization: '💉',
};

export function Dashboard() {
  const navigate = useNavigate();
  const { current: job, history } = useMigrationStore();
  const { entries: logs } = useLogStore();

  const { running: exportRunning, progress: exportProgress, selected: exportSelected } = useExportStore();
  const { uploadState: importState, fileName: importFileName } = useImportStore();
  const importRunning = importState.status === 'uploading';

  const activeJob = job?.status !== 'done' && job?.status !== 'idle' && job?.status !== 'error' && job?.status !== 'cancelled' ? job : null;
  const lastJob = history[0] ?? null;

  const activeCount = (activeJob ? 1 : 0) + (exportRunning ? 1 : 0) + (importRunning ? 1 : 0);

  let progressSub = 'No active operations';
  if (activeJob) progressSub = 'Direct migration running';
  else if (exportRunning) progressSub = 'NDJSON export running';
  else if (importRunning) progressSub = 'NDJSON import running';

  // Compute export percentage progress
  const exportTotal = exportSelected.length;
  const exportDone = Object.values(exportProgress).filter((p) => p?.status === 'done' || p?.status === 'error').length;
  const exportPct = exportTotal > 0 ? Math.round((exportDone / exportTotal) * 100) : 0;

  const totals = lastJob?.totals ?? { total: 0, uploaded: 0, failed: 0, skipped: 0 };
  const overallPct = lastJob ? computeOverallProgress(lastJob) : 0;

  const recentLogs = logs.slice(0, 8);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Topbar
        title="Dashboard"
        subtitle="Overview of migration activities"
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => navigate('/settings')}>
              Connection Test
            </Button>
            <Button variant="primary" size="sm" icon={<ArrowRightLeft size={13} />} onClick={() => navigate('/migrate')}>
              New Migration
            </Button>
          </>
        }
      />

      {/* Stats */}
      <div className="grid-stats">
        <StatCard
          icon={<Database size={18} color="var(--color-primary)" />}
          iconBg="var(--color-primary-muted)"
          value={totals.total}
          label="Total Resources"
          sub="All resource types"
        />
        <StatCard
          icon={<CheckCircle2 size={18} color="var(--color-success)" />}
          iconBg="var(--color-success-muted)"
          value={totals.uploaded}
          label="Successfully Migrated"
          sub={totals.total > 0 ? `${overallPct}% Success` : '—'}
          valueColor="var(--color-success)"
        />
        <StatCard
          icon={<XCircle size={18} color="var(--color-error)" />}
          iconBg="var(--color-error-muted)"
          value={totals.failed}
          label="Failed"
          sub={totals.total > 0 ? `${Math.round((totals.failed / totals.total) * 100)}% Failed` : '—'}
          valueColor={totals.failed > 0 ? 'var(--color-error)' : undefined}
        />
        <StatCard
          icon={<Clock size={18} color="var(--color-warning)" />}
          iconBg="var(--color-warning-muted)"
          value={activeCount}
          label="In Progress"
          sub={progressSub}
          valueColor={activeCount > 0 ? 'var(--color-warning)' : undefined}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 20 }}>
        {/* Left: Progress + History */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Active jobs */}
          {(activeJob || exportRunning || importRunning) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {activeJob && (
                <div className="card">
                  <div className="card-title">Active Direct Migration</div>
                  <div style={{ marginBottom: 4 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontSize: 13, color: 'var(--color-text)' }}>{activeJob.id}</span>
                      <Badge variant="warning">{activeJob.status}</Badge>
                    </div>
                    <ProgressBar value={computeOverallProgress(activeJob)} showLabel height={6} />
                  </div>
                </div>
              )}
              {exportRunning && (
                <div className="card">
                  <div className="card-title">Active NDJSON Export</div>
                  <div style={{ marginBottom: 4 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontSize: 13, color: 'var(--color-text)' }}>Exporting {exportDone}/{exportTotal} resource types</span>
                      <Badge variant="warning">Exporting</Badge>
                    </div>
                    <ProgressBar value={exportPct} showLabel height={6} />
                  </div>
                </div>
              )}
              {importRunning && (
                <div className="card">
                  <div className="card-title">Active NDJSON Import</div>
                  <div style={{ marginBottom: 4 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontSize: 13, color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>
                        Importing: {importFileName}
                      </span>
                      <Badge variant="warning">Importing</Badge>
                    </div>
                    <ProgressBar value={importState.progress} showLabel height={6} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Migration progress table */}
          {lastJob && (
            <div className="card" style={{ padding: 0 }}>
              <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--color-border)' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>
                  Migration Progress
                </span>
                {lastJob && (
                  <span style={{ fontSize: 11, color: 'var(--color-text-muted)', marginLeft: 8 }}>
                    {lastJob.id}
                  </span>
                )}
              </div>
              <div className="table-wrapper" style={{ border: 'none', borderRadius: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Resource Type</th>
                      <th>Total</th>
                      <th>Success</th>
                      <th>Failed</th>
                      <th>Progress</th>
                    </tr>
                  </thead>
                  <tbody>
                    {MIGRATABLE_RESOURCE_TYPES.map((rt) => {
                      const p = lastJob.progress[rt];
                      if (!p) return null;
                      const pct = p.total > 0 ? Math.round((p.uploaded / p.total) * 100) : 0;
                      return (
                        <tr key={rt}>
                          <td>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span>{RESOURCE_ICONS[rt] ?? '📦'}</span>
                              {rt}
                            </span>
                          </td>
                          <td>{p.total.toLocaleString()}</td>
                          <td className="text-success">{p.uploaded.toLocaleString()}</td>
                          <td className={p.failed > 0 ? 'text-error' : ''}>{p.failed}</td>
                          <td style={{ minWidth: 120 }}>
                            <ProgressBar value={pct} showLabel height={3} />
                          </td>
                        </tr>
                      );
                    })}
                    <tr style={{ fontWeight: 600 }}>
                      <td>Total</td>
                      <td>{totals.total.toLocaleString()}</td>
                      <td className="text-success">{totals.uploaded.toLocaleString()}</td>
                      <td className={totals.failed > 0 ? 'text-error' : ''}>{totals.failed}</td>
                      <td><ProgressBar value={overallPct} showLabel height={3} /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!lastJob && (
            <div className="card">
              <div className="empty-state">
                <ArrowRightLeft size={32} className="empty-state-icon" />
                <div className="empty-state-title">No migrations yet</div>
                <div className="empty-state-desc">
                  Configure your servers in Settings, then start a Direct Migration.
                </div>
                <Button variant="primary" size="sm" onClick={() => navigate('/migrate')}>
                  Start Migration
                </Button>
              </div>
            </div>
          )}

          {/* Quick actions */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--color-text)' }}>
              Quick Actions
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
              {[
                { icon: <ArrowRightLeft size={18} />, label: 'Direct Migration', sub: 'Server to server', to: '/migrate', color: 'var(--color-primary)' },
                { icon: <Download size={18} />, label: 'Export NDJSON', sub: 'Download from server', to: '/export', color: 'var(--color-success)' },
                { icon: <Upload size={18} />, label: 'Import NDJSON', sub: 'Upload to server', to: '/import', color: '#8957e5' },
                { icon: <GitCompare size={18} />, label: 'Mapping', sub: 'Manage reference maps', to: '/mapping', color: 'var(--color-warning)' },
                { icon: <Search size={18} />, label: 'FHIR Explorer', sub: 'Browse resources', to: '/explorer', color: 'var(--color-info)' },
              ].map((action) => (
                <button
                  key={action.to}
                  className="card"
                  style={{ cursor: 'pointer', textAlign: 'left', border: '1px solid var(--color-border)', transition: 'border-color 150ms', background: 'none' }}
                  onClick={() => navigate(action.to)}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = action.color)}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--color-border)')}
                >
                  <div style={{ color: action.color, marginBottom: 8 }}>{action.icon}</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text)', marginBottom: 2 }}>{action.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{action.sub}</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              FHIR Server Connection
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <ServerCard role="source" onEdit={() => navigate('/settings')} />
              <ServerCard role="target" onEdit={() => navigate('/settings')} />
            </div>
          </div>

          {/* Recent logs */}
          <div className="card" style={{ padding: 0, flex: 1 }}>
            <div style={{ padding: '12px 14px 8px', borderBottom: '1px solid var(--color-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text)' }}>Recent Logs</span>
              <Button variant="ghost" size="sm" onClick={() => navigate('/logs')}>View All</Button>
            </div>
            {recentLogs.length > 0 ? (
              <div style={{ padding: '6px 0' }}>
                {recentLogs.map((entry) => (
                  <div
                    key={entry.id}
                    style={{ padding: '6px 14px', display: 'flex', alignItems: 'flex-start', gap: 8, borderBottom: '1px solid var(--color-border-subtle)' }}
                  >
                    <span style={{
                      fontSize: 9,
                      fontWeight: 700,
                      padding: '2px 5px',
                      borderRadius: 10,
                      backgroundColor:
                        entry.level === 'error' ? 'var(--color-error-muted)' :
                        entry.level === 'success' ? 'var(--color-success-muted)' :
                        entry.level === 'warn' ? 'var(--color-warning-muted)' :
                        'var(--color-surface-3)',
                      color:
                        entry.level === 'error' ? 'var(--color-error)' :
                        entry.level === 'success' ? 'var(--color-success)' :
                        entry.level === 'warn' ? 'var(--color-warning)' :
                        'var(--color-text-muted)',
                      flexShrink: 0,
                      marginTop: 1,
                    }}>
                      {entry.level.toUpperCase()}
                    </span>
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <div style={{ fontSize: 12, color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {entry.message}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--color-text-subtle)', marginTop: 1 }}>
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state" style={{ padding: 24 }}>
                <div className="empty-state-desc">No activity yet</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
