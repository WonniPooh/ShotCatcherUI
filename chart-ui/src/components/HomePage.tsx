import { Link } from 'react-router-dom';

export default function HomePage() {
  return (
    <div className="flex flex-col items-center justify-center h-full bg-[#0f1117] text-gray-200 gap-8">
      <h1 className="text-3xl font-bold text-white">ShotCatcher</h1>
      <p className="text-gray-400 text-sm">Binance Futures Trading System</p>
      <div className="flex gap-4">
        <Link
          to="/chart"
          className="px-6 py-3 rounded-lg bg-gray-800 border border-gray-700 hover:border-blue-500 transition-colors text-center"
        >
          <div className="text-white font-semibold text-lg">Chart</div>
          <div className="text-gray-400 text-xs mt-1">Order visualization & history</div>
        </Link>
        <Link
          to="/dashboard"
          className="px-6 py-3 rounded-lg bg-gray-800 border border-gray-700 hover:border-blue-500 transition-colors text-center"
        >
          <div className="text-white font-semibold text-lg">Dashboard</div>
          <div className="text-gray-400 text-xs mt-1">Strategy management & control</div>
        </Link>
      </div>
    </div>
  );
}
