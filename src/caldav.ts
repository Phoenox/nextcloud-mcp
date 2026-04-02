import { createDAVClient, type DAVCalendar, type DAVCalendarObject } from 'tsdav';

export type { DAVCalendar, DAVCalendarObject };

export type CalDavClient = Awaited<ReturnType<typeof createDAVClient>>;

export interface CalDavConfig {
  serverUrl: string;
  username: string;
  password: string;
}

export async function makeCalDavClient(config: CalDavConfig) {
  return createDAVClient({
    serverUrl: config.serverUrl,
    credentials: {
      username: config.username,
      password: config.password,
    },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
}
