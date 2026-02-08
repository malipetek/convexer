import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

export default function CreateDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => api.createInstance(name || undefined),
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
