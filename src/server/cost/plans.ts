/** 订阅档位默认月费（src/server/data/plans.default.json，开发时联网核对官方定价页；运行时不联网）。 */
import plansDefault from '../data/plans.default.json' with { type: 'json' };
import { getServerLang } from '../i18n.ts';

export interface PlanDefault {
  id: 'pro' | 'max5x' | 'max20x';
  label: string;
  /** null = 未核对到，界面要求用户手填 */
  monthlyFeeUsd: number | null;
  sourceUrl: string | null;
  checkedAt: string | null;
  note: string | null;
}

export interface PlansPayload {
  defaultsVersion: string;
  plans: PlanDefault[];
}

export function builtinPlans(): PlansPayload {
  const raw = plansDefault as unknown as { defaultsVersion: string; plans: Array<Partial<PlanDefault> & { noteEn?: string }> };
  return {
    defaultsVersion: raw.defaultsVersion,
    plans: raw.plans.map((p) => ({
      id: p.id as PlanDefault['id'],
      label: String(p.label),
      monthlyFeeUsd: typeof p.monthlyFeeUsd === 'number' ? p.monthlyFeeUsd : null,
      sourceUrl: p.sourceUrl ?? null,
      checkedAt: p.checkedAt ?? null,
      note: (getServerLang() === 'en' ? (p.noteEn ?? p.note) : p.note) ?? null,
    })),
  };
}
