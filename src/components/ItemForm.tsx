import { useMemo, useState } from 'react';
import { CheckSquare, CalendarClock } from 'lucide-react';
import type { Task, ItemKind } from '../types/Task';

const EST_PRESETS = [15, 30, 60, 90, 120, 180, 240] as const;
const EST_LABELS: Record<number, string> = {
  15: '15 min', 30: '30 min', 60: '1 hr', 90: '1.5 hr',
  120: '2 hr', 180: '3 hr', 240: '4 hr',
};

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type Repeat = 'none' | 'daily' | 'weekly';

interface RecurrenceState {
  repeat: Repeat;
  byday: string[]; // e.g. ['MO', 'WE'] for weekly
  until: string; // 'YYYY-MM-DD' or ''
}

/** Build an RFC-5545 RRULE string from the form's recurrence state. */
function buildRrule(r: RecurrenceState): string | undefined {
  if (r.repeat === 'none') return undefined;
  const parts: string[] = [];
  parts.push(r.repeat === 'daily' ? 'FREQ=DAILY' : 'FREQ=WEEKLY');
  if (r.repeat === 'weekly' && r.byday.length > 0) parts.push(`BYDAY=${r.byday.join(',')}`);
  if (r.until) parts.push(`UNTIL=${r.until.replace(/-/g, '')}T235959Z`);
  return parts.join(';');
}

