import { useState } from 'react';
import { Plus, Trash2, Info } from 'lucide-react';
import { Topbar } from '../components/layout/Topbar';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Badge } from '../components/ui/Badge';
import { useMappingStore } from '../store/mappingStore';
import { MAPPABLE_RESOURCE_TYPES, type MappableResourceType, type MappingRule } from '../types/mapping';

const EMPTY_FORM: Omit<MappingRule, 'id'> = {
  resourceType: 'Practitioner',
  sourceId: '',
  targetId: '',
  label: '',
};

export function ResourceMapping() {
  const { rules, addRule, removeRule, clearRules } = useMappingStore();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<Omit<MappingRule, 'id'>>(EMPTY_FORM);
  const [error, setError] = useState('');

  const handleAdd = () => {
    if (!form.sourceId.trim() || !form.targetId.trim()) {
      setError('Source ID and Target ID are required.');
      return;
    }
    addRule({
      id: `map-${Date.now()}`,
      ...form,
      sourceId: form.sourceId.trim(),
      targetId: form.targetId.trim(),
      label: form.label?.trim() || undefined,
    });
    setShowAdd(false);
    setForm(EMPTY_FORM);
    setError('');
  };

  /** Split a CSV line respecting quoted fields (which may contain commas). */
  const parseCsvLine = (line: string): string[] => {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          // Check for escaped quote ("") inside a quoted field
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++; // skip the next quote
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          fields.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
    }
    fields.push(current.trim());
    return fields;
  };

  const handleCSVImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result as string;
      const lines = content.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
      const imported: MappingRule[] = [];
      for (const line of lines) {
        const fields = parseCsvLine(line);
        const resourceType = fields[0];
        const sourceId = fields[1];
        const targetId = fields[2];
        const label = fields[3];
        if (!resourceType || !sourceId || !targetId) continue;
        if (!MAPPABLE_RESOURCE_TYPES.includes(resourceType as MappableResourceType)) continue;
        imported.push({
          id: `map-${Date.now()}-${Math.random()}`,
          resourceType: resourceType as MappableResourceType,
          sourceId,
          targetId,
          label: label || undefined,
        });
      }
      if (imported.length > 0) {
        imported.forEach(addRule);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const grouped = MAPPABLE_RESOURCE_TYPES.map((rt) => ({
    rt,
    rules: rules.filter((r) => r.resourceType === rt),
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 900 }}>
      <Topbar
        title="Resource Mapping"
        subtitle="Define how references are rewritten from old to new server IDs"
        actions={
          <>
            <label style={{ cursor: 'pointer' }}>
              <span className="btn btn-secondary btn-sm">Import CSV</span>
              <input type="file" accept=".csv" style={{ display: 'none' }} onChange={handleCSVImport} />
            </label>
            {rules.length > 0 && (
              <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={clearRules}>
                Clear All
              </Button>
            )}
            <Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={() => setShowAdd(true)}>
              Add Rule
            </Button>
          </>
        }
      />

      {/* Info banner */}
      <div className="alert alert-info">
        <Info size={15} />
        <div>
          <strong>How mapping works:</strong> When migrating resources from the old server, any reference
          to a Practitioner, Location, HealthcareService, or Organization with the <em>Source ID</em> will be automatically
          rewritten to use the <em>Target ID</em> from your new server.
        </div>
      </div>

      {/* CSV format hint */}
      <Card size="sm" title="CSV Import Format">
        <code style={{ fontSize: 11, color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono, monospace)' }}>
          ResourceType,SourceId,TargetId,Label (optional)
        </code>
        <div style={{ fontSize: 11, color: 'var(--color-text-subtle)', marginTop: 4 }}>
          Example: <span style={{ fontFamily: 'monospace' }}>Practitioner,old-pract-id,new-pract-id,Dr. Smith</span>
        </div>
      </Card>

      {/* Rules by type */}
      {rules.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <Info size={28} className="empty-state-icon" />
            <div className="empty-state-title">No mapping rules defined</div>
            <div className="empty-state-desc">
              Add rules to rewrite Practitioner, Location, HealthcareService, and Organization references
              from your source server IDs to the corresponding IDs on your target server.
            </div>
            <Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={() => setShowAdd(true)}>
              Add First Rule
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {grouped.map(({ rt, rules: rtRules }) =>
            rtRules.length === 0 ? null : (
              <div key={rt} className="card" style={{ padding: 0 }}>
                <div style={{ padding: '12px 16px 8px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>{rt}</span>
                  <Badge variant="muted">{rtRules.length}</Badge>
                </div>
                <div className="table-wrapper" style={{ border: 'none', borderRadius: 0 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Source ID (Old Server)</th>
                        <th>Target ID (New Server)</th>
                        <th>Label</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rtRules.map((rule) => (
                        <tr key={rule.id}>
                          <td>
                            <span className="text-mono" style={{ fontSize: 12, color: 'var(--color-error)' }}>
                              {rule.resourceType}/{rule.sourceId}
                            </span>
                          </td>
                          <td>
                            <span className="text-mono" style={{ fontSize: 12, color: 'var(--color-success)' }}>
                              {rule.resourceType}/{rule.targetId}
                            </span>
                          </td>
                          <td style={{ color: 'var(--color-text-muted)' }}>{rule.label ?? '—'}</td>
                          <td>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => removeRule(rule.id)}
                              title="Remove rule"
                            >
                              <Trash2 size={13} />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ),
          )}
        </div>
      )}

      {/* Add rule modal */}
      <Modal
        open={showAdd}
        onClose={() => { setShowAdd(false); setError(''); setForm(EMPTY_FORM); }}
        title="Add Mapping Rule"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setShowAdd(false); setError(''); setForm(EMPTY_FORM); }}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleAdd}>
              Add Rule
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="input-group">
            <label className="input-label">Resource Type</label>
            <select
              className="select"
              value={form.resourceType}
              onChange={(e) => setForm((f) => ({ ...f, resourceType: e.target.value as MappableResourceType }))}
            >
              {MAPPABLE_RESOURCE_TYPES.map((rt) => (
                <option key={rt} value={rt}>{rt}</option>
              ))}
            </select>
          </div>
          <Input
            label="Source ID (Old Server)"
            placeholder="e.g. old-practitioner-uuid"
            value={form.sourceId}
            onChange={(e) => setForm((f) => ({ ...f, sourceId: e.target.value }))}
            mono
          />
          <Input
            label="Target ID (New Server)"
            placeholder="e.g. new-practitioner-uuid"
            value={form.targetId}
            onChange={(e) => setForm((f) => ({ ...f, targetId: e.target.value }))}
            mono
          />
          <Input
            label="Label (optional)"
            placeholder="e.g. Dr. Smith"
            value={form.label ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
          />
          {error && <div style={{ fontSize: 12, color: 'var(--color-error)' }}>{error}</div>}
        </div>
      </Modal>
    </div>
  );
}
