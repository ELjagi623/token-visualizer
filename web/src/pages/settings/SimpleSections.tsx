import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { apiSend } from '../../api/clientC.ts';
import type { Basis, SettingsData } from '../../api/types.ts';
import { useApi } from '../../api/useApi.ts';
import { Chip } from '../../design/Button.tsx';
import { Pill } from '../../design/Pill.tsx';
import { Segmented } from '../../design/Segmented.tsx';
import { runAction, saveSettings } from '../../features/settings/save.ts';
import { useStore, useT } from '../../state/store.ts';
import type { ThemePref } from '../../state/store.ts';
import { Row, Section, Switch } from './parts.tsx';
import s from './Settings.module.css';

interface ValidateResult {
  ok: boolean;
  message?: string;
  path?: string;
  projectFolders?: number;
  sessionFiles?: number;
}

/** 数据源：数据根目录输入 + 检测（只读）+ 应用（非法路径中文报错且不改当前数据）。 */
export function SourceSection({ settings, effectiveRoot }: { settings: SettingsData; effectiveRoot: string }) {
  const t = useT();
  const [draft, setDraft] = useState(settings.dataRoot ?? effectiveRoot);
  const [result, setResult] = useState<ValidateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(settings.dataRoot ?? effectiveRoot);
  }, [settings.dataRoot, effectiveRoot]);

  const check = async (): Promise<ValidateResult | null> => {
    setBusy(true);
    setApplyError(null);
    try {
      const r = await apiSend<ValidateResult>('POST', '/api/settings/validate-root', { path: draft.trim() });
      setResult(r);
      return r;
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const apply = async (): Promise<void> => {
    const r = await check();
    if (!r?.ok) return;
    const res = await saveSettings({ dataRoot: draft.trim() });
    if (!res.ok) setApplyError(res.message);
  };

  const restoreAuto = async (): Promise<void> => {
    setApplyError(null);
    const res = await saveSettings({ dataRoot: null });
    if (!res.ok) setApplyError(res.message);
    else setResult(null);
  };

  const changed = draft.trim() !== effectiveRoot;
  return (
    <Section title={t('settings.source.title')} testId="settings-source">
      <Row title={t('settings.source.root')} hint={t('settings.source.rootHint')}>
        <div className={s.rowControl}>
          <input
            className={`${s.field} ${s.grow}`}
            type="text"
            value={draft}
            spellCheck={false}
            aria-label={t('settings.source.root')}
            aria-invalid={result?.ok === false || applyError !== null}
            data-testid="settings-root-input"
            onChange={(e) => {
              setDraft(e.target.value);
              setResult(null);
              setApplyError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void apply();
            }}
          />
          <Chip data-testid="settings-root-check" disabled={busy || draft.trim() === ''} onClick={() => void check()}>
            {t('settings.source.check')}
          </Chip>
          <Chip primary data-testid="settings-root-apply" disabled={busy || !changed || draft.trim() === ''} onClick={() => void apply()}>
            {t('settings.source.apply')}
          </Chip>
          {settings.dataRoot !== null && (
            <Chip data-testid="settings-root-auto" onClick={() => void restoreAuto()}>
              {t('settings.source.auto')}
            </Chip>
          )}
        </div>
      </Row>
      <Row title={t('settings.source.result')} testId="settings-root-result">
        <div className={s.rowControlEnd}>
          {result === null && applyError === null && <span className={s.rowHint}>{settings.dataRoot === null ? t('settings.source.usingAuto') : t('settings.source.usingCustom')}</span>}
          {result?.ok === true && (
            <Pill tone="green" className={s.msg} data-testid="settings-root-ok">
              {t('settings.source.found', { projects: result.projectFolders ?? 0, files: result.sessionFiles ?? 0 })}
            </Pill>
          )}
          {result?.ok === false && (
            <Pill tone="amber" data-testid="settings-root-error" style={{ height: 'auto', minHeight: 34, whiteSpace: 'normal' }}>
              {result.message}
            </Pill>
          )}
          {applyError !== null && (
            <Pill tone="pink" data-testid="settings-root-apply-error" style={{ height: 'auto', minHeight: 34, whiteSpace: 'normal' }}>
              {applyError}
            </Pill>
          )}
        </div>
      </Row>
    </Section>
  );
}

function tzOffsetLabel(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date());
    const n = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    return n.replace('GMT', 'UTC') || 'UTC';
  } catch {
    return '';
  }
}

