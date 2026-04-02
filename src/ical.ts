export interface VEvent {
  uid: string;
  summary: string;
  dtstart: string; // ISO 8601
  dtend: string;   // ISO 8601
  description?: string;
  location?: string;
  rrule?: string;
  status?: string;
  sequence: number;
  allDay: boolean;
}

export interface VTodo {
  uid: string;
  summary: string;
  description?: string;
  due?: string; // ISO 8601 date
  priority?: number; // 0–9; 0 = undefined, 1 = highest
  status: string;    // NEEDS-ACTION | IN-PROCESS | COMPLETED | CANCELLED
  percentComplete?: number;
  completed?: string; // ISO 8601 UTC datetime
  sequence: number;
}

// ---- iCal text helpers ----

function unfoldLines(raw: string): string[] {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .filter(l => l.length > 0);
}

function parseProp(line: string): { name: string; params: string; value: string } | null {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;
  const nameAndParams = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const semiIdx = nameAndParams.indexOf(';');
  if (semiIdx === -1) return { name: nameAndParams, params: '', value };
  return { name: nameAndParams.slice(0, semiIdx), params: nameAndParams.slice(semiIdx + 1), value };
}

function unescapeValue(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\N/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function escapeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [line.slice(0, 75)];
  let i = 75;
  while (i < line.length) {
    parts.push(' ' + line.slice(i, i + 74));
    i += 74;
  }
  return parts.join('\r\n');
}

function extractBlock(lines: string[], begin: string, end: string): string[] | null {
  const startIdx = lines.findIndex(l => l === begin);
  if (startIdx === -1) return null;
  const endIdx = lines.findIndex((l, i) => i > startIdx && l === end);
  if (endIdx === -1) return null;
  return lines.slice(startIdx + 1, endIdx);
}

function buildPropMap(lines: string[]): Map<string, { value: string; params: string }> {
  const map = new Map<string, { value: string; params: string }>();
  for (const line of lines) {
    const prop = parseProp(line);
    if (!prop || map.has(prop.name)) continue;
    map.set(prop.name, { value: unescapeValue(prop.value), params: prop.params });
  }
  return map;
}

// ---- Date conversion ----

export function parseIcalDate(icalValue: string): string {
  const isUtc = icalValue.endsWith('Z');
  const v = icalValue.replace(/Z$/, '');
  if (v.length === 8) {
    return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  }
  const date = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  const time = `${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}`;
  return `${date}T${time}${isUtc ? 'Z' : ''}`;
}

