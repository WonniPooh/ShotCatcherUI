/**
 * LoginPage — full-screen login form shown when auth is enabled and user is not authenticated.
 */
import { useState, type FormEvent } from 'react';
import { useAuthStore } from '../store/authStore';

export default function LoginPage() {
  const login = useAuthStore(s => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const err = await login(username, password);
    setLoading(false);
    if (err) setError(err);
  };

  return (
    <div className="flex items-center justify-center h-screen w-screen bg-[#0f1117]">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 p-8 bg-[#1a1d27] rounded-lg shadow-xl w-80"
      >
        <h1 className="text-xl font-bold text-white text-center mb-2">ShotCatcher</h1>

        {error && (
          <div className="text-red-400 text-sm text-center bg-red-900/20 rounded px-3 py-2">
            {error}
          </div>
        )}

        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={e => setUsername(e.target.value)}
          autoComplete="username"
          className="px-3 py-2 bg-[#0f1117] text-white border border-[#2a2d3a] rounded
                     focus:outline-none focus:border-blue-500 placeholder-gray-500"
          required
        />

        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete="current-password"
          className="px-3 py-2 bg-[#0f1117] text-white border border-[#2a2d3a] rounded
                     focus:outline-none focus:border-blue-500 placeholder-gray-500"
          required
        />

        <button
          type="submit"
          disabled={loading || !username || !password}
          className="px-4 py-2 bg-blue-600 text-white rounded font-medium
                     hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed
                     transition-colors"
        >
          {loading ? 'Logging in...' : 'Log In'}
        </button>
      </form>
    </div>
  );
}
