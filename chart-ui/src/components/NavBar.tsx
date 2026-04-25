import { NavLink } from 'react-router-dom';

const links = [
  { to: '/', label: 'Home' },
  { to: '/chart', label: 'Chart' },
  { to: '/dashboard', label: 'Dashboard' },
] as const;

export default function NavBar() {
  return (
    <nav className="flex items-center gap-1 px-4 py-1.5 bg-[#0f1117] border-b border-gray-800 shrink-0">
      <span className="text-white font-bold text-sm mr-4 tracking-wide">ShotCatcher</span>
      {links.map(({ to, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) =>
            `px-3 py-1 text-xs rounded transition-colors ${
              isActive
                ? 'bg-blue-600 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`
          }
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
