/**
 * The hours a company keeps for what reaches the outside world (STATUS 2.150).
 *
 * Agents have no working hours (F9.6) and nothing here changes that: they read,
 * write and plan at any hour. What an owner who wants a nine-to-five company
 * asks is that an email, a post or a reply to a customer wait for the morning.
 * Said once for the company, here, instead of one capability at a time.
 */
import { Stack, Text } from '@mantine/core';
import { api } from '../api.ts';
import { locale, t } from '../i18n.ts';
import { ActionButton, ActionForm } from './ActionForm.tsx';

export interface Hours {
  timezone: string;
  startHour: number;
  endHour: number;
  daysOfWeek: number[];
  except: string[];
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const SIX_DAYS = [1, 2, 3, 4, 5, 6];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
/** Customers' conversations: the one thing an owner most often keeps open at any hour. */
const REPLIES = 'chat.send';

const same = (a: number[], b: number[]) => a.length === b.length && a.every((day, index) => day === b[index]);

/** A day of the week by name, in the owner's language; 0 is Sunday. */
function dayName(day: number): string {
  return new Intl.DateTimeFormat(locale(), { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + day)));
}

function daysSaid(days: number[]): string {
  if (same(days, WEEKDAYS)) return t('Monday to Friday');
  if (same(days, SIX_DAYS)) return t('Monday to Saturday');
  if (same(days, EVERY_DAY)) return t('Every day');
  return new Intl.ListFormat(locale(), { style: 'long', type: 'conjunction' }).format(days.map(dayName));
}

const clock = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

export function hoursSaid(hours: Hours): string {
  return t('{days}, {from} to {to} ({zone})', {
    days: daysSaid(hours.daysOfWeek), from: clock(hours.startHour), to: clock(hours.endHour), zone: hours.timezone,
  });
}

export function OfficeHoursForm({
  companyId, hours, zones, ownerZone, reload,
}: {
  companyId: string;
  hours: Hours | null;
  zones: string[];
  /** The owner's own zone, offered first until they say another. */
  ownerZone: string;
  reload: () => void;
}) {
  const zone = hours?.timezone ?? ownerZone;
  const known = zones.includes(zone) ? zones : [zone, ...zones];
  // A day set the console would not have made -- one set through the API --
  // is kept as it is unless the owner picks another.
  const custom = hours && ![WEEKDAYS, SIX_DAYS, EVERY_DAY].some((set) => same(set, hours.daysOfWeek));
  const daysNow = hours === null ? 'weekdays'
    : same(hours.daysOfWeek, WEEKDAYS) ? 'weekdays'
      : same(hours.daysOfWeek, SIX_DAYS) ? 'sixdays'
        : same(hours.daysOfWeek, EVERY_DAY) ? 'everyday' : 'current';
  const daysOptions = [
    { value: 'weekdays', label: t('Monday to Friday') },
    { value: 'sixdays', label: t('Monday to Saturday') },
    { value: 'everyday', label: t('Every day') },
    ...(custom ? [{ value: 'current', label: daysSaid(hours.daysOfWeek) }] : []),
  ];

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {hours ? t('Now: {hours}.', { hours: hoursSaid(hours) }) : t('Now: round the clock. Nothing is held back for the hours.')}
      </Text>
      <ActionForm
        key={JSON.stringify(hours)}
        columns={2}
        fields={[
          { name: 'timezone', label: t('Time zone'), type: 'select', required: true, initial: zone, options: known.map((name) => ({ value: name, label: name })) },
          { name: 'days', label: t('Days'), type: 'select', required: true, initial: daysNow, options: daysOptions },
          { name: 'startHour', label: t('Start hour'), type: 'number', required: true, initial: hours?.startHour ?? 9 },
          { name: 'endHour', label: t('End hour'), type: 'number', required: true, initial: hours?.endHour ?? 17, description: t('24 is the end of the day.') },
          {
            name: 'replies', label: t('Replies to customers'), type: 'select', required: true, wide: true,
            initial: hours === null || hours.except.includes(REPLIES) ? 'any' : 'office',
            options: [
              { value: 'any', label: t('Go out at any hour') },
              { value: 'office', label: t('Wait for office hours too') },
            ],
          },
        ]}
        submit={(values) => {
          const days = values.days === 'current' && hours ? hours.daysOfWeek
            : values.days === 'sixdays' ? SIX_DAYS : values.days === 'everyday' ? EVERY_DAY : WEEKDAYS;
          const others = (hours?.except ?? []).filter((name) => name !== REPLIES);
          return api('POST', `/api/companies/${companyId}/office-hours`, {
            timezone: values.timezone, startHour: values.startHour, endHour: values.endHour, daysOfWeek: days,
            except: values.replies === 'any' ? [...others, REPLIES] : others,
          });
        }}
        done={reload}
        success={t('Saved.')}
      />
      {hours && (
        <div>
          <ActionButton
            label={t('Run round the clock')}
            variant="light"
            run={() => api('POST', `/api/companies/${companyId}/office-hours/clear`, {})}
            done={reload}
          />
        </div>
      )}
    </Stack>
  );
}