export function formatIcalDate(iso: string, allDay: boolean): string {
  if (allDay) return iso.slice(0, 10).replace(/-/g, '');
  const normalized = iso.endsWith('Z') ? iso : `${iso}Z`;
  return new Date(normalized).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function nowUtc(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// ---- Parsing ----

export function parseVEvent(icsContent: string): VEvent | null {
  const lines = unfoldLines(icsContent);
  const block = extractBlock(lines, 'BEGIN:VEVENT', 'END:VEVENT');
  if (!block) return null;

  const props = buildPropMap(block);
  const uid = props.get('UID')?.value;
  const summary = props.get('SUMMARY')?.value;
  const dtstartProp = props.get('DTSTART');
  const dtendProp = props.get('DTEND');
  if (!uid || !summary || !dtstartProp || !dtendProp) return null;

  const allDay = dtstartProp.params.includes('VALUE=DATE') || dtstartProp.value.length === 8;

  return {
    uid,
    summary,
    dtstart: parseIcalDate(dtstartProp.value),
    dtend: parseIcalDate(dtendProp.value),
    description: props.get('DESCRIPTION')?.value,
    location: props.get('LOCATION')?.value,
    rrule: props.get('RRULE')?.value,
    status: props.get('STATUS')?.value,
    sequence: parseInt(props.get('SEQUENCE')?.value ?? '0'),
    allDay,
  };
}

export function parseVTodo(icsContent: string): VTodo | null {
  const lines = unfoldLines(icsContent);
  const block = extractBlock(lines, 'BEGIN:VTODO', 'END:VTODO');
  if (!block) return null;

  const props = buildPropMap(block);
  const uid = props.get('UID')?.value;
  const summary = props.get('SUMMARY')?.value;
  if (!uid || !summary) return null;

  const dueProp = props.get('DUE');
  const completedProp = props.get('COMPLETED');
  const priorityStr = props.get('PRIORITY')?.value;
  const percentStr = props.get('PERCENT-COMPLETE')?.value;

  return {
    uid,
    summary,
    description: props.get('DESCRIPTION')?.value,
    due: dueProp ? parseIcalDate(dueProp.value) : undefined,
    priority: priorityStr !== undefined ? parseInt(priorityStr) : undefined,
    status: props.get('STATUS')?.value ?? 'NEEDS-ACTION',
    percentComplete: percentStr !== undefined ? parseInt(percentStr) : undefined,
    completed: completedProp ? parseIcalDate(completedProp.value) : undefined,
    sequence: parseInt(props.get('SEQUENCE')?.value ?? '0'),
  };
}

// ---- Generation ----

export function generateVEvent(event: VEvent): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//nextcloud-mcp//EN',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${nowUtc()}`,
    event.allDay
      ? `DTSTART;VALUE=DATE:${formatIcalDate(event.dtstart, true)}`
      : `DTSTART:${formatIcalDate(event.dtstart, false)}`,
    event.allDay
      ? `DTEND;VALUE=DATE:${formatIcalDate(event.dtend, true)}`
      : `DTEND:${formatIcalDate(event.dtend, false)}`,
    foldLine(`SUMMARY:${escapeValue(event.summary)}`),
    `SEQUENCE:${event.sequence}`,
  ];

  if (event.description) lines.push(foldLine(`DESCRIPTION:${escapeValue(event.description)}`));
  if (event.location) lines.push(foldLine(`LOCATION:${escapeValue(event.location)}`));
  if (event.rrule) lines.push(`RRULE:${event.rrule}`);
  if (event.status) lines.push(`STATUS:${event.status}`);

  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

export function generateVTodo(todo: VTodo): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//nextcloud-mcp//EN',
    'BEGIN:VTODO',
    `UID:${todo.uid}`,
    `DTSTAMP:${nowUtc()}`,
    foldLine(`SUMMARY:${escapeValue(todo.summary)}`),
    `STATUS:${todo.status}`,
    `SEQUENCE:${todo.sequence}`,
  ];

  if (todo.description) lines.push(foldLine(`DESCRIPTION:${escapeValue(todo.description)}`));
  if (todo.due) lines.push(`DUE;VALUE=DATE:${formatIcalDate(todo.due, true)}`);
  if (todo.priority !== undefined) lines.push(`PRIORITY:${todo.priority}`);
  if (todo.percentComplete !== undefined) lines.push(`PERCENT-COMPLETE:${todo.percentComplete}`);
  if (todo.completed) lines.push(`COMPLETED:${formatIcalDate(todo.completed, false)}`);

  lines.push('END:VTODO', 'END:VCALENDAR');
  return lines.join('\r\n');
}

// ---- Merging ----

export type VEventUpdates = Partial<Omit<VEvent, 'uid' | 'sequence' | 'allDay'>>;

export function mergeVEvent(existing: VEvent, updates: VEventUpdates): VEvent {
  return {
    ...existing,
    ...updates,
    uid: existing.uid,
    allDay: existing.allDay,
    sequence: existing.sequence + 1,
  };
}

export type VTodoUpdates = Partial<Omit<VTodo, 'uid' | 'sequence'>>;

export function mergeVTodo(existing: VTodo, updates: VTodoUpdates): VTodo {
  const merged = { ...existing, ...updates, uid: existing.uid, sequence: existing.sequence + 1 };
  if (merged.status === 'COMPLETED' && !merged.completed) {
    merged.completed = new Date().toISOString();
    merged.percentComplete = 100;
  }
  return merged;
}

// ---- Filtering ----

export function filterEventsByDateRange(events: VEvent[], from?: string, to?: string): VEvent[] {
  return events.filter(event => {
    if (from && event.dtend < from) return false;
    if (to && event.dtstart > to) return false;
    return true;
  });
}

export function filterTasksByCompletion(tasks: VTodo[], completed?: boolean): VTodo[] {
  if (completed === undefined) return tasks;
  return tasks.filter(task => (task.status === 'COMPLETED') === completed);
}