/** 显示：默认口径 / 主题 / 时区 / 一周起始日。 */
export function DisplaySection({ settings, systemTimezone }: { settings: SettingsData; systemTimezone: string }) {
  const t = useT();
  const themePref = useStore((st) => st.themePref);
  const setThemePref = useStore((st) => st.setThemePref);
  const tzs = useApi<{ system: string; timezones: string[] }>('/api/timezones');
  const zones = tzs.data?.timezones ?? [];
  const current = settings.timezone;

  return (
    <Section title={t('settings.display.title')} testId="settings-display">
      <Row title={t('settings.display.basis')} hint={t('settings.display.basisHint')}>
        <Segmented<Basis>
          size="sm"
          ariaLabel={t('settings.display.basis')}
          testId="settings-basis"
          value={settings.defaultBasis}
          onChange={(v) => void saveSettings({ defaultBasis: v })}
          options={[
            { value: 'total', label: t('basis.total') },
            { value: 'fresh', label: t('basis.fresh') },
          ]}
        />
      </Row>
      <Row title={t('settings.display.theme')}>
        <Segmented<ThemePref>
          size="sm"
          ariaLabel={t('settings.display.theme')}
          testId="settings-theme"
          value={themePref}
          onChange={setThemePref}
          options={[
            { value: 'light', label: t('theme.light') },
            { value: 'dark', label: t('theme.dark') },
            { value: 'system', label: t('theme.system') },
          ]}
        />
      </Row>
      <Row title={t('settings.display.tz')} hint={t('settings.display.tzHint')}>
        <select className={`${s.field} ${s.fieldMd}`} style={{ width: 'min(100%, 320px)' }} aria-label={t('settings.display.tz')} data-testid="settings-timezone" value={current} onChange={(e) => void saveSettings({ timezone: e.target.value })}>
          <option value="system">{t('settings.display.tzSystem', { tz: systemTimezone, offset: tzOffsetLabel(systemTimezone) })}</option>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z} · {tzOffsetLabel(z)}
            </option>
          ))}
          {current !== 'system' && !zones.includes(current) && <option value={current}>{current}</option>}
        </select>
      </Row>
      <Row title={t('settings.display.weekStart')}>
        <Segmented<'monday' | 'sunday'>
          size="sm"
          ariaLabel={t('settings.display.weekStart')}
          testId="settings-weekstart"
          value={settings.weekStart}
          onChange={(v) => void saveSettings({ weekStart: v })}
          options={[
            { value: 'monday', label: t('settings.display.monday') },
            { value: 'sunday', label: t('settings.display.sunday') },
          ]}
        />
      </Row>
    </Section>
  );
}

const INTERVALS = [5, 10, 30, 60] as const;

