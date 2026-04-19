import { useState } from 'react';
import { useQueryClient, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { api, getToken, clearToken } from './api';
import LoginPage from './components/LoginPage';
import Sidebar from './components/Sidebar';
import { Button } from './components/ui/button';
import { LogOut } from 'lucide-react';
import CreateDialog from './components/CreateDialog';
import InstanceDetail from './pages/InstanceDetail';
import Home from './pages/Home';
import Settings from './pages/Settings';
import Archives from './pages/Archives';

const queryClient = new QueryClient();

function App ()
{
  const [token, setToken] = useState<string | null>(getToken());
  const [showCreate, setShowCreate] = useState(false);

  const handleLogin = () =>
  {
    setToken(getToken());
  };

  const handleLogout = () =>
  {
    clearToken();
    setToken(null);
  };

  if (!token) {
    return <LoginPage onSuccess={handleLogin} />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="flex h-screen bg-background">
          <Sidebar onCreate={() => setShowCreate(true)} />
          <div className="flex-1 flex flex-col overflow-hidden">
            <header className="border-b bg-card px-6 py-3 flex items-center justify-between">
              <div className="flex-1" />
              <Button variant="outline" size="sm" onClick={handleLogout}>
                <LogOut className="h-4 w-4 mr-2" />
                Logout
              </Button>
            </header>
            <main className="flex-1 overflow-auto">
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/instances/:id" element={<InstanceDetail />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/archives" element={<Archives />} />
                <Route path="*" element={<Navigate to="/" />} />
              </Routes>
            </main>
          </div>
          {showCreate && <CreateDialog onClose={() => setShowCreate(false)} />}
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
