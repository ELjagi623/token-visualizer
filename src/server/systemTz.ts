/**
 * 系统时区（IANA 名）的解析。
 *
 * 1. 优先用 Intl（绝大多数环境直接给出，如 Asia/Shanghai）；
 * 2. Windows 上 Node 有时读不出 IANA 名（Intl 返回 undefined，例如新增的 "Alberta Standard Time"）：
 *    此时用 `tzutil /g` 取 Windows 时区名，再按下表映射成 IANA 名；
 * 3. 都不行 → 退回 UTC，并标记 source = 'fallback'，由设置页提示用户手动选择（而不是悄悄按 UTC 算）。
 */
import { execFileSync } from 'node:child_process';
import { assertValidTimeZone } from './core/time.ts';

export type SystemTzSource = 'intl' | 'windows' | 'fallback';
export interface SystemTz {
  name: string;
  source: SystemTzSource;
}

/** Windows 时区名 → IANA（常见地区；未收录的会退回 UTC 并提示手动选择）。 */
export const WINDOWS_TO_IANA: Readonly<Record<string, string>> = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'UTC-11': 'Etc/GMT+11',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time': 'America/Denver',
  'Alberta Standard Time': 'America/Edmonton',
  'Mountain Standard Time (Mexico)': 'America/Chihuahua',
  'Central Standard Time': 'America/Chicago',
  'Canada Central Standard Time': 'America/Regina',
  'Central America Standard Time': 'America/Guatemala',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Eastern Standard Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'SA Pacific Standard Time': 'America/Bogota',
  'Atlantic Standard Time': 'America/Halifax',
  'Venezuela Standard Time': 'America/Caracas',
  'SA Western Standard Time': 'America/La_Paz',
  'Pacific SA Standard Time': 'America/Santiago',
  'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'SA Eastern Standard Time': 'America/Cayenne',
  UTC: 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'GTB Standard Time': 'Europe/Bucharest',
  'Middle East Standard Time': 'Asia/Beirut',
  'Egypt Standard Time': 'Africa/Cairo',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'FLE Standard Time': 'Europe/Kiev',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Arabic Standard Time': 'Asia/Baghdad',
  'Arab Standard Time': 'Asia/Riyadh',
  'Russian Standard Time': 'Europe/Moscow',
  'E. Africa Standard Time': 'Africa/Nairobi',
  'Iran Standard Time': 'Asia/Tehran',
  'Arabian Standard Time': 'Asia/Dubai',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Kolkata',
  'Sri Lanka Standard Time': 'Asia/Colombo',
  'Nepal Standard Time': 'Asia/Kathmandu',
  'Central Asia Standard Time': 'Asia/Almaty',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'Myanmar Standard Time': 'Asia/Yangon',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'W. Australia Standard Time': 'Australia/Perth',
  'Taipei Standard Time': 'Asia/Taipei',
  'Ulaanbaatar Standard Time': 'Asia/Ulaanbaatar',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Central Standard Time': 'Australia/Darwin',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'Tasmania Standard Time': 'Australia/Hobart',
  'West Pacific Standard Time': 'Pacific/Port_Moresby',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Fiji Standard Time': 'Pacific/Fiji',
  'Tonga Standard Time': 'Pacific/Tongatapu',
};

/** 纯函数：Windows 时区名 → IANA 名（不认识 / 映射结果无效 → null）。 */
export function windowsToIana(windowsName: string): string | null {
  const iana = WINDOWS_TO_IANA[windowsName.trim()];
  if (iana === undefined) return null;
  try {
    assertValidTimeZone(iana);
    return iana;
  } catch {
    return null;
  }
}

/** 纯函数：按"Intl 给的名字 → Windows 时区名"的顺序决定结果（便于测试）。 */
export function decideSystemTz(intlName: string | undefined, windowsName: (() => string | null) | null): SystemTz {
  if (intlName) return { name: intlName, source: 'intl' };
  if (windowsName !== null) {
    const w = windowsName();
    const iana = w === null ? null : windowsToIana(w);
    if (iana !== null) return { name: iana, source: 'windows' };
  }
  return { name: 'UTC', source: 'fallback' };
}

function readWindowsTzName(): string | null {
  try {
    const out = execFileSync('tzutil', ['/g'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const name = out.trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

let cached: SystemTz | null = null;

/** 系统时区（进程内缓存；改了系统时区需重启软件）。 */
export function systemTimeZoneInfo(): SystemTz {
  if (cached === null) {
    let intl: string | undefined;
    try {
      intl = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch {
      intl = undefined;
    }
    cached = decideSystemTz(intl, process.platform === 'win32' ? readWindowsTzName : null);
  }
  return cached;
}

/** 系统时区（IANA 名）。 */
export function systemTimeZone(): string {
  return systemTimeZoneInfo().name;
}

export const SYSTEM_TZ_FALLBACK_WARNING = '无法识别系统时区，日期（今天 / 本周 / 本周期）暂按 UTC 划分，可能与你所在地的日期不一致。请在“显示 → 时区”里手动选择你所在的时区。';
