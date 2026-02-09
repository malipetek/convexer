import { useState, FormEvent } from 'react';
import { login } from '../api';

interface Props {
  onSuccess: () => void;
}

export default function LoginPage({ onSuccess }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(password);
      onSuccess();
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-form" onSubmit={handleSubmit}>
        <h1>Convexer</h1>
        <p>Enter password to continue</p>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          disabled={loading}
        />
        {error && <div className="login-error">{error}</div>}
        <button className="btn btn-primary" type="submit" disabled={loading || !password}>
          {loading ? 'Logging in...' : 'Login'}
        </button>
      </form>
    </div>
  );
}
