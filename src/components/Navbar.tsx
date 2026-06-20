import { NavLink, Link } from 'react-router-dom';
import { CalendarCheck, CalendarDays, Plus, Inbox as InboxIcon, LogIn, LogOut, Settings } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTasks } from '../context/TaskContext';
import { useWorkingHours, countPendingSchoolReminders } from '../lib/preferences';
import Logo from './Logo';

const links = [
  { to: '/today', label: 'Today', icon: CalendarCheck },
  { to: '/schedule', label: 'Schedule', icon: CalendarDays },
];

export default function Navbar() {
  const { user, signOut } = useAuth();
  const { suggestions } = useTasks();
  const [prefs] = useWorkingHours();
  const email = user?.email ?? '';
  const initial = email ? email[0].toUpperCase() : '?';
  const suggestionCount = suggestions.length;
  // Inbox now also holds email suggestions, so its badge combines both queues.
  const inboxCount =
    countPendingSchoolReminders(prefs.overrides, prefs.dismissedReminders ?? []) + suggestionCount;

  return (
    <>
    <nav className="sidebar">
      <Link to={user ? '/today' : '/'} className="sidebar-brand">
        <Logo size={30} withWordmark />
      </Link>

      <div className="sidebar-links">
        {links.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
          >
            <Icon size={19} />
            <span className="sidebar-link-label">{label}</span>
          </NavLink>
        ))}
        {user && (
          <NavLink
            to="/inbox"
            className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
          >
            <InboxIcon size={19} />
            <span className="sidebar-link-label">Inbox</span>
            {inboxCount > 0 && <span className="sidebar-badge">{inboxCount}</span>}
          </NavLink>
        )}
      </div>

      <div className="sidebar-footer">
        {user ? (
          <>
            <NavLink
              to="/settings"
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
            >
              <Settings size={19} />
              <span className="sidebar-link-label">Settings</span>
            </NavLink>
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
    {user && (
      <Link to="/add" className="fab" aria-label="Add task or event">
        <Plus size={22} />
        <span className="fab-label">Add</span>
      </Link>
    )}
    </>
  );
}
