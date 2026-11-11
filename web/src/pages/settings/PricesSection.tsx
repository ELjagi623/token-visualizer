import { useEffect, useMemo, useState } from 'react';
import { apiSend } from '../../api/clientC.ts';
import { Chip } from '../../design/Button.tsx';
import { Icon } from '../../design/icons.tsx';
import { Pill } from '../../design/Pill.tsx';
import { Skeleton } from '../../design/Skeleton.tsx';
import { parsePriceInput, priceToText } from '../../features/cost/format.ts';
import { usePrices } from '../../features/cost/hooks.ts';
import type { PriceRuleDto, PricesPayload } from '../../features/cost/types.ts';
import { runAction } from '../../features/settings/save.ts';
import { useT } from '../../state/store.ts';
import { Section, Warn } from './parts.tsx';
import s from './Settings.module.css';

const FIELDS = ['inputUsdPerM', 'outputUsdPerM', 'cacheWrite5mUsdPerM', 'cacheWrite1hUsdPerM', 'cacheReadUsdPerM'] as const;
type Field = (typeof FIELDS)[number];
const FIELD_LABEL: Record<Field, 'settings.prices.input' | 'settings.prices.output' | 'settings.prices.w5m' | 'settings.prices.w1h' | 'settings.prices.read'> = {
  inputUsdPerM: 'settings.prices.input',
  outputUsdPerM: 'settings.prices.output',
  cacheWrite5mUsdPerM: 'settings.prices.w5m',
  cacheWrite1hUsdPerM: 'settings.prices.w1h',
  cacheReadUsdPerM: 'settings.prices.read',
};

interface Draft {
  key: string;
  id: string;
  pattern: string;
  match: PriceRuleDto['match'];
  fields: Record<Field, string>;
  fastMultiplier: number | null;
  sourceUrl: string | null;
  checkedAt: string | null;
  origin: 'user' | 'builtin';
  isNew: boolean;
}

function toDraft(r: PriceRuleDto, isNew = false): Draft {
  return {
    key: `${r.origin ?? 'user'}:${r.id}`,
    id: r.id,
    pattern: r.pattern,
    match: r.match,
    fields: Object.fromEntries(FIELDS.map((f) => [f, priceToText(r[f])])) as Record<Field, string>,
    fastMultiplier: r.fastMultiplier,
    sourceUrl: r.sourceUrl,
    checkedAt: r.checkedAt,
    origin: r.origin ?? 'user',
    isNew,
  };
}

function fieldsEqual(d: Draft, r: PriceRuleDto): boolean {
  return FIELDS.every((f) => {
    const p = parsePriceInput(d.fields[f]);
    return p === r[f];
  });
}

function isComplete(d: Draft): boolean {
  return FIELDS.every((f) => {
    const p = parsePriceInput(d.fields[f]);
    return p !== null && p !== 'invalid';
  });
}

let seq = 0;

