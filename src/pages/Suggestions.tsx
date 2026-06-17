import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, Check, X, RefreshCw, ExternalLink } from 'lucide-react';
import TaskCard from '../components/TaskCard';
import { useTasks } from '../context/TaskContext';
import { scanNow } from '../services/gmailScan';
import type { Suggestion } from '../services/gmailSuggestions';
import type { Task } from '../types/Task';

/** Open the source message directly in the Gmail web UI. */
function gmailLink(messageId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${messageId}`;
}

/** Split a raw From header ("Jane Doe <jane@uni.edu>") into display name + address. */
function parseFrom(from: string): { name: string; email: string } {
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) {
    const email = match[2].trim();
    return { name: match[1].trim() || email, email };
  }
  const bare = from.trim();
  return { name: bare, email: bare };
}

export default function Suggestions() {
  const { suggestions, refreshSuggestions, approveSuggestion, dismissSuggestion } = useTasks();
  // Local working copy so the user can edit a suggestion before adding it. Seeded
  // from context once the scan results have loaded; per-item actions keep it in sync.
  const [items, setItems] = useState<Suggestion[]>([]);
  const [seeded, setSeeded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!seeded) {
      setItems(suggestions);
      if (suggestions.length) setSeeded(true);
    }
  }, [suggestions, seeded]);

  function editItem(updated: Task) {
    setItems((prev) =>
      prev.map((s) => (s.task.id === updated.id ? { ...s, task: updated } : s)),
    );
  }

  async function handleApprove(item: Task) {
    setBusyId(item.id);
    setError(null);
    try {
      await approveSuggestion(item);
      setItems((prev) => prev.filter((s) => s.task.id !== item.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add to schedule.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDismiss(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await dismissSuggestion(id);
      setItems((prev) => prev.filter((s) => s.task.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dismiss.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleScan() {
    setScanning(true);
    setScanMessage(null);
    setNotConnected(false);
    setError(null);
    try {
      const r = await scanNow();
      await refreshSuggestions();
      setSeeded(false); // re-seed the working copy from the freshly staged list
      setScanMessage(
        r.suggested > 0
          ? `Found ${r.suggested} new suggestion${r.suggested === 1 ? '' : 's'} to review.`
          : 'No new deadlines or events found in your recent email.',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Scan failed.';
      if (message === 'Gmail not connected') {
        setNotConnected(true);
      } else {
        setError(message);
      }
    } finally {
      setScanning(false);
    }
  }

  return (
    <section className="page review-page">
      <div className="schedule-header">
        <h1>Email suggestions</h1>
        <button type="button" className="export-button" onClick={handleScan} disabled={scanning}>
          <RefreshCw size={16} /> {scanning ? 'Scanning…' : 'Scan inbox'}
        </button>
      </div>
      <p>
        Items LazyLoad found in your recent email. Add the ones you want to your schedule and
        dismiss the rest.
      </p>

      {scanMessage && <p className="settings-meta success">{scanMessage}</p>}
      {notConnected && (
        <p className="settings-meta error">
          Gmail isn't connected. <Link to="/settings">Connect it in Settings</Link> to scan your
          inbox.
        </p>
      )}

      {items.length === 0 ? (
        <div className="schedule-empty">
          <Mail size={40} strokeWidth={1.5} />
          <p>
            No suggestions right now. Hit <strong>Scan inbox</strong> to check your recent email, or
            wait for the hourly automatic scan.
          </p>
        </div>
      ) : (
        <div className="task-list">
          {items.map((s) => (
            <div className="suggestion-row" key={s.task.id}>
              <TaskCard task={s.task} editable onChange={editItem} />
              {(s.emailFrom || s.emailSubject || s.emailSnippet) && (
                <a
                  className="gmail-card"
                  href={gmailLink(s.messageId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open this email in Gmail"
                >
                  <div className="gmail-card-bar">
                    <Mail size={14} className="gmail-card-logo" />
                    <span className="gmail-card-bar-label">Gmail</span>
                    <ExternalLink size={13} className="gmail-card-open" />
                  </div>
                  <div className="gmail-card-head">
                    {(() => {
                      const { name, email } = parseFrom(s.emailFrom ?? '');
                      const initial = (name || email || '?').charAt(0).toUpperCase();
                      return (
                        <>
                          <span className="gmail-avatar" aria-hidden>
                            {initial}
                          </span>
                          <span className="gmail-sender">
                            <span className="gmail-sender-name">{name || 'Unknown sender'}</span>
                            {email && email !== name && (
                              <span className="gmail-sender-email">{email}</span>
                            )}
                          </span>
                        </>
                      );
                    })()}
                  </div>
                  {s.emailSubject && <span className="gmail-subject">{s.emailSubject}</span>}
                  {s.emailSnippet && <span className="gmail-snippet">{s.emailSnippet}</span>}
                </a>
              )}
              <div className="suggestion-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => handleApprove(s.task)}
                  disabled={busyId === s.task.id}
                >
                  <Check size={16} /> Add to schedule
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => handleDismiss(s.task.id)}
                  disabled={busyId === s.task.id}
                >
                  <X size={16} /> Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p className="upload-error">{error}</p>}
    </section>
  );
}