/** 数据刷新：自动刷新开关 / 间隔 / 立即全量重建缓存。 */
export function RefreshSection({ settings }: { settings: SettingsData }) {
  const t = useT();
  const scanning = useStore((st) => st.status?.state === 'scanning');
  const [started, setStarted] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (started && !scanning) {
      const id = setTimeout(() => setStarted(false), 4000);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [started, scanning]);

  const rebuild = async (): Promise<void> => {
    setConfirm(false);
    setErr(null);
    const r = await runAction(() => apiSend<unknown>('POST', '/api/rebuild'));
    if (r.ok) {
      setStarted(true);
      void api.status().then((st) => useStore.setState({ status: st }));
    } else setErr(r.message);
  };

  return (
    <Section title={t('settings.refresh.title')} testId="settings-refresh">
      <Row title={t('settings.refresh.auto')} hint={t('settings.refresh.autoHint')}>
        <Switch checked={settings.autoRefresh.enabled} label={t('settings.refresh.auto')} testId="settings-autorefresh" onChange={(v) => void saveSettings({ autoRefresh: { enabled: v } })} />
      </Row>
      <Row title={t('settings.refresh.interval')}>
        <Segmented<string>
          size="sm"
          ariaLabel={t('settings.refresh.interval')}
          testId="settings-interval"
          value={String(settings.autoRefresh.intervalSec)}
          onChange={(v) => void saveSettings({ autoRefresh: { intervalSec: Number(v) } })}
          options={INTERVALS.map((n) => ({ value: String(n), label: n < 60 ? t('settings.refresh.seconds', { n }) : t('settings.refresh.minute') }))}
        />
      </Row>
      <Row title={t('settings.refresh.rebuild')} hint={t('settings.refresh.rebuildHint')}>
        <div className={s.rowControlEnd}>
          {err && <span className={`${s.msg} ${s.msgErr}`}>{err}</span>}
          {started && (
            <span className={`${s.msg} ${s.msgOk}`} role="status" data-testid="settings-rebuild-started">
              {scanning ? t('settings.refresh.rebuilding') : t('settings.refresh.rebuilt')}
            </span>
          )}
          {!confirm ? (
            <Chip data-testid="settings-rebuild" disabled={scanning} onClick={() => setConfirm(true)}>
              {t('settings.refresh.rebuildNow')}
            </Chip>
          ) : (
            <>
              <span className={s.msg}>{t('settings.refresh.rebuildConfirm')}</span>
              <Chip primary data-testid="settings-rebuild-confirm" onClick={() => void rebuild()}>
                {t('settings.refresh.rebuildYes')}
              </Chip>
              <Chip onClick={() => setConfirm(false)}>{t('settings.cancel')}</Chip>
            </>
          )}
        </div>
      </Row>
    </Section>
  );
}

function tokensToM(v: number | null): string {
  return v === null ? '' : String(Math.round((v / 1e6) * 1e6) / 1e6);
}

function BudgetField({ label, testId, value, onSave }: { label: string; testId: string; value: number | null; onSave: (v: number | null) => Promise<string | null> }) {
  const t = useT();
  const [text, setText] = useState(tokensToM(value));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setText(tokensToM(value)), [value]);
  const commit = async (): Promise<void> => {
    const tx = text.trim();
    let v: number | null = null;
    if (tx !== '') {
      if (!/^\d+(\.\d+)?$/.test(tx) || Number(tx) > 1e9) {
        setErr(t('settings.budget.invalid'));
        return;
      }
      v = Math.round(Number(tx) * 1e6);
    }
    if (v === value) {
      setErr(null);
      return;
    }
    const e = await onSave(v);
    setErr(e);
  };
  return (
    <div className={s.rowControlEnd}>
      <input
        className={`${s.field} ${s.fieldMd}`}
        type="text"
        inputMode="decimal"
        placeholder={t('settings.budget.placeholder')}
        value={text}
        aria-label={label}
        aria-invalid={err !== null}
        data-testid={testId}
        onChange={(e) => {
          setText(e.target.value);
          setErr(null);
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
        }}
      />
      <span className={s.unit}>M tokens</span>
      {err && <span className={`${s.msg} ${s.msgErr}`}>{err}</span>}
    </div>
  );
}

/** 预算（M tokens）：每日 / 每月；总览状态卡进度条按此计算。 */
export function BudgetSection({ settings }: { settings: SettingsData }) {
  const t = useT();
  const save = async (key: 'daily' | 'monthly', v: number | null): Promise<string | null> => {
    const r = await saveSettings({ budget: { [key]: v } });
    return r.ok ? null : r.message;
  };
  return (
    <Section title={t('settings.budget.title')} testId="settings-budget">
      <Row title={t('settings.budget.daily')} hint={t('settings.budget.dailyHint')}>
        <BudgetField label={t('settings.budget.daily')} testId="settings-budget-daily" value={settings.budget.daily} onSave={(v) => save('daily', v)} />
      </Row>
      <Row title={t('settings.budget.monthly')} hint={t('settings.budget.monthlyHint')}>
        <BudgetField label={t('settings.budget.monthly')} testId="settings-budget-monthly" value={settings.budget.monthly} onSave={(v) => save('monthly', v)} />
      </Row>
    </Section>
  );
}
