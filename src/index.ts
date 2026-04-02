import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { makeCalDavClient, type DAVCalendar, type DAVCalendarObject } from './caldav.js';
import {
  parseVEvent,
  parseVTodo,
  generateVEvent,
  generateVTodo,
  mergeVEvent,
  mergeVTodo,
  filterEventsByDateRange,
  filterTasksByCompletion,
  type VEvent,
  type VEventUpdates,
  type VTodoUpdates,
} from './ical.js';
import { startHttpServer } from './http.js';
import type { CalDavClient } from './caldav.js';

// ---- Calendar discovery helpers ----

function deriveHomeUrl(calendarUrl: string): string {
  const url = new URL(calendarUrl);
  const path = url.pathname.replace(/\/$/, '');
  url.pathname = path.substring(0, path.lastIndexOf('/')) + '/';
  return url.href;
}

function extractComponents(compSet: unknown): string[] {
  if (!compSet || typeof compSet !== 'object') return [];
  const cs = compSet as Record<string, unknown>;
  if (!cs.comp) return [];
  const comps = Array.isArray(cs.comp) ? cs.comp : [cs.comp];
  return comps
    .map((c: unknown) => {
      if (c && typeof c === 'object' && '_attributes' in c) {
        const attrs = (c as Record<string, Record<string, string>>)._attributes;
        return attrs?.name ?? '';
      }
      return '';
    })
    .filter(Boolean);
}

function buildExtraCalendars(
  responses: Array<{ href?: string; props?: Record<string, unknown> }>,
  knownUrls: Set<string>,
  homeUrl: string,
): DAVCalendar[] {
  const extra: DAVCalendar[] = [];
  for (const r of responses) {
    if (!r.href || !r.props) continue;
    const fullUrl = new URL(r.href, homeUrl).href;
    if (knownUrls.has(fullUrl)) continue;

    const components = extractComponents(r.props.supportedCalendarComponentSet);
    if (!components.includes('VTODO')) continue;

    const rawName = r.props.displayname;
    const displayName =
      typeof rawName === 'string' ? rawName
      : rawName && typeof rawName === 'object' && '#text' in (rawName as object)
        ? String((rawName as Record<string, unknown>)['#text'])
        : fullUrl;

    extra.push({
      url: fullUrl,
      displayName,
      components,
      calendarColor: typeof r.props.calendarColor === 'string' ? r.props.calendarColor : undefined,
      description: typeof r.props.calendarDescription === 'string' ? r.props.calendarDescription : '',
    } as DAVCalendar);
  }
  return extra;
}

async function fetchAllCalendars(dav: CalDavClient): Promise<DAVCalendar[]> {
  const known = await dav.fetchCalendars();
  if (known.length === 0) return known;

  const homeUrl = deriveHomeUrl(known[0].url);
  const knownUrls = new Set(known.map(c => c.url));

  const props = {
    'c:calendar-description': {},
    'd:displayname': {},
    'ca:calendar-color': {},
    'd:resourcetype': {},
    'c:supported-calendar-component-set': {},
  };

  const responses = await dav.propfind({ url: homeUrl, depth: '1', props });
  const extra = buildExtraCalendars(responses as Array<{ href?: string; props?: Record<string, unknown> }>, knownUrls, homeUrl);
  return [...known, ...extra];
}

// ---- Config ----

function readConfig() {
  const serverUrl = process.env.NEXTCLOUD_URL;
  const username = process.env.NEXTCLOUD_USERNAME;
  const password = process.env.NEXTCLOUD_APP_PASSWORD;

  if (!serverUrl || !username || !password) {
    throw new Error(
      'Missing required environment variables: NEXTCLOUD_URL, NEXTCLOUD_USERNAME, NEXTCLOUD_APP_PASSWORD'
    );
  }

  return { serverUrl, username, password };
}

function readHttpConfig() {
  const adminPassword = process.env.OAUTH_ADMIN_PASSWORD;
  const baseUrl = process.env.MCP_BASE_URL;
  const port = process.env.MCP_HTTP_PORT ? parseInt(process.env.MCP_HTTP_PORT, 10) : 3000;

  if (!adminPassword || !baseUrl) {
    return null;
  }

  return { adminPassword, baseUrl, port };
}

