import { useEffect, useState } from 'react';
import { CalendarDays, Check, RefreshCw, AlertTriangle, Mail, Clock } from 'lucide-react';
import { format } from 'date-fns';
import { useAuth } from '../context/AuthContext';
import {
  useWorkingHours,
  DEFAULT_WORKING_HOURS,
  WEEKDAY_LABELS,
  type WorkingHours,
} from '../lib/preferences';
import { getStatus, syncNow, disconnect, type SyncStatus, type SyncResult } from '../services/googleSync';
import {
  getStatus as getGmailStatus,
  scanNow,
  disconnect as disconnectGmail,
  type GmailStatus,
  type ScanResult,
} from '../services/gmailScan';

export default function Settings() {
  const { connectGoogleCalendar } = useAuth();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);

  async function refreshStatus() {
    try {
      setStatus(await getStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshStatus();
  }, []);

  async function handleSync() {
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      setLastResult(await syncNow());
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    setError(null);
    try {
      await disconnect();
      setLastResult(null);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect.');
    } finally {
      setBusy(false);
    }
  }

  const connected = status?.connected ?? false;

  return (
    <section className="page settings-page">
      <h1>Settings</h1>
      <WorkingHoursCard />
      <GmailCard />

      <div className="settings-card">
        <div className="settings-card-head">
          <span className="settings-card-icon" aria-hidden="true">
            <CalendarDays size={22} />
          </span>
          <div>
            <h2 className="settings-card-title">Google Calendar</h2>
            <p className="settings-card-sub">
              Two-way sync with your Google Calendar. Your tasks and events push to Google, and
              events you add or edit in Google appear here. When the same event changes in both
              places, the most recent edit wins.
            </p>
          </div>
        </div>

        {loading ? (
          <p className="settings-status">Loading…</p>
        ) : connected ? (
          <>
            <p className="settings-status connected">
              <Check size={16} /> Connected
            </p>
            {status?.lastSyncAt && (
              <p className="settings-meta">
                Last synced {format(new Date(status.lastSyncAt), "MMM d, yyyy 'at' h:mm a")}
              </p>
            )}
            {status?.lastError && (
              <p className="settings-meta error">
                <AlertTriangle size={14} /> Last sync error: {status.lastError}
              </p>
            )}
            {status?.lastImportError && (
              <p className="settings-meta error">
                <AlertTriangle size={14} /> Last import error: {status.lastImportError}
              </p>
            )}
            {lastResult && (
              <p className="settings-meta success">
                Pushed {lastResult.created} added, {lastResult.updated} updated,{' '}
                {lastResult.deleted} removed · Imported {lastResult.imported} added,{' '}
                {lastResult.updatedLocal} updated, {lastResult.deletedLocal} removed.
              </p>
            )}
            <p className="settings-meta">Syncs automatically every hour, both directions.</p>
            <div className="settings-actions">
              <button type="button" className="btn btn-primary" onClick={handleSync} disabled={busy}>
                <RefreshCw size={16} /> {busy ? 'Syncing…' : 'Sync now'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleDisconnect}
                disabled={busy}
              >
                Disconnect
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="settings-status">Not connected.</p>
            <button type="button" className="btn btn-primary" onClick={connectGoogleCalendar}>
              <CalendarDays size={16} /> Connect Google Calendar
            </button>
          </>
        )}

        {error && <p className="settings-meta error">{error}</p>}
      </div>
    </section>
  );
}

