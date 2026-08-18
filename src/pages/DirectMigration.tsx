import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Play,
  Pause,
  XCircle,
  CheckCircle2,
  AlertTriangle,
  ChevronRight,
  RotateCcw,
  Trash2,
  Search,
  Loader2,
  List,
  Database,
} from 'lucide-react';
import { Topbar } from '../components/layout/Topbar';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { ProgressBar } from '../components/ui/ProgressBar';
import { ServerCard } from '../components/server/ServerCard';
import { Card } from '../components/ui/Card';
import { useServerStore } from '../store/serverStore';
import { useMigrationStore } from '../store/migrationStore';
import { useMappingStore } from '../store/mappingStore';
import { runDirectMigration, resumeDirectMigration } from '../services/migrationOrchestrator';
import { listIncompleteCheckpoints, deleteCheckpoint } from '../services/checkpointService';
import { detectPatientMappings, type PatientDetectionResult } from '../services/patientDetector';
import { savePersistentMappings, listMappingSets, deleteMappingSet, type PersistentMappingSummary } from '../services/persistentMappingStore';
import { MIGRATABLE_RESOURCE_TYPES, type FhirResourceType } from '../types/fhir';
import { computeOverallProgress, type CheckpointSummary, type MigrationJob } from '../types/migration';
import { generateReport, formatReportText } from '../services/reporter';

type Step = 'configure' | 'running' | 'done';

const STEP_LABELS: Record<Step, string> = {
  configure: 'Configure',
  running: 'Migrating',
  done: 'Complete',
};

