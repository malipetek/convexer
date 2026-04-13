import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

export default function CreateDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [retentionDelay, setRetentionDelay] = useState('');
  const [maxConcurrentMutations, setMaxConcurrentMutations] = useState('');
  const [maxConcurrentQueries, setMaxConcurrentQueries] = useState('');
  const [rustLog, setRustLog] = useState('info');
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
    {
      const extraEnv: Record<string, string> = {};
      if (retentionDelay) extraEnv.DOCUMENT_RETENTION_DELAY = retentionDelay;
      if (maxConcurrentMutations) extraEnv.APPLICATION_MAX_CONCURRENT_MUTATIONS = maxConcurrentMutations;
      if (maxConcurrentQueries) extraEnv.APPLICATION_MAX_CONCURRENT_QUERIES = maxConcurrentQueries;
      if (rustLog !== 'info') extraEnv.RUST_LOG = rustLog;
      return api.createInstance(name || undefined, Object.keys(extraEnv).length > 0 ? extraEnv : undefined);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['instances'] });
      onClose();
    },
  });

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <h2>Create Instance</h2>
        <form
          onSubmit={e => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <label>
            Instance Name (optional)
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="my-project"
              pattern="[a-z0-9-]+"
              title="Lowercase letters, numbers, and hyphens only"
              autoFocus
            />
          </label>

          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShowAdvanced(!showAdvanced)}
            style={{ marginTop: '0.5rem', width: '100%' }}
          >
            {showAdvanced ? '− Hide Advanced Settings' : '+ Show Advanced Settings'}
          </button>

          {showAdvanced && (
            <div className="advanced-settings" style={{ marginTop: '1rem', padding: '1rem', background: '#f5f5f5', borderRadius: '4px' }}>
              <h4 style={{ margin: '0 0 0.5rem 0' }}>Advanced Settings</h4>

              <label>
                Document Retention Delay (seconds)
                <input
                  type="number"
                  value={retentionDelay}
                  onChange={e => setRetentionDelay(e.target.value)}
                  placeholder="172800 (2 days)"
                />
                <small>How long soft-deleted documents are kept before permanent removal</small>
              </label>

              <label>
                Max Concurrent Mutations
                <input
                  type="number"
                  value={maxConcurrentMutations}
                  onChange={e => setMaxConcurrentMutations(e.target.value)}
                  placeholder="16"
                />
              </label>

              <label>
                Max Concurrent Queries
                <input
                  type="number"
                  value={maxConcurrentQueries}
                  onChange={e => setMaxConcurrentQueries(e.target.value)}
                  placeholder="16"
                />
              </label>

              <label>
                Log Level (RUST_LOG)
                <select
                  value={rustLog}
                  onChange={e => setRustLog(e.target.value)}
                >
                  <option value="error">error</option>
                  <option value="warn">warn</option>
                  <option value="info">info</option>
                  <option value="debug">debug</option>
                  <option value="trace">trace</option>
                </select>
              </label>
            </div>
          )}

          {mutation.error && (
            <div className="error-message">{(mutation.error as Error).message}</div>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
              {mutation.isPending ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