function GmailCard() {
  const { connectGmail } = useAuth();
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ScanResult | null>(null);

  async function refreshStatus() {
    try {
      setStatus(await getGmailStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshStatus();
  }, []);

  async function handleScan() {
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      setLastResult(await scanNow());
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    setError(null);
    try {
      await disconnectGmail();
      setLastResult(null);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect.');
    } finally {
      setBusy(false);
    }
  }

  const connected = status?.connected ?? false;

  return (
    <div className="settings-card">
      <div className="settings-card-head">
        <span className="settings-card-icon" aria-hidden="true">
          <Mail size={22} />
        </span>
        <div>
          <h2 className="settings-card-title">Gmail</h2>
          <p className="settings-card-sub">
            Automatically scan your recent inbox for deadlines and events. Found items wait for
            you to review under Suggestions before they're added.
          </p>
        </div>
      </div>

      {loading ? (
        <p className="settings-status">Loading…</p>
      ) : connected ? (
        <>
          <p className="settings-status connected">
            <Check size={16} /> Connected
          </p>
          {status?.lastScanAt && (
            <p className="settings-meta">
              Last scanned {format(new Date(status.lastScanAt), "MMM d, yyyy 'at' h:mm a")}
            </p>
          )}
          {status?.lastError && (
            <p className="settings-meta error">
              <AlertTriangle size={14} /> Last scan error: {status.lastError}
            </p>
          )}
          {lastResult && (
            <p className="settings-meta success">
              Scanned {lastResult.scanned} new email{lastResult.scanned === 1 ? '' : 's'} —{' '}
              {lastResult.suggested} suggestion{lastResult.suggested === 1 ? '' : 's'} to review
              {lastResult.skipped ? `, ${lastResult.skipped} already seen` : ''}.
            </p>
          )}
          <p className="settings-meta">
            Your inbox is scanned automatically every hour; new findings appear under Suggestions.
          </p>
          <div className="settings-actions">
            <button type="button" className="btn btn-primary" onClick={handleScan} disabled={busy}>
              <RefreshCw size={16} /> {busy ? 'Scanning…' : 'Scan inbox now'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleDisconnect}
              disabled={busy}
            >
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="settings-status">Not connected.</p>
          <button type="button" className="btn btn-primary" onClick={connectGmail}>
            <Mail size={16} /> Connect Gmail
          </button>
        </>
      )}

      {error && <p className="settings-meta error">{error}</p>}
    </div>
  );
}

function WorkingHoursCard() {
  const [saved, setWorkingHours] = useWorkingHours();
  const [draft, setDraft] = useState<WorkingHours>(saved);
  const [justSaved, setJustSaved] = useState(false);

  // This card is the only writer of working hours, so `draft` never drifts from
  // `saved` behind our back — no sync effect needed.
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  function set<K extends keyof WorkingHours>(key: K, value: WorkingHours[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setJustSaved(false);
  }

  function toggleWorkday(n: number) {
    set(
      'workdays',
      draft.workdays.includes(n)
        ? draft.workdays.filter((d) => d !== n)
        : [...draft.workdays, n].sort(),
    );
  }

  function save() {
    setWorkingHours(draft);
    setJustSaved(true);
  }

  return (
    <div className="settings-card">
      <div className="settings-card-head">
        <span className="settings-card-icon" aria-hidden="true">
          <Clock size={22} />
        </span>
        <div>
          <h2 className="settings-card-title">Working hours</h2>
          <p className="settings-card-sub">
            Auto-plan fits tasks into your free time — outside the work/school block, around your
            events — and never in the past. For one-off holidays or extra school days, tap a day's
            badge in the Month calendar.
          </p>
        </div>
      </div>

      <div className="hours-grid">
        <div className="hours-field">
          <span className="hours-label">Work / school days</span>
          <div className="weekday-row">
            {WEEKDAY_LABELS.map((label, n) => (
              <button
                key={label}
                type="button"
                className={`weekday-btn${draft.workdays.includes(n) ? ' active' : ''}`}
                onClick={() => toggleWorkday(n)}
                aria-pressed={draft.workdays.includes(n)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="hours-pair">
          <label className="hours-field">
            <span className="hours-label">Work / school starts</span>
            <input type="time" value={draft.workStart} onChange={(e) => set('workStart', e.target.value)} />
          </label>
          <label className="hours-field">
            <span className="hours-label">…ends</span>
            <input type="time" value={draft.workEnd} onChange={(e) => set('workEnd', e.target.value)} />
          </label>
        </div>

        <div className="hours-pair">
          <label className="hours-field">
            <span className="hours-label">Earliest you'll work</span>
            <input type="time" value={draft.dayStart} onChange={(e) => set('dayStart', e.target.value)} />
          </label>
          <label className="hours-field">
            <span className="hours-label">Latest you'll work</span>
            <input type="time" value={draft.dayEnd} onChange={(e) => set('dayEnd', e.target.value)} />
          </label>
        </div>

        <div className="hours-pair">
          <label className="hours-field">
            <span className="hours-label">Max planned per day (min)</span>
            <input
              type="number"
              min={30}
              step={15}
              value={draft.maxPerDayMinutes}
              onChange={(e) => set('maxPerDayMinutes', Math.max(30, Number(e.target.value) || 0))}
            />
          </label>
          <label className="hours-field">
            <span className="hours-label">Longest focus session (min)</span>
            <input
              type="number"
              min={30}
              step={15}
              value={draft.sessionMinutes}
              onChange={(e) => set('sessionMinutes', Math.max(30, Number(e.target.value) || 0))}
            />
          </label>
        </div>

        <div className="hours-pair">
          <label className="hours-field">
            <span className="hours-label">Break between sessions (min)</span>
            <input
              type="number"
              min={0}
              step={5}
              value={draft.breakMinutes}
              onChange={(e) => set('breakMinutes', Math.max(0, Number(e.target.value) || 0))}
            />
          </label>
        </div>

        <label className="hours-check">
          <input
            type="checkbox"
            checked={draft.spaceSessions}
            onChange={(e) => set('spaceSessions', e.target.checked)}
          />
          <span>Spread split tasks across days instead of front-loading</span>
        </label>
        <label className="hours-check">
          <input
            type="checkbox"
            checked={draft.deepWorkEarly}
            onChange={(e) => set('deepWorkEarly', e.target.checked)}
          />
          <span>Schedule higher-priority work earlier in the day</span>
        </label>
      </div>

      <div className="settings-actions">
        <button type="button" className="btn btn-primary" onClick={save} disabled={!dirty}>
          <Check size={16} /> Save hours
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setDraft(DEFAULT_WORKING_HOURS)}
        >
          Reset to defaults
        </button>
      </div>
      {justSaved && !dirty && <p className="settings-meta success">Working hours saved.</p>}
    </div>
  );
}
