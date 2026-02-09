import { useState, useEffect } from 'react';
import InstanceList from './components/InstanceList';
import CreateDialog from './components/CreateDialog';
import LoginPage from './components/LoginPage';
import { getToken } from './api';

export default function App() {
  const [showCreate, setShowCreate] = useState(false);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    const token = getToken();
    if (!token) {
      setAuthenticated(false);
      return;
    }
    try {
      const res = await fetch('/api/instances', {
        headers: { Authorization: `Bearer ${token}` },
      });
      setAuthenticated(res.status !== 401);
    } catch {
      setAuthenticated(true); // network error, assume ok and let request layer handle it
    }
  }

  if (authenticated === null) return null; // loading
  if (!authenticated) return <LoginPage onSuccess={() => setAuthenticated(true)} />;

  return (
    <div className="app">
      <header>
        <h1>Convexer</h1>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          + New Instance
        </button>
      </header>
      <main>
        <InstanceList />
      </main>
      {showCreate && <CreateDialog onClose={() => setShowCreate(false)} />}
    </div>
  );
}