/** 模型价格表：内置默认（官方页核对，带来源与日期）+ 用户规则；可编辑、新增、还原；空 = 未配置（成本显示 —，不当 0）。 */
export function PricesSection() {
  const t = useT();
  const prices = usePrices();
  const data: PricesPayload | null = prices.data;
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [baseline, setBaseline] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [savedAt, setSavedAt] = useState(0);

  const builtinById = useMemo(() => new Map((data?.builtin ?? []).map((r) => [r.id, r])), [data]);

  // 服务端数据变化（首次加载 / 保存后）→ 重置草稿
  useEffect(() => {
    if (!data) return;
    const ds = data.effective.map((r) => toDraft(r));
    setDrafts(ds);
    setBaseline(JSON.stringify(ds));
    setError(null);
  }, [data?.version, data?.builtinCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = JSON.stringify(drafts) !== baseline;
  const incomplete = drafts.filter((d) => !isComplete(d)).length;

  const patch = (key: string, f: Partial<Draft>): void => setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...f } : d)));
  const setField = (key: string, field: Field, v: string): void => setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, fields: { ...d.fields, [field]: v }, sourceUrl: d.origin === 'builtin' ? null : d.sourceUrl, checkedAt: d.origin === 'builtin' ? null : d.checkedAt } : d)));

  const addRule = (): void => {
    seq++;
    const id = `u${Date.now().toString(36)}${seq}`;
    setDrafts((ds) => [
      {
        key: `user:${id}`,
        id,
        pattern: '',
        match: 'prefix',
        fields: { inputUsdPerM: '', outputUsdPerM: '', cacheWrite5mUsdPerM: '', cacheWrite1hUsdPerM: '', cacheReadUsdPerM: '' },
        fastMultiplier: null,
        sourceUrl: null,
        checkedAt: null,
        origin: 'user',
        isNew: true,
      },
      ...ds,
    ]);
  };

  const revert = (d: Draft): void => {
    const b = builtinById.get(d.id);
    if (!b) return;
    patch(d.key, { ...toDraft({ ...b, origin: 'builtin' }), key: d.key });
  };

  const save = async (): Promise<void> => {
    setError(null);
    const rules: unknown[] = [];
    for (const d of drafts) {
      if (d.pattern.trim() === '') {
        setError(t('settings.prices.errPattern'));
        return;
      }
      const vals: Record<string, number | null> = {};
      for (const f of FIELDS) {
        const p = parsePriceInput(d.fields[f]);
        if (p === 'invalid') {
          setError(t('settings.prices.errNumber', { model: d.pattern, field: t(FIELD_LABEL[f]) }));
          return;
        }
        vals[f] = p;
      }
      const b = d.origin === 'builtin' ? builtinById.get(d.id) : undefined;
      if (b && d.origin === 'builtin' && fieldsEqual(d, b)) continue; // 未改动的内置规则不存
      rules.push({ id: d.id, pattern: d.pattern.trim(), match: d.match, ...vals, fastMultiplier: d.fastMultiplier, sourceUrl: d.sourceUrl, checkedAt: d.checkedAt });
    }
    const r = await runAction(() => apiSend<PricesPayload>('PUT', '/api/prices', { rules }));
    if (!r.ok) setError(r.message);
    else {
      setSavedAt(Date.now());
      prices.reload();
    }
  };

  const reset = async (): Promise<void> => {
    setConfirmReset(false);
    const r = await runAction(() => apiSend<PricesPayload>('POST', '/api/prices/reset'));
    if (!r.ok) setError(r.message);
    else {
      setSavedAt(Date.now());
      prices.reload();
    }
  };

  const checkedDates = (data?.builtin ?? []).map((r) => r.checkedAt).filter((x): x is string => x !== null).sort();
  const checkedAt = checkedDates[checkedDates.length - 1] ?? null;

  return (
    <Section
      title={t('settings.prices.title')}
      desc={t('settings.prices.desc')}
      testId="settings-prices"
      aside={
        <Pill tone="blue" dot={false} data-testid="settings-prices-badge">
          {t('cost.badge')}
        </Pill>
      }
    >
      {incomplete > 0 && <Warn testId="settings-prices-warn">{t('settings.prices.warn', { n: incomplete })}</Warn>}
      {!data ? (
        <Skeleton width="100%" height={160} />
      ) : (
        <div className={s.scroll} style={{ marginTop: 12 }}>
          <table className={s.table} data-testid="settings-prices-table">
            <thead>
              <tr>
                <th scope="col">{t('settings.prices.model')}</th>
                {FIELDS.map((f) => (
                  <th key={f} scope="col">
                    {t(FIELD_LABEL[f])}
                  </th>
                ))}
                <th scope="col">{t('settings.prices.status')}</th>
                <th scope="col">
                  <span className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
                    {t('settings.prices.actions')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((d) => {
                const b = builtinById.get(d.id);
                const modified = d.origin === 'user' && b !== undefined;
                const complete = isComplete(d);
                const editablePattern = d.isNew || (d.origin === 'user' && !b);
                const label = d.pattern || t('settings.prices.newRule');
                return (
                  <tr key={d.key} data-testid="price-row" data-id={d.id} data-origin={d.origin}>
                    <td className={s.model}>
                      {editablePattern ? (
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <input className={s.field} style={{ width: 170 }} type="text" value={d.pattern} placeholder={t('settings.prices.patternPh')} aria-label={t('settings.prices.pattern')} data-testid="price-pattern" onChange={(e) => patch(d.key, { pattern: e.target.value })} />
                          <select className={s.field} style={{ width: 96 }} value={d.match} aria-label={t('settings.prices.match')} onChange={(e) => patch(d.key, { match: e.target.value as Draft['match'] })}>
                            <option value="exact">{t('settings.prices.match.exact')}</option>
                            <option value="prefix">{t('settings.prices.match.prefix')}</option>
                            <option value="glob">{t('settings.prices.match.glob')}</option>
                          </select>
                        </div>
                      ) : (
                        <>
                          {d.pattern}
                          {d.match !== 'exact' && <span className={s.badge}>{t(`settings.prices.match.${d.match}`)}</span>}
                          {modified && <span className={s.badge}>{t('settings.prices.custom')}</span>}
                          {d.fastMultiplier !== null && (
                            <span className={s.badge} title={t('settings.prices.fastTip', { x: d.fastMultiplier })}>
                              fast ×{d.fastMultiplier}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    {FIELDS.map((f) => (
                      <td key={f}>
                        <input
                          className={`${s.field} ${s.fieldSm}`}
                          type="text"
                          inputMode="decimal"
                          placeholder="—"
                          value={d.fields[f]}
                          aria-label={`${label} ${t(FIELD_LABEL[f])}`}
                          aria-invalid={parsePriceInput(d.fields[f]) === 'invalid'}
                          data-testid={`price-${f}`}
                          onChange={(e) => setField(d.key, f, e.target.value)}
                        />
                      </td>
                    ))}
                    <td>
                      <Pill tone={complete ? 'green' : 'amber'} size="sm" title={d.origin === 'builtin' && d.checkedAt ? t('settings.prices.checkedTip', { date: d.checkedAt }) : undefined} data-testid="price-status">
                        {complete ? t('settings.prices.configured') : t('settings.prices.unset')}
                      </Pill>
                    </td>
                    <td>
                      <div className={s.rowActions}>
                        {modified && (
                          <button type="button" className={s.iconBtn} title={t('settings.prices.revert')} aria-label={t('settings.prices.revert')} data-testid="price-revert" onClick={() => revert(d)}>
                            <Icon name="undo" size={16} />
                          </button>
                        )}
                        {d.origin === 'user' && !b && (
                          <button type="button" className={s.iconBtn} title={t('settings.prices.remove')} aria-label={t('settings.prices.remove')} data-testid="price-remove" onClick={() => setDrafts((ds) => ds.filter((x) => x.key !== d.key))}>
                            <Icon name="trash" size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td className={s.model}>{t('settings.prices.localRow')}</td>
                <td colSpan={5} style={{ color: 'var(--muted)' }}>
                  {t('settings.prices.localDesc')}
                </td>
                <td colSpan={2}>
                  <Pill tone="blue" size="sm">
                    {t('settings.prices.local')}
                  </Pill>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {error && (
        <div className={`${s.msg} ${s.msgErr}`} role="alert" style={{ marginTop: 10 }} data-testid="settings-prices-error">
          {error}
        </div>
      )}
      <div className={s.actions} style={{ marginTop: 16 }}>
        <Chip data-testid="price-add" onClick={addRule}>
          <Icon name="plus" size={16} />
          {t('settings.prices.add')}
        </Chip>
        <Chip primary data-testid="price-save" disabled={!dirty} onClick={() => void save()}>
          {t('settings.prices.save')}
        </Chip>
        <Chip
          data-testid="price-discard"
          disabled={!dirty}
          onClick={() => {
            if (data) {
              const ds = data.effective.map((r) => toDraft(r));
              setDrafts(ds);
              setBaseline(JSON.stringify(ds));
              setError(null);
            }
          }}
        >
          {t('settings.prices.discard')}
        </Chip>
        {!confirmReset ? (
          <Chip data-testid="price-reset" disabled={!data || data.rules.length === 0} onClick={() => setConfirmReset(true)}>
            {t('settings.prices.reset')}
          </Chip>
        ) : (
          <>
            <span className={s.msg}>{t('settings.prices.resetConfirm')}</span>
            <Chip primary data-testid="price-reset-confirm" onClick={() => void reset()}>
              {t('settings.prices.resetYes')}
            </Chip>
            <Chip onClick={() => setConfirmReset(false)}>{t('settings.cancel')}</Chip>
          </>
        )}
        {savedAt > 0 && !dirty && (
          <span className={`${s.msg} ${s.msgOk}`} role="status">
            {t('settings.saved')}
          </span>
        )}
      </div>
      <p className={s.foot}>{checkedAt ? t('settings.prices.foot', { date: checkedAt, version: data?.defaultsVersion ?? '' }) : t('settings.prices.footNoDate')}</p>
    </Section>
  );
}