// ---- Helpers (pure operations) ----

function findCalendar(calendars: DAVCalendar[], url: string): DAVCalendar | undefined {
  return calendars.find(c => c.url === url);
}

function findObjectByUid(objects: DAVCalendarObject[], uid: string): DAVCalendarObject | undefined {
  return objects.find(o => typeof o.data === 'string' && o.data.includes(`UID:${uid}`));
}

function icsData(obj: DAVCalendarObject): string {
  return String(obj.data ?? '');
}

function errorResult(message: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text: message }] };
}

function okResult(data: unknown) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

const VTODO_FILTER = [{ 'comp-filter': { _attributes: { name: 'VCALENDAR' }, 'comp-filter': { _attributes: { name: 'VTODO' } } } }];

// ---- Server factory ----

function makeServer(dav: CalDavClient): McpServer {
  const server = new McpServer({ name: 'nextcloud-mcp', version: '1.0.0' });

  // ---- list_calendars ----

  server.tool(
    'list_calendars',
    'List all available CalDAV calendars and task lists',
    {},
    async () => {
      const calendars = await fetchAllCalendars(dav);
      const result = calendars.map(c => ({
        url: c.url,
        displayName: c.displayName ?? c.url,
        components: c.components ?? [],
        color: c.calendarColor,
        description: c.description,
      }));
      return okResult(result);
    }
  );

  // ---- list_events ----

  server.tool(
    'list_events',
    'List calendar events, optionally filtered by calendar URL and/or date range (ISO 8601 dates)',
    {
      calendarUrl: z.string().optional().describe('Calendar URL from list_calendars. Omit to search all calendars.'),
      from: z.string().optional().describe('Earliest date to include, e.g. 2025-01-01'),
      to: z.string().optional().describe('Latest date to include, e.g. 2025-12-31'),
    },
    async ({ calendarUrl, from, to }) => {
      const calendars = await fetchAllCalendars(dav);
      const targets = calendarUrl
        ? calendars.filter(c => c.url === calendarUrl)
        : calendars.filter(c => !c.components || c.components.includes('VEVENT'));

      const events: VEvent[] = [];
      for (const cal of targets) {
        const objects = await dav.fetchCalendarObjects({ calendar: cal });
        for (const obj of objects) {
          const data = icsData(obj);
          if (!data.includes('BEGIN:VEVENT')) continue;
          const event = parseVEvent(data);
          if (event) events.push(event);
        }
      }

      const filtered = filterEventsByDateRange(events, from, to);
      return okResult(filtered);
    }
  );

  // ---- create_event ----

  server.tool(
    'create_event',
    'Create a new calendar event',
    {
      calendarUrl: z.string().describe('Calendar URL from list_calendars'),
      summary: z.string().describe('Event title'),
      dtstart: z.string().describe('Start time in ISO 8601 (e.g. 2025-06-15T10:00:00Z or 2025-06-15 for all-day)'),
      dtend: z.string().describe('End time in ISO 8601'),
      allDay: z.boolean().optional().describe('All-day event. Defaults to true if dtstart has no time component.'),
      description: z.string().optional(),
      location: z.string().optional(),
    },
    async ({ calendarUrl, summary, dtstart, dtend, allDay, description, location }) => {
      const calendars = await fetchAllCalendars(dav);
      const calendar = findCalendar(calendars, calendarUrl);
      if (!calendar) return errorResult(`Calendar not found: ${calendarUrl}`);

      const uid = randomUUID();
      const isAllDay = allDay ?? !dtstart.includes('T');
      const event: VEvent = {
        uid,
        summary,
        dtstart,
        dtend,
        allDay: isAllDay,
        description,
        location,
        sequence: 0,
      };
      const icsContent = generateVEvent(event);
      const filename = `${uid}.ics`;
      await dav.createCalendarObject({ calendar, filename, iCalString: icsContent });

      return okResult(event);
    }
  );

  // ---- update_event ----

  server.tool(
    'update_event',
    'Update an existing calendar event. Only provided fields are changed.',
    {
      calendarUrl: z.string().describe('Calendar URL from list_calendars'),
      uid: z.string().describe('Event UID from list_events'),
      summary: z.string().optional(),
      dtstart: z.string().optional().describe('ISO 8601 datetime'),
      dtend: z.string().optional().describe('ISO 8601 datetime'),
      description: z.string().optional(),
      location: z.string().optional(),
      status: z.string().optional().describe('CONFIRMED | TENTATIVE | CANCELLED'),
    },
    async ({ calendarUrl, uid, summary, dtstart, dtend, description, location, status }) => {
      const calendars = await fetchAllCalendars(dav);
      const calendar = findCalendar(calendars, calendarUrl);
      if (!calendar) return errorResult(`Calendar not found: ${calendarUrl}`);

      const objects = await dav.fetchCalendarObjects({ calendar });
      const obj = findObjectByUid(objects, uid);
      if (!obj) return errorResult(`Event not found: ${uid}`);

      const existing = parseVEvent(icsData(obj));
      if (!existing) return errorResult(`Failed to parse event: ${uid}`);

      const updates: VEventUpdates = {};
      if (summary !== undefined) updates.summary = summary;
      if (dtstart !== undefined) updates.dtstart = dtstart;
      if (dtend !== undefined) updates.dtend = dtend;
      if (description !== undefined) updates.description = description;
      if (location !== undefined) updates.location = location;
      if (status !== undefined) updates.status = status;

      const updatedEvent = mergeVEvent(existing, updates);
      const icsContent = generateVEvent(updatedEvent);
      const updatedObj: DAVCalendarObject = { ...obj, data: icsContent };
      await dav.updateCalendarObject({ calendarObject: updatedObj });

      return okResult(updatedEvent);
    }
  );

  // ---- delete_event ----

  server.tool(
    'delete_event',
    'Delete a calendar event',
    {
      calendarUrl: z.string().describe('Calendar URL from list_calendars'),
      uid: z.string().describe('Event UID from list_events'),
    },
    async ({ calendarUrl, uid }) => {
      const calendars = await fetchAllCalendars(dav);
      const calendar = findCalendar(calendars, calendarUrl);
      if (!calendar) return errorResult(`Calendar not found: ${calendarUrl}`);

      const objects = await dav.fetchCalendarObjects({ calendar });
      const obj = findObjectByUid(objects, uid);
      if (!obj) return errorResult(`Event not found: ${uid}`);

      await dav.deleteCalendarObject({ calendarObject: obj });
      return okResult(`Event ${uid} deleted.`);
    }
  );

  // ---- list_todos ----

  server.tool(
    'list_todos',
    'List todo items, optionally filtered by calendar URL and/or completion status',
    {
      calendarUrl: z.string().optional().describe('Calendar URL from list_calendars. Omit to search all task lists.'),
      completed: z.boolean().optional().describe('true = only completed, false = only incomplete, omit = all'),
    },
    async ({ calendarUrl, completed }) => {
      const calendars = await fetchAllCalendars(dav);
      const targets = calendarUrl
        ? calendars.filter(c => c.url === calendarUrl)
        : calendars.filter(c => !c.components || c.components.includes('VTODO'));

      const todos = [];
      for (const cal of targets) {
        const objects = await dav.fetchCalendarObjects({ calendar: cal, filters: VTODO_FILTER });
        for (const obj of objects) {
          const data = icsData(obj);
          if (!data.includes('BEGIN:VTODO')) continue;
          const todo = parseVTodo(data);
          if (todo) todos.push(todo);
        }
      }

      const filtered = filterTasksByCompletion(todos, completed);
      return okResult(filtered);
    }
  );

  // ---- create_todo ----

  server.tool(
    'create_todo',
    'Create a new todo item',
    {
      calendarUrl: z.string().describe('Calendar URL from list_calendars'),
      summary: z.string().describe('Todo title'),
      due: z.string().optional().describe('Due date in ISO 8601 (e.g. 2025-06-15)'),
      description: z.string().optional(),
      priority: z.number().int().min(0).max(9).optional().describe('0 = undefined, 1 = highest, 9 = lowest'),
    },
    async ({ calendarUrl, summary, due, description, priority }) => {
      const calendars = await fetchAllCalendars(dav);
      const calendar = findCalendar(calendars, calendarUrl);
      if (!calendar) return errorResult(`Calendar not found: ${calendarUrl}`);

      const uid = randomUUID();
      const todo = {
        uid,
        summary,
        due,
        description,
        priority,
        status: 'NEEDS-ACTION' as const,
        sequence: 0,
      };
      const icsContent = generateVTodo(todo);
      const filename = `${uid}.ics`;
      await dav.createCalendarObject({ calendar, filename, iCalString: icsContent });

      return okResult(todo);
    }
  );

  // ---- update_todo ----

  server.tool(
    'update_todo',
    'Update an existing todo item. Only provided fields are changed.',
    {
      calendarUrl: z.string().describe('Calendar URL from list_calendars'),
      uid: z.string().describe('Todo UID from list_todos'),
      summary: z.string().optional(),
      due: z.string().optional().describe('Due date in ISO 8601'),
      description: z.string().optional(),
      priority: z.number().int().min(0).max(9).optional(),
      status: z.string().optional().describe('NEEDS-ACTION | IN-PROCESS | COMPLETED | CANCELLED'),
      percentComplete: z.number().int().min(0).max(100).optional(),
    },
    async ({ calendarUrl, uid, summary, due, description, priority, status, percentComplete }) => {
      const calendars = await fetchAllCalendars(dav);
      const calendar = findCalendar(calendars, calendarUrl);
      if (!calendar) return errorResult(`Calendar not found: ${calendarUrl}`);

      const objects = await dav.fetchCalendarObjects({ calendar, filters: VTODO_FILTER });
      const obj = findObjectByUid(objects, uid);
      if (!obj) return errorResult(`Todo not found: ${uid}`);

      const existing = parseVTodo(icsData(obj));
      if (!existing) return errorResult(`Failed to parse todo: ${uid}`);

      const updates: VTodoUpdates = {};
      if (summary !== undefined) updates.summary = summary;
      if (due !== undefined) updates.due = due;
      if (description !== undefined) updates.description = description;
      if (priority !== undefined) updates.priority = priority;
      if (status !== undefined) updates.status = status;
      if (percentComplete !== undefined) updates.percentComplete = percentComplete;

      const updatedTodo = mergeVTodo(existing, updates);
      const icsContent = generateVTodo(updatedTodo);
      const updatedObj: DAVCalendarObject = { ...obj, data: icsContent };
      await dav.updateCalendarObject({ calendarObject: updatedObj });

      return okResult(updatedTodo);
    }
  );

  // ---- delete_todo ----

  server.tool(
    'delete_todo',
    'Delete a todo item',
    {
      calendarUrl: z.string().describe('Calendar URL from list_calendars'),
      uid: z.string().describe('Todo UID from list_todos'),
    },
    async ({ calendarUrl, uid }) => {
      const calendars = await fetchAllCalendars(dav);
      const calendar = findCalendar(calendars, calendarUrl);
      if (!calendar) return errorResult(`Calendar not found: ${calendarUrl}`);

      const objects = await dav.fetchCalendarObjects({ calendar, filters: VTODO_FILTER });
      const obj = findObjectByUid(objects, uid);
      if (!obj) return errorResult(`Todo not found: ${uid}`);

      await dav.deleteCalendarObject({ calendarObject: obj });
      return okResult(`Todo ${uid} deleted.`);
    }
  );

  return server;
}

// ---- Main ----

async function main() {
  const config = readConfig();
  const dav = await makeCalDavClient(config);

  const httpConfig = readHttpConfig();
  if (httpConfig) {
    startHttpServer(makeServer, dav, httpConfig);
  }

  const server = makeServer(dav);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