/** Parse an existing RRULE back into form state (best-effort, for editing). */
function parseRrule(rule: string | undefined): RecurrenceState {
  const base: RecurrenceState = { repeat: 'none', byday: [], until: '' };
  if (!rule) return base;
  const map = new Map(rule.split(';').map((p) => p.split('=') as [string, string]));
  const freq = map.get('FREQ');
  if (freq === 'DAILY') base.repeat = 'daily';
  else if (freq === 'WEEKLY') base.repeat = 'weekly';
  const byday = map.get('BYDAY');
  if (byday) base.byday = byday.split(',');
  const until = map.get('UNTIL');
  if (until && until.length >= 8) base.until = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`;
  return base;
}

interface ItemFormProps {
  initial?: Task;
  submitLabel?: string;
  submitting?: boolean;
  onSubmit: (item: Partial<Task>) => void;
}

export default function ItemForm({ initial, submitLabel = 'Save', submitting, onSubmit }: ItemFormProps) {
  const [kind, setKind] = useState<ItemKind>(initial?.kind ?? 'task');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [subject, setSubject] = useState(initial?.subject ?? '');

  // Estimated time: preset minutes or 'other' for freeform
  const initPreset = EST_PRESETS.includes(initial?.estimatedMinutes as typeof EST_PRESETS[number])
    ? (initial!.estimatedMinutes as number)
    : initial?.estimatedMinutes
    ? 'other' as const
    : 60;
  const [estPreset, setEstPreset] = useState<number | 'other'>(initPreset);
  const [estCustom, setEstCustom] = useState(
    initial?.estimatedMinutes && !EST_PRESETS.includes(initial.estimatedMinutes as typeof EST_PRESETS[number])
      ? String(initial.estimatedMinutes)
      : '',
  );
  const resolvedEstMin =
    estPreset === 'other' ? (parseInt(estCustom, 10) || undefined) : estPreset;

  // Task fields
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? '');
  const [dueTime, setDueTime] = useState(initial?.dueTime ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');

  // Event fields. Stored datetimes are floating wall-clock and may carry seconds/
  // offset from the timestamptz round-trip ("…T14:00:00+00:00"); a datetime-local
  // input wants exactly "YYYY-MM-DDTHH:mm", so trim to those leading characters.
  const toLocalInput = (s?: string) => (s ? s.slice(0, 16) : '');
  const [allDay, setAllDay] = useState(initial?.allDay ?? false);
  const [startAt, setStartAt] = useState(toLocalInput(initial?.startAt));
  const [endAt, setEndAt] = useState(toLocalInput(initial?.endAt));
  const [location, setLocation] = useState(initial?.location ?? '');
  const [rec, setRec] = useState<RecurrenceState>(() => parseRrule(initial?.recurrenceRule));

  const startDateOnly = useMemo(() => (startAt ? startAt.slice(0, 10) : ''), [startAt]);

  function toggleByday(code: string) {
    setRec((prev) => ({
      ...prev,
      byday: prev.byday.includes(code)
        ? prev.byday.filter((d) => d !== code)
        : [...prev.byday, code],
    }));
  }

  const canSubmit =
    title.trim().length > 0 && (kind === 'task' ? true : startAt.length > 0) && !submitting;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    if (kind === 'task') {
      onSubmit({
        kind: 'task',
        title: title.trim(),
        subject: subject.trim() || undefined,
        estimatedMinutes: resolvedEstMin,
        dueDate: dueDate || undefined,
        dueTime: dueTime || undefined,
        notes: notes.trim() || undefined,
      });
    } else {
      const start = allDay ? `${startDateOnly}T00:00` : startAt;
      const end = allDay ? `${startDateOnly}T23:59` : endAt || undefined;
      onSubmit({
        kind: 'event',
        title: title.trim(),
        subject: subject.trim() || undefined,
        allDay,
        startAt: start,
        endAt: end,
        location: location.trim() || undefined,
        recurrenceRule: buildRrule(rec),
      });
    }
  }

  return (
    <form className="item-form" onSubmit={handleSubmit}>
      <div className="kind-toggle" role="tablist" aria-label="Item type">
        <button
          type="button"
          role="tab"
          aria-selected={kind === 'task'}
          className={kind === 'task' ? 'active' : ''}
          onClick={() => setKind('task')}
        >
          <CheckSquare size={16} /> Task
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={kind === 'event'}
          className={kind === 'event' ? 'active' : ''}
          onClick={() => setKind('event')}
        >
          <CalendarClock size={16} /> Event
        </button>
      </div>

      <label className="form-field">
        <span>Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={kind === 'task' ? 'e.g. Physics problem set' : 'e.g. AP Bio lecture'}
          autoFocus
        />
      </label>

      <label className="form-field">
        <span>Subject</span>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Physics" />
      </label>

      {kind === 'task' ? (
        <div className="form-row">
          <label className="form-field">
            <span>Due date</span>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
          <label className="form-field">
            <span>Due time</span>
            <input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
          </label>
        </div>
      ) : (
        <>
          <label className="form-check">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
            <span>All day</span>
          </label>
          {allDay ? (
            <label className="form-field">
              <span>Date</span>
              <input
                type="date"
                value={startDateOnly}
                onChange={(e) => setStartAt(e.target.value ? `${e.target.value}T00:00` : '')}
              />
            </label>
          ) : (
            <div className="form-row">
              <label className="form-field">
                <span>Starts</span>
                <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
              </label>
              <label className="form-field">
                <span>Ends</span>
                <input type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} />
              </label>
            </div>
          )}
          <label className="form-field">
            <span>Location</span>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Room 204 / Zoom link"
            />
          </label>

          <label className="form-field">
            <span>Repeats</span>
            <select
              value={rec.repeat}
              onChange={(e) => setRec((p) => ({ ...p, repeat: e.target.value as Repeat }))}
            >
              <option value="none">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>

          {rec.repeat === 'weekly' && (
            <div className="weekday-picker">
              {WEEKDAYS.map((code, i) => (
                <button
                  type="button"
                  key={code}
                  className={rec.byday.includes(code) ? 'active' : ''}
                  onClick={() => toggleByday(code)}
                  aria-pressed={rec.byday.includes(code)}
                >
                  {WEEKDAY_LABELS[i].slice(0, 1)}
                </button>
              ))}
            </div>
          )}

          {rec.repeat !== 'none' && (
            <label className="form-field">
              <span>Until (optional)</span>
              <input
                type="date"
                value={rec.until}
                onChange={(e) => setRec((p) => ({ ...p, until: e.target.value }))}
              />
            </label>
          )}
          <p className="form-hint">Editing or deleting a repeating event affects the whole series.</p>
        </>
      )}

      {kind === 'task' && (
        <div className="form-field">
          <span>Estimated time</span>
          <div className="est-time-picker">
            <select
              value={estPreset}
              onChange={(e) => setEstPreset(e.target.value === 'other' ? 'other' : Number(e.target.value))}
            >
              {EST_PRESETS.map((m) => (
                <option key={m} value={m}>{EST_LABELS[m]}</option>
              ))}
              <option value="other">Other…</option>
            </select>
            {estPreset === 'other' && (
              <input
                type="number"
                min={5}
                max={600}
                step={5}
                placeholder="minutes"
                value={estCustom}
                onChange={(e) => setEstCustom(e.target.value)}
                className="est-custom-input"
              />
            )}
          </div>
        </div>
      )}

      {kind === 'task' && (
        <label className="form-field">
          <span>Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Problems 3–18, show your work"
            rows={3}
            className="form-textarea"
          />
        </label>
      )}

      <button type="submit" className="cta-button" disabled={!canSubmit}>
        {submitting ? 'Saving…' : submitLabel}
      </button>
    </form>
  );
}