export function DirectMigration() {
  const navigate = useNavigate();
  const { source, target, sourceStatus, targetStatus } = useServerStore();
  const { current: job, updateStatus } = useMigrationStore();
  const { rules } = useMappingStore();

  const [step, setStep] = useState<Step>('configure');
  // Captured when handleStart resolves — drives the done page so it does not
  // depend on the store surviving (e.g. HMR reloads in dev).
  const [completedJob, setCompletedJob] = useState<MigrationJob | null>(null);
  const [selected, setSelected] = useState<Set<FhirResourceType>>(
    new Set(MIGRATABLE_RESOURCE_TYPES),
  );
  const [running, setRunning] = useState(false);
  const [incompleteCheckpoints, setIncompleteCheckpoints] = useState<CheckpointSummary[]>([]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [detectionResult, setDetectionResult] = useState<PatientDetectionResult | null>(null);
  const [detectionError, setDetectionError] = useState('');
  const [migrationName, setMigrationName] = useState('');
  const [mappingSets, setMappingSets] = useState<PersistentMappingSummary[]>([]);
  const [selectedMappingSet, setSelectedMappingSet] = useState('');
  const [showMappingSets, setShowMappingSets] = useState(false);
  void running;

  // Load any incomplete checkpoints and mapping sets on mount
  useEffect(() => {
    listIncompleteCheckpoints()
      .then((cps) => setIncompleteCheckpoints(cps))
      .catch(() => setIncompleteCheckpoints([]));
    listMappingSets()
      .then((sets) => setMappingSets(sets))
      .catch(() => setMappingSets([]));
  }, []);

  // Sync step state with the active job if one is running or completed
  useEffect(() => {
    if (job) {
      if (job.status === 'done' || job.status === 'error') {
        setStep('done');
        // Capture locally so the done page survives store resets (e.g. HMR)
        setCompletedJob((prev) => prev ?? job);
        // Refresh checkpoint list — completed migrations delete their checkpoint
        listIncompleteCheckpoints().then(setIncompleteCheckpoints).catch(() => {});
        // Refresh mapping sets — the migration may have saved new mappings
        listMappingSets().then(setMappingSets).catch(() => {});
      } else if (job.status === 'cancelled' || job.status === 'idle') {
        setStep('configure');
        setCompletedJob(null);
        listIncompleteCheckpoints().then(setIncompleteCheckpoints).catch(() => {});
        listMappingSets().then(setMappingSets).catch(() => {});
      } else {
        setStep('running');
      }
    } else {
      setStep('configure');
    }
  }, [job]);

  const toggleResource = (rt: FhirResourceType) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rt)) next.delete(rt);
      else next.add(rt);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === MIGRATABLE_RESOURCE_TYPES.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(MIGRATABLE_RESOURCE_TYPES));
    }
  };

  const canStart =
    source.baseUrl &&
    target.baseUrl &&
    selected.size > 0 &&
    (sourceStatus.state === 'connected' || sourceStatus.state === 'idle') &&
    (targetStatus.state === 'connected' || targetStatus.state === 'idle');

  const handleStart = useCallback(async () => {
    setRunning(true);
    setStep('running');
    try {
      await runDirectMigration({
        source,
        target,
        resourceTypes: Array.from(selected),
        mappingRules: rules,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        migrationName: migrationName.trim() || undefined,
      });
    } finally {
      // Capture the finished job locally so the done page always renders,
      // even if the store is reset by an HMR reload in dev.
      setCompletedJob(useMigrationStore.getState().current);
      setRunning(false);
      setStep('done');
    }
  }, [source, target, selected, rules, dateFrom, dateTo, migrationName]);

  const handleDetectPatients = useCallback(async () => {
    if (!source.baseUrl || !target.baseUrl) return;
    setDetecting(true);
    setDetectionError('');
    setDetectionResult(null);
    try {
      const result = await detectPatientMappings({
        source,
        target,
        onProgress: (matched, scanned) => {
          // Update result in-place for live feedback
          setDetectionResult((prev) => ({
            ...(prev ?? { totalScanned: 0, matched: 0, notFound: 0, skipped: 0, mappings: {} }),
            totalScanned: scanned,
            matched,
          }));
        },
        shouldContinue: () => true,
      });

      // Save detected mappings to persistent store
      if (Object.keys(result.mappings).length > 0) {
        const name = migrationName.trim();
        if (name) {
          await savePersistentMappings(name, source.baseUrl, target.baseUrl, result.mappings);
          // Refresh the mapping sets list
          listMappingSets().then(setMappingSets).catch(() => {});
        }
      }

      setDetectionResult(result);
    } catch (err) {
      setDetectionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetecting(false);
    }
  }, [source, target, migrationName]);

  const handleClearDetection = () => {
    setDetectionResult(null);
    setDetectionError('');
  };

  const handleResume = useCallback(async (jobId: string) => {
    setRunning(true);
    setStep('running');
    try {
      await resumeDirectMigration(jobId, { source, target });
    } finally {
      setRunning(false);
      setCompletedJob(useMigrationStore.getState().current);
      setStep('done');
    }
  }, [source, target]);

  const handleDeleteCheckpoint = useCallback(async (jobId: string) => {
    if (window.confirm(`Are you sure you want to delete the checkpoint for job ${jobId}? This cannot be undone.`)) {
      await deleteCheckpoint(jobId);
      listIncompleteCheckpoints()
        .then((cps) => setIncompleteCheckpoints(cps))
        .catch(() => setIncompleteCheckpoints([]));
    }
  }, []);

  const handlePause = () => {
    if (job?.status === 'paused') {
      updateStatus('downloading');
    } else {
      updateStatus('paused');
    }
  };

  const handleCancel = () => {
    updateStatus('cancelled');
    setCompletedJob(null);
    setStep('configure');
    setRunning(false);
  };

  const handleDownloadReport = () => {
    const reportJob = completedJob ?? job;
    if (!reportJob) return;
    const report = generateReport(reportJob);
    const text = formatReportText(report);
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `migration-report-${reportJob.id}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const overallPct = job ? computeOverallProgress(job) : 0;
  // The job shown on the done page — local capture preferred over store
  const displayJob = completedJob ?? job;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 900 }}>
      <Topbar
        title="Direct Migration"
        subtitle="Migrate FHIR resources directly from source to target server"
      />

      {/* Resume banner — shown when there are incomplete checkpoints */}
      {step === 'configure' && incompleteCheckpoints.length > 0 && (
        <div style={{
          background: 'linear-gradient(135deg, rgba(251,191,36,0.12), rgba(245,158,11,0.08))',
          border: '1px solid rgba(251,191,36,0.35)',
          borderRadius: 12,
          padding: '16px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={18} style={{ color: '#f59e0b', flexShrink: 0 }} />
            <span style={{ fontWeight: 600, color: '#f59e0b', fontSize: 14 }}>
              Incomplete migration{incompleteCheckpoints.length > 1 ? 's' : ''} detected
            </span>
          </div>
          {incompleteCheckpoints.map((cp) => (
            <div key={cp.jobId} style={{
              background: 'rgba(0,0,0,0.15)',
              borderRadius: 8,
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontWeight: 600, fontSize: 13, fontFamily: 'monospace' }}>{cp.jobId}</span>
                <span style={{ fontSize: 12, opacity: 0.7 }}>
                  Started: {new Date(cp.startedAt).toLocaleString()} &nbsp;·&nbsp;
                  Completed: {cp.completedResourceTypes.length} resource type{cp.completedResourceTypes.length !== 1 ? 's' : ''} &nbsp;·&nbsp;
                  {cp.totalMappings.toLocaleString()} mappings saved
                </span>
                {cp.completedResourceTypes.length > 0 && (
                  <span style={{ fontSize: 11, opacity: 0.55 }}>
                    Done: {cp.completedResourceTypes.join(', ')}
                  </span>
                )}
                <span style={{ fontSize: 11, opacity: 0.55 }}>
                  {cp.sourceUrl} → {cp.targetUrl}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleResume(cp.jobId)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <RotateCcw size={14} />
                  Resume
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => handleDeleteCheckpoint(cp.jobId)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <Trash2 size={14} />
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Step indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 4 }}>
        {(Object.keys(STEP_LABELS) as Step[]).map((s, i) => (
          <div key={s} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                className={`step-dot ${step === s ? 'active' : i < (Object.keys(STEP_LABELS) as Step[]).indexOf(step) ? 'done' : 'pending'
                  }`}
              >
                {i < (Object.keys(STEP_LABELS) as Step[]).indexOf(step) ? (
                  <CheckCircle2 size={12} />
                ) : (
                  i + 1
                )}
              </div>
              <div className="step-info">
                <span className="step-title">{STEP_LABELS[s]}</span>
              </div>
            </div>
            {i < Object.keys(STEP_LABELS).length - 1 && (
              <div style={{ flex: 1, height: 1, backgroundColor: 'var(--color-border)', margin: '0 12px' }} />
            )}
          </div>
        ))}
      </div>

      {/* Configure step */}
      {step === 'configure' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Migration Name & Saved Mapping Sets */}
          <Card title="Migration Identity">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Migration name input */}
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text)' }}>
                  Migration Name
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={migrationName}
                    onChange={(e) => setMigrationName(e.target.value)}
                    placeholder='e.g. "Migrasi Klinik A Premium ke A Lite"'
                    className="input"
                    style={{ flex: 1 }}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<List size={14} />}
                    onClick={() => setShowMappingSets(!showMappingSets)}
                    disabled={mappingSets.length === 0}
                  >
                    {mappingSets.length > 0 ? `Saved (${mappingSets.length})` : 'No Saved'}
                  </Button>
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
                  Give this migration a name to persist ID mappings across runs.
                  The same name can be reused in future migrations to load previously discovered mappings.
                </div>
              </div>

              {/* Saved mapping sets list (collapsible) */}
              {showMappingSets && mappingSets.length > 0 && (
                <div style={{
                  background: 'var(--color-surface-alt)',
                  borderRadius: 8,
                  padding: 8,
                  maxHeight: 200,
                  overflowY: 'auto',
                }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, padding: '0 4px' }}>
                    Saved Mapping Sets
                  </div>
                  {mappingSets.map((set) => (
                    <div
                      key={set.name}
                      onClick={() => {
                        setMigrationName(set.name);
                        setSelectedMappingSet(set.name);
                        setShowMappingSets(false);
                      }}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '6px 8px',
                        borderRadius: 4,
                        cursor: 'pointer',
                        fontSize: 12,
                        background: selectedMappingSet === set.name || migrationName === set.name
                          ? 'var(--color-primary-muted)'
                          : 'transparent',
                        border: selectedMappingSet === set.name || migrationName === set.name
                          ? '1px solid var(--color-primary)'
                          : '1px solid transparent',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <Database size={12} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {set.name}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {set.mappingCount.toLocaleString()} mappings · updated {new Date(set.updatedAt).toLocaleDateString()}
                          </div>
                        </div>
                      </div>
                      <Button
                        variant="danger"
                        size="sm"
                        icon={<Trash2 size={10} />}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`Delete mapping set "${set.name}"?`)) {
                            deleteMappingSet(set.name).then(() => {
                              listMappingSets().then(setMappingSets).catch(() => {});
                            });
                          }
                        }}
                        style={{ flexShrink: 0, marginLeft: 4, padding: '2px 6px', fontSize: 10 }}
                      >
                        Del
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          {/* Server status */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <ServerCard role="source" onEdit={() => navigate('/settings')} />
            <ServerCard role="target" onEdit={() => navigate('/settings')} />
          </div>

          {(!source.baseUrl || !target.baseUrl) && (
            <div className="alert alert-warning">
              <AlertTriangle size={16} />
              <span>
                Please configure source and target servers in{' '}
                <button
                  style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', textDecoration: 'underline', fontSize: 'inherit' }}
                  onClick={() => navigate('/settings')}
                >
                  Settings
                </button>{' '}
                before starting migration.
              </span>
            </div>
          )}

          {/* Resource type selection */}
          <Card title="Resource Types to Migrate">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <label className="checkbox-group">
                <input
                  type="checkbox"
                  checked={selected.size === MIGRATABLE_RESOURCE_TYPES.length}
                  onChange={toggleAll}
                />
                <span className="checkbox-label" style={{ fontWeight: 600 }}>Select All</span>
              </label>
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                ({selected.size} of {MIGRATABLE_RESOURCE_TYPES.length} selected)
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {MIGRATABLE_RESOURCE_TYPES.map((rt) => (
                <label key={rt} className="checkbox-group" style={{ padding: '6px 8px', borderRadius: 4, border: '1px solid', borderColor: selected.has(rt) ? 'var(--color-primary)' : 'var(--color-border)', backgroundColor: selected.has(rt) ? 'var(--color-primary-muted)' : 'transparent', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={selected.has(rt)}
                    onChange={() => toggleResource(rt)}
                  />
                  <span className="checkbox-label">{rt}</span>
                </label>
              ))}
            </div>
          </Card>

          {/* Date Range Filter */}
          <Card title="Date Range Filter (Optional)">
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
              Only migrate resources whose <code>_lastUpdated</code> falls within the selected date range.
              Leave both fields empty to migrate all resources regardless of date.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text)' }}>
                  From Date
                </label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="input"
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text)' }}>
                  To Date
                </label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="input"
                  style={{ width: '100%' }}
                />
              </div>
            </div>
            {(dateFrom || dateTo) && (
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <CheckCircle2 size={12} style={{ color: 'var(--color-success)' }} />
                Filtering by _lastUpdated{dateFrom ? ` ≥ ${dateFrom}` : ''}{dateFrom && dateTo ? ' and' : ''}{dateTo ? ` ≤ ${dateTo}` : ''}
              </div>
            )}
          </Card>

          {/* Auto-detect Existing Patients */}
          <Card title="Auto-Detect Existing Patient Mappings">
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
              Match Patients between source and target servers by NIK identifier.
              This builds <code>Patient/{'{sourceId}'} → Patient/{'{targetId}'}</code> mappings so that
              references from new resources (Encounter, Observation, etc.) can be
              correctly rewritten even if the Patient was migrated in a previous run.
            </div>

            {!detecting && !detectionResult && !detectionError && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {!migrationName.trim() && (
                  <div className="alert alert-warning" style={{ fontSize: 12 }}>
                    <AlertTriangle size={14} />
                    <span>Enter a <strong>Migration Name</strong> above before detecting. The name is used to save and reload mappings later.</span>
                  </div>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Search size={14} />}
                  disabled={!source.baseUrl || !target.baseUrl || !migrationName.trim()}
                  onClick={handleDetectPatients}
                >
                  Detect Existing Patients
                </Button>
              </div>
            )}

            {detecting && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--color-text-muted)' }}>
                <Loader2 size={16} className="spinner" />
                <span>
                  Scanning Patients...{' '}
                  {detectionResult && (
                    <span style={{ color: 'var(--color-text)' }}>
                      {detectionResult.totalScanned} scanned, {detectionResult.matched} matched
                    </span>
                  )}
                </span>
              </div>
            )}

            {detectionError && (
              <div className="alert alert-error" style={{ marginTop: 8 }}>
                <XCircle size={16} />
                <span>{detectionError}</span>
                <Button variant="secondary" size="sm" onClick={handleClearDetection}>Dismiss</Button>
              </div>
            )}

            {detectionResult && !detecting && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="alert alert-success">
                  <CheckCircle2 size={16} />
                  <span>
                    Detection complete:{' '}
                    <strong>{detectionResult.matched}</strong> Patients matched,{' '}
                    <strong>{detectionResult.notFound}</strong> not found,{' '}
                    <strong>{detectionResult.skipped}</strong> skipped{' '}
                    (scanned {detectionResult.totalScanned} total)
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button variant="secondary" size="sm" onClick={handleDetectPatients}>
                    Re-run Detection
                  </Button>
                  <Button variant="secondary" size="sm" onClick={handleClearDetection}>
                    Clear
                  </Button>
                </div>
              </div>
            )}
          </Card>

          {/* Mapping rules summary */}
          <div className="alert alert-info">
            <CheckCircle2 size={16} />
            <span>
              {rules.length === 0
                ? 'No reference mapping rules defined. References to Practitioner/Location/HealthcareService/Organization will be left as-is.'
                : `${rules.length} mapping rule${rules.length > 1 ? 's' : ''} will be applied to rewrite references.`}
              {' '}
              <button
                style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', textDecoration: 'underline', fontSize: 'inherit' }}
                onClick={() => navigate('/mapping')}
              >
                Manage mappings →
              </button>
            </span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button
              variant="primary"
              size="lg"
              icon={<Play size={15} />}
              disabled={!canStart}
              onClick={handleStart}
            >
              Start Migration
            </Button>
          </div>
        </div>
      )}

      {/* Running step */}
      {step === 'running' && job && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Overall progress */}
          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text)' }}>{job.id}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
                  Status: <Badge variant={job.status === 'paused' ? 'warning' : 'primary'}>{job.status}</Badge>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={job.status === 'paused' ? <Play size={13} /> : <Pause size={13} />}
                  onClick={handlePause}
                >
                  {job.status === 'paused' ? 'Resume' : 'Pause'}
                </Button>
                <Button variant="danger" size="sm" icon={<XCircle size={13} />} onClick={handleCancel}>
                  Cancel
                </Button>
              </div>
            </div>
            <ProgressBar value={overallPct} showLabel height={8} />
            <div style={{ display: 'flex', gap: 20, marginTop: 10, fontSize: 12, color: 'var(--color-text-muted)' }}>
              <span>Total: {job.totals.total.toLocaleString()}</span>
              <span className="text-success">↑ {job.totals.uploaded.toLocaleString()}</span>
              <span className={job.totals.failed > 0 ? 'text-error' : ''}>✕ {job.totals.failed}</span>
              <span className="text-muted">⟳ {job.totals.skipped}</span>
            </div>
          </Card>

          {/* Per resource type */}
          <Card style={{ padding: 0 }}>
            <div className="table-wrapper" style={{ border: 'none', borderRadius: 'var(--radius-lg)' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Resource Type</th>
                    <th>Total</th>
                    <th>Uploaded</th>
                    <th>Failed</th>
                    <th>Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {(job ? job.resourceTypes : Array.from(selected)).map((rt) => {
                    const p = job.progress[rt];
                    const pct = p && p.total > 0 ? Math.round((p.uploaded / p.total) * 100) : 0;
                    return (
                      <tr key={rt}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <ChevronRight size={12} style={{ color: 'var(--color-text-subtle)' }} />
                            {rt}
                          </div>
                        </td>
                        <td>{p?.total ?? '—'}</td>
                        <td className={p?.uploaded ? 'text-success' : ''}>{p?.uploaded ?? 0}</td>
                        <td className={p?.failed ? 'text-error' : ''}>{p?.failed ?? 0}</td>
                        <td style={{ minWidth: 120 }}>
                          <ProgressBar value={pct} showLabel height={3} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* Done step */}
      {step === 'done' && displayJob && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className={`alert ${displayJob.status === 'done' ? 'alert-success' : 'alert-error'}`}>
            {displayJob.status === 'done' ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
            <div>
              <div style={{ fontWeight: 600 }}>
                {displayJob.status === 'done' ? 'Migration Completed Successfully' : 'Migration Failed'}
              </div>
              {displayJob.error && <div style={{ fontSize: 12, marginTop: 2 }}>{displayJob.error}</div>}
            </div>
          </div>

          {/* Summary */}
          <Card title="Summary">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
              {[
                { label: 'Total', value: displayJob.totals.total, color: 'var(--color-text)' },
                { label: 'Uploaded', value: displayJob.totals.uploaded, color: 'var(--color-success)' },
                { label: 'Failed', value: displayJob.totals.failed, color: displayJob.totals.failed > 0 ? 'var(--color-error)' : 'var(--color-text-muted)' },
                { label: 'Skipped', value: displayJob.totals.skipped, color: 'var(--color-text-muted)' },
              ].map((item) => (
                <div key={item.label} style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: item.color }}>{item.value.toLocaleString()}</div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{item.label}</div>
                </div>
              ))}
            </div>
          </Card>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="secondary" size="sm" onClick={handleDownloadReport}>
              Download Report
            </Button>
            <Button variant="secondary" size="sm" onClick={() => navigate('/logs')}>
              View Logs
            </Button>
            {displayJob.status === 'error' && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => handleResume(displayJob.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <RotateCcw size={14} />
                Try Again (Resume)
              </Button>
            )}
            <Button
              variant={displayJob.status === 'error' ? 'secondary' : 'primary'}
              size="sm"
              onClick={() => { setCompletedJob(null); setStep('configure'); }}
            >
              New Migration
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
