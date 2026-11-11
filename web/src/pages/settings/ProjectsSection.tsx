import { useState } from 'react';
import { useProjects } from '../../api/hooks.ts';
import { apiSend } from '../../api/clientC.ts';
import type { ProjectItem, SettingsData } from '../../api/types.ts';
import { Chip } from '../../design/Button.tsx';
import { Icon } from '../../design/icons.tsx';
import { Skeleton } from '../../design/Skeleton.tsx';
import { reloadSettings, runAction, saveSettings } from '../../features/settings/save.ts';
import { useT } from '../../state/store.ts';
import { Row, Section, Switch } from './parts.tsx';
import s from './Settings.module.css';

async function patchOverride(body: { id: string; name?: string | null; hidden?: boolean; pinned?: boolean }): Promise<string | null> {
  const r = await runAction(() => apiSend<unknown>('PUT', '/api/project-overrides', body));
  if (!r.ok) return r.message;
  await reloadSettings().catch(() => undefined);
  return null;
}

function ProjectRow({ p, child, onError }: { p: ProjectItem; child?: boolean; onError: (m: string | null) => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.displayName);

  const commitName = async (): Promise<void> => {
    const v = name.trim();
    if (v === p.displayName) {
      setEditing(false);
      return;
    }
    // 与自动识别的名称相同或留空 = 清除重命名
    const clear = v === '' || v === p.defaultName;
    const e = await patchOverride({ id: p.id, name: clear ? null : v });
    onError(e);
    if (!e) setEditing(false);
  };

  return (
    <div className={`${s.projRow} ${child ? s.projChild : ''}`} data-testid="manage-row" data-id={p.id}>
      {editing ? (
        <div className={s.renameBox}>
          <input
            className={`${s.field} ${s.grow}`}
            type="text"
            maxLength={80}
            value={name}
            autoFocus
            aria-label={t('settings.projects.renameAria', { name: p.displayName })}
            data-testid="manage-rename-input"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitName();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
          <Chip primary data-testid="manage-rename-save" onClick={() => void commitName()}>
            {t('settings.save')}
          </Chip>
          <Chip onClick={() => setEditing(false)}>{t('settings.cancel')}</Chip>
        </div>
      ) : (
        <>
          <div className={s.projNames}>
            <div className={s.projName} data-testid="manage-name">
              {p.pinned && (
                <span className={s.pinMark} title={t('settings.projects.pinned')}>
                  <Icon name="pin" size={15} />
                </span>
              )}
              {p.displayName}
              {p.renamed && p.defaultName && <span className={s.badge}>{t('settings.projects.renamedFrom', { name: p.defaultName })}</span>}
            </div>
            {!p.isScratchGroup && <div className={s.projPath}>{p.path ?? t('sidebar.noPath', { key: p.id })}</div>}
          </div>
          <div className={s.actions}>
            {!p.isScratchGroup && (
              <Chip small data-testid="manage-rename" onClick={() => { setName(p.displayName); setEditing(true); }}>
                {t('settings.projects.rename')}
              </Chip>
            )}
            {p.renamed && (
              <Chip small data-testid="manage-rename-reset" onClick={() => void patchOverride({ id: p.id, name: null }).then(onError)}>
                {t('settings.projects.renameReset')}
              </Chip>
            )}
            <Chip small data-testid="manage-pin" aria-pressed={p.pinned} onClick={() => void patchOverride({ id: p.id, pinned: !p.pinned }).then(onError)}>
              {p.pinned ? t('settings.projects.unpin') : t('settings.projects.pin')}
            </Chip>
            <Chip small data-testid="manage-hide" onClick={() => void patchOverride({ id: p.id, hidden: true }).then(onError)}>
              {t('settings.projects.hide')}
            </Chip>
          </div>
        </>
      )}
    </div>
  );
}

/** 项目管理：Scratch 归并开关、重命名 / 置顶 / 隐藏、已隐藏项目恢复。覆盖规则只存应用数据目录，不改任何源数据。 */
export function ProjectsSection({ settings }: { settings: SettingsData }) {
  const t = useT();
  const projects = useProjects();
  const data = projects.data;
  const [err, setErr] = useState<string | null>(null);
  const hidden = data?.hidden ?? [];

  return (
    <Section title={t('settings.projects.title')} testId="settings-projects">
      <Row title={t('settings.projects.scratch')} hint={t('settings.projects.scratchHint')}>
        <Switch checked={settings.groupScratch} label={t('settings.projects.scratch')} testId="settings-scratch" onChange={(v) => void saveSettings({ groupScratch: v })} />
      </Row>
      {err && (
        <div className={`${s.msg} ${s.msgErr}`} role="alert" data-testid="manage-error">
          {err}
        </div>
      )}
      {!data ? (
        <Skeleton width="100%" height={120} />
      ) : (
        data.projects.map((p) => (
          <div key={p.id}>
            <ProjectRow p={p} onError={setErr} />
            {p.children?.map((c) => <ProjectRow key={c.id} p={c} child onError={setErr} />)}
          </div>
        ))
      )}
      <div className={s.foot} data-testid="manage-hidden-count">
        {t('settings.projects.hiddenCount', { n: hidden.length })}
      </div>
      {hidden.length > 0 && (
        <div className={s.hiddenList}>
          {hidden.map((h) => (
            <div key={h.id} className={s.projRow} data-testid="manage-hidden-row" data-id={h.id}>
              <div className={s.projNames}>
                <div className={s.projName}>
                  <Icon name="eyeOff" size={15} />
                  {h.isScratchGroup ? t('sidebar.scratch') : h.displayName}
                </div>
                <div className={s.projPath}>{h.path ?? ''}</div>
              </div>
              <Chip small data-testid="manage-unhide" onClick={() => void patchOverride({ id: h.id, hidden: false }).then(setErr)}>
                {t('settings.projects.unhide')}
              </Chip>
            </div>
          ))}
          {hidden.length > 1 && (
            <div style={{ paddingTop: 12 }}>
              <Chip small data-testid="manage-unhide-all" onClick={() => void runAction(() => apiSend<unknown>('POST', '/api/project-overrides/unhide-all')).then((r) => { setErr(r.ok ? null : r.message); if (r.ok) void reloadSettings().catch(() => undefined); })}>
                {t('settings.projects.unhideAll')}
              </Chip>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
