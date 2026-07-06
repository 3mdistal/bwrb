import type { Calendar } from '../types/schema.js';

export interface ParsedCalendarDate {
  value: string;
  calendar: string;
  era: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  linear: number;
}

export interface CalendarDateValue {
  __bwrbCalendarDate: true;
  value: string;
  calendar: string;
  linear: number;
  calendarDef?: Calendar;
}

export type CalendarDateParseResult =
  | { valid: true; date: ParsedCalendarDate }
  | { valid: false; error: string };

const CALENDAR_DATE_PATTERN =
  /^([^\s]+)\s+(\d+)-(\d{1,2})-(\d{1,2})(?:\s+(\d+):(\d{2}))?$/;

export function parseCalendarDate(
  value: unknown,
  calendarId: string,
  calendar: Calendar
): CalendarDateParseResult {
  if (typeof value !== 'string') {
    return {
      valid: false,
      error: `expected calendar date string for calendar "${calendarId}"`,
    };
  }

  const trimmed = value.trim();
  const match = trimmed.match(CALENDAR_DATE_PATTERN);
  if (!match) {
    return {
      valid: false,
      error: `expected <eraShort> <year>-<month>-<day> with optional <hour>:<minute> for calendar "${calendarId}"`,
    };
  }

  const eraShort = match[1]!;
  const eraIndex = calendar.eras.findIndex((era) => era.shortName === eraShort);
  if (eraIndex < 0) {
    return {
      valid: false,
      error: `invalid era "${eraShort}" for calendar "${calendarId}"; expected one of ${calendar.eras.map((era) => era.shortName).join(', ')}`,
    };
  }

  const year = Number.parseInt(match[2]!, 10);
  const month = Number.parseInt(match[3]!, 10);
  const day = Number.parseInt(match[4]!, 10);
  const hour = match[5] === undefined ? 0 : Number.parseInt(match[5], 10);
  const minute = match[6] === undefined ? 0 : Number.parseInt(match[6], 10);
  const hoursInDay = calendar.hoursInDay ?? 24;

  if (year < 1) {
    return { valid: false, error: `invalid year ${year}; expected year >= 1` };
  }

  if (month < 1 || month > calendar.months.length) {
    return {
      valid: false,
      error: `invalid month ${month} for calendar "${calendarId}"; expected 1-${calendar.months.length}`,
    };
  }

  const monthDef = calendar.months[month - 1]!;
  if (day < 1 || day > monthDef.days) {
    return {
      valid: false,
      error: `invalid day ${day} for month ${month} in calendar "${calendarId}"; expected 1-${monthDef.days}`,
    };
  }

  if (hour < 0 || hour >= hoursInDay) {
    return {
      valid: false,
      error: `invalid hour ${hour} for calendar "${calendarId}"; expected 0-${hoursInDay - 1}`,
    };
  }

  if (minute < 0 || minute > 59) {
    return { valid: false, error: `invalid minute ${minute}; expected 0-59` };
  }

  const canonical = formatCalendarDate({
    era: eraShort,
    year,
    month,
    day,
    hour,
    minute,
    includeTime: match[5] !== undefined,
  });

  return {
    valid: true,
    date: {
      value: canonical,
      calendar: calendarId,
      era: eraShort,
      year,
      month,
      day,
      hour,
      minute,
      linear: toLinearHours(calendar, eraIndex, year, month, day, hour, minute),
    },
  };
}

export function calendarDateValue(date: ParsedCalendarDate, calendar?: Calendar): CalendarDateValue {
  return {
    __bwrbCalendarDate: true,
    value: date.value,
    calendar: date.calendar,
    linear: date.linear,
    ...(calendar ? { calendarDef: calendar } : {}),
  };
}

export function isCalendarDateValue(value: unknown): value is CalendarDateValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).__bwrbCalendarDate === true
  );
}

export function calendarDateJsonValue(value: CalendarDateValue): {
  value: string;
  calendar: string;
  linear: number;
} {
  return {
    value: value.value,
    calendar: value.calendar,
    linear: value.linear,
  };
}

export function compareCalendarDateValues(
  left: CalendarDateValue,
  right: CalendarDateValue
): number | null {
  if (left.calendar !== right.calendar) return null;
  return left.linear - right.linear;
}

export function formatLinearCalendarDate(
  linear: number,
  calendarId: string,
  calendar: Calendar
): CalendarDateParseResult {
  const formattedLinear = Math.round(linear * 60) / 60;
  const hoursInDay = calendar.hoursInDay ?? 24;
  const hoursInYear = calendar.months.reduce(
    (sum, current) => sum + current.days * hoursInDay,
    0
  );
  const eraIndex = formattedLinear < 0
    ? calendar.eras.findIndex((era) => era.backwards === true)
    : calendar.eras.findIndex((era) => era.backwards !== true);
  if (eraIndex < 0) {
    return {
      valid: false,
      error: `calendar "${calendarId}" has no ${formattedLinear < 0 ? 'backwards' : 'forward'} era for linear value ${linear}`,
    };
  }

  const era = calendar.eras[eraIndex]!;
  const year = era.backwards === true
    ? Math.floor((-formattedLinear - 1) / hoursInYear) + 1
    : Math.floor(formattedLinear / hoursInYear) + 1;
  const yearStart = era.backwards === true ? -year * hoursInYear : (year - 1) * hoursInYear;
  const withinYear = formattedLinear - yearStart;
  const dayIndex = Math.floor(withinYear / hoursInDay);
  const hourFloat = withinYear - dayIndex * hoursInDay;
  let hour = Math.floor(hourFloat);
  let minute = Math.round((hourFloat - hour) * 60);
  if (minute === 60) {
    hour += 1;
    minute = 0;
  }

  let remainingDays = dayIndex;
  let month = 1;
  for (const monthDef of calendar.months) {
    if (remainingDays < monthDef.days) break;
    remainingDays -= monthDef.days;
    month++;
  }
  const day = remainingDays + 1;
  const value = formatCalendarDate({
    era: era.shortName,
    year,
    month,
    day,
    hour,
    minute,
    includeTime: hour !== 0 || minute !== 0,
  });

  return {
    valid: true,
    date: {
      value,
      calendar: calendarId,
      era: era.shortName,
      year,
      month,
      day,
      hour,
      minute,
      linear,
    },
  };
}

function formatCalendarDate(parts: {
  era: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  includeTime: boolean;
}): string {
  const date = `${parts.era} ${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  if (!parts.includeTime) return date;
  return `${date} ${parts.hour}:${pad2(parts.minute)}`;
}

function toLinearHours(
  calendar: Calendar,
  eraIndex: number,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): number {
  const hoursInDay = calendar.hoursInDay ?? 24;
  const hoursInYear = calendar.months.reduce(
    (sum, current) => sum + current.days * hoursInDay,
    0
  );
  const dayOffset = calendar.months
    .slice(0, month - 1)
    .reduce((sum, current) => sum + current.days, 0) + (day - 1);
  const withinYear = dayOffset * hoursInDay + hour + minute / 60;
  const era = calendar.eras[eraIndex]!;

  if (era.backwards === true) {
    return -year * hoursInYear + withinYear;
  }

  return (year - 1) * hoursInYear + withinYear;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
