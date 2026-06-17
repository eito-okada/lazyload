import { NavLink, Link } from 'react-router-dom';
import { CalendarCheck, CalendarDays, Plus, LogIn, LogOut } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import Logo from './Logo';

const links = [
  { to: '/today', label: 'Today', icon: CalendarCheck },
  { to: '/schedule', label: 'Schedule', icon: CalendarDays },
  { to: '/add', label: 'Add', icon: Plus, primary: true },
];

export default function Navbar() {
  const { user, signOut } = useAuth();
  const email = user?.email ?? '';
  const initial = email ? email[0].toUpperCase() : '?';

  return (
    <nav className="sidebar">
      <Link to={user ? '/today' : '/'} className="sidebar-brand">
        <Logo size={30} withWordmark />
      </Link>

      <div className="sidebar-links">
        {links.map(({ to, label, icon: Icon, primary }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `sidebar-link${primary ? ' primary' : ''}${isActive ? ' active' : ''}`
            }
          >
            <Icon size={19} />
            <span className="sidebar-link-label">{label}</span>
          </NavLink>
        ))}
      </div>

      <div className="sidebar-footer">
        {user ? (
          <>
            <div className="sidebar-user">
              <span className="sidebar-avatar" aria-hidden="true">{initial}</span>
              <span className="sidebar-user-email" title={email}>{email}</span>
            </div>
            <button type="button" className="sidebar-link" onClick={signOut}>
              <LogOut size={19} />
              <span className="sidebar-link-label">Sign out</span>
            </button>
          </>
        ) : (
          <NavLink
            to="/login"
            className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
          >
            <LogIn size={19} />
            <span className="sidebar-link-label">Sign in</span>
          </NavLink>
        )}
      </div>
    </nav>
  );
}
