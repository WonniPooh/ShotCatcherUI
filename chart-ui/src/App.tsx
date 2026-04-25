import { useEffect, lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import NavBar from './components/NavBar';
import SymbolTabs from './components/SymbolTabs';
import Toolbar from './components/Toolbar';
import ChartCore from './components/ChartCore';
import DateRangePicker from './components/DateRangePicker';
import ClosedTradesPanel from './components/ClosedTradesPanel';
import OpenOrdersPanel from './components/OpenOrdersPanel';
import LoginPage from './components/LoginPage';
import { useAuthStore } from './store/authStore';
import { useChartStore } from './store/chartStore';

const DashboardPage = lazy(() => import('./components/dashboard/DashboardPage'));
const HomePage = lazy(() => import('./components/HomePage'));

function ChartView() {
  const sidebarPanel = useChartStore((s) => s.sidebarPanel);

  return (
    <div className="flex flex-col h-full w-full bg-[#0f1117]">
      <SymbolTabs />
      <Toolbar />
      <DateRangePicker />
      <div className="flex flex-1 min-h-0">
        <ChartCore />
        {sidebarPanel === 'closedTrades' && (
          <div className="w-[280px] min-w-[280px] flex-shrink-0">
            <ClosedTradesPanel />
          </div>
        )}
        {sidebarPanel === 'openOrders' && (
          <div className="w-[280px] min-w-[280px] flex-shrink-0">
            <OpenOrdersPanel />
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const { authenticated, checking, checkAuth } = useAuthStore();

  useEffect(() => { checkAuth(); }, [checkAuth]);

  if (checking) {
    return (
      <div className="flex items-center justify-center h-screen w-screen bg-[#0f1117]">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (!authenticated) {
    return <LoginPage />;
  }

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen w-screen bg-[#0f1117]">
          <div className="text-gray-400">Loading...</div>
        </div>
      }
    >
      <div className="flex flex-col h-screen w-screen bg-[#0f1117]">
        <NavBar />
        <div className="flex-1 min-h-0">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/chart" element={<ChartView />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
    </Suspense>
  );
}
