import { useState } from 'react';
import InstanceList from './components/InstanceList';
import CreateDialog from './components/CreateDialog';

export default function App() {
  const [showCreate, setShowCreate] = useState(false);

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
