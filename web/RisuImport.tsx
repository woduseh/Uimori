import { legacyMessage } from './i18n.js';
import {
  t,
  useI18n,
  translateMessage,
  formatNumber,
  message as retainedMessage,
  messageRef,
} from './i18n.js';
import { RisuImageHandoffFields } from './RisuImageHandoffFields.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { readLargeImportSource as readSource } from './import-source.js';
import { useRef, useState } from 'react';
import { RISU_IMPORT_MAX_BYTES, RISU_IMPORT_MAX_UPLOAD_BYTES } from '../core/risu-import.js';
import type {
  RisuImportApply,
  RisuImportKind,
  RisuImportPreview,
  RisuImportResult,
  RisuImportSource,
  RisuImportStagedSource,
} from '../core/risu-import.js';
import { ApiError, api } from './api.js';
import { SelectionCheckbox } from './BooleanControls.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { CheckIcon, UploadIcon } from './ui-icons.js';
import './risu-import.css';

/** Findings are host diagnostics; card text, names, and scripts never pass through this formatter. */
function importFindingMessage(finding: RisuImportPreview['findings'][number]): string {
  switch (finding.code) {
    case 'asset-unavailable':
      return t('transfer.finding.asset-unavailable');
    case 'asset-invalid':
      return t('transfer.finding.asset-invalid');
    case 'asset-format':
      return t('transfer.finding.asset-format');
    case 'asset-role':
      return t('transfer.finding.asset-role');
    case 'lore-not-activated':
      return t('transfer.finding.lore-not-activated');
    case 'lore-decorator-position':
      return t('transfer.finding.lore-decorator-position');
    case 'disabled-lore':
      return t('transfer.finding.disabled-lore');
    case 'creator-notes-truncated':
      return t('transfer.finding.creator-notes-truncated');
    case 'native-lore-model':
      return t('transfer.finding.native-lore-model');
    case 'source-file-not-retained':
      return t('transfer.finding.source-file-not-retained');
    case 'native-risu':
      return t('transfer.finding.native-risu');
    case 'native-model-calls':
      return t('transfer.finding.native-model-calls');
    case 'native-variable-projection':
      return t('transfer.finding.native-variable-projection');
  }
  if (finding.code.startsWith('lore-decorator:')) {
    const decorator = finding.code.slice('lore-decorator:'.length);
    return finding.level === 'unsupported'
      ? t('transfer.finding.decoratorPosition', { decorator })
      : t('transfer.finding.decoratorActivation', { decorator });
  }
  if (finding.code === 'lore-decorator-unknown') {
    const match =
      /^Risu가 인식하지 못하는 `@@` 지시문은 가져온 로어 본문에서 제외돼요\. Risu 원문에는 남아요: (.*?)(?: 외 (\d+)개)?$/su.exec(
        finding.message
      );
    if (match)
      return t('transfer.finding.decoratorUnknown', {
        names: match[1],
        more: Number(match[2] ?? 0),
      });
  }
  return translateMessage(finding.message);
}

/** Always-on lore stays pinned; optional lore is selected by JEV. */
function loreLoadingLabel(entry: RisuImportPreview['lore'][number]): string {
  return entry.loading === 'pinned' ? t('transfer.m001') : t('transfer.m002');
}

/** Ordinary close retains the review; explicit discard clears only an unapplied, certain draft. */
export function RisuImport({
  showTrigger = true,
  defaultKind = '',
  reload,
  onContinueChat,
}: {
  showTrigger?: boolean;
  defaultKind?: RisuImportKind | '';
  reload: () => Promise<void>;
  onContinueChat?: (chatId: string) => void;
}) {
  useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const preparation = useRef<AbortController | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [source, setSource] = useState<RisuImportSource | RisuImportStagedSource | null>(null);
  const [kind, setKind] = useState<RisuImportKind | ''>('');
  const [preview, setPreview] = useState<RisuImportPreview | null>(null);
  const [imageHandoffIds, setImageHandoffIds] = useState<string[]>([]);
  const [allowPartial, setAllowPartial] = useState(false);
  const [createChat, setCreateChat] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [result, setResult] = useState<RisuImportResult | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const submission = useRef<RisuImportApply | null>(null);
  const requestKey = useRef<string | null>(null);
  const unsupported = preview?.findings.some((finding) => finding.level === 'unsupported');
  const locked = busy || uncertain || !!result;
  const ready = !!source && !!preview && (uncertain || !unsupported || allowPartial);
  const selectedKind = preview?.kind ?? kind;
  const kindLabel =
    selectedKind === 'module'
      ? t('transfer.m003')
      : selectedKind === 'persona'
        ? t('transfer.m004')
        : selectedKind === 'bot'
          ? t('transfer.m005')
          : t('transfer.m006');

  function selectionChanged() {
    submission.current = null;
    requestKey.current = null;
    setError('');
  }

  async function prepare(file: File) {
    if (active.current || uncertain) return;
    active.current = true;
    setBusy(true);
    const controller = new AbortController();
    preparation.current = controller;
    setPreparing(true);
    setError('');
    setNotice('');
    try {
      if (!/\.(charx|jpe?g|png|risum|json|zip)$/i.test(file.name))
        throw new Error(legacyMessage('transfer.m007'));
      if (file.size === 0) throw new Error(legacyMessage('transfer.m008'));
      if (file.size > RISU_IMPORT_MAX_UPLOAD_BYTES)
        throw new Error(
          retainedMessage('transfer.d001', {
            v0: Math.round(RISU_IMPORT_MAX_UPLOAD_BYTES / 1024 / 1024),
          })
        );
      if (file.size > RISU_IMPORT_MAX_BYTES)
        setNotice(
          retainedMessage('transfer.d002', { v0: Math.round(RISU_IMPORT_MAX_BYTES / 1024 / 1024) })
        );
      const nextSource = await readSource(file, controller.signal);
      const nextPreview = await api<RisuImportPreview>(
        '/risu-imports/prepare',
        {
          source: nextSource,
          ...(kind ? { kind } : {}),
        },
        'POST',
        controller.signal
      );
      setSource(nextSource);
      setPreview(nextPreview);
      setImageHandoffIds(
        nextPreview.imageHandoff?.ranges
          .filter((range) => range.enabled)
          .map((range) => range.id) ?? []
      );
      setAllowPartial(false);
      setResult(null);
      submission.current = null;
      requestKey.current = null;
    } catch (cause) {
      if (controller.signal.aborted) setNotice(retainedMessage('transfer.m009'));
      else
        setError(
          retainedMessage('transfer.reviewError', {
            error: messageRef((cause as Error).message),
            retained: !!preview,
          })
        );
    } finally {
      preparation.current = null;
      setPreparing(false);
      active.current = false;
      setBusy(false);
    }
  }

  async function changeKind(nextKind: RisuImportKind | '') {
    if (active.current || uncertain || result) return;
    if (!source) {
      setKind(nextKind);
      selectionChanged();
      return;
    }
    active.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const nextPreview = await api<RisuImportPreview>('/risu-imports/prepare', {
        source,
        ...(preview?.preparedId ? { preparedId: preview.preparedId } : {}),
        ...(nextKind ? { kind: nextKind } : {}),
      });
      setKind(nextKind);
      setPreview(nextPreview);
      setImageHandoffIds(
        nextPreview.imageHandoff?.ranges
          .filter((range) => range.enabled)
          .map((range) => range.id) ?? []
      );
      setAllowPartial(false);
      selectionChanged();
    } catch (cause) {
      setError(retainedMessage('transfer.d003', { v0: messageRef((cause as Error).message) }));
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  async function refreshAndOpen(imported: RisuImportResult) {
    try {
      await reload();
      if (preview?.kind !== 'bot') return;
      if (imported.chat && onContinueChat) {
        setOpen(false);
        onContinueChat(imported.chat.id);
      } else if (imported.chat) {
        setNotice(retainedMessage('transfer.m011'));
      }
    } catch {
      setNotice(
        preview?.kind === 'module'
          ? retainedMessage('transfer.m012')
          : preview?.kind === 'persona'
            ? retainedMessage('transfer.m013')
            : imported.chat
              ? retainedMessage('transfer.m014')
              : retainedMessage('transfer.m015')
      );
    }
  }

  async function apply() {
    if (active.current || !source || !preview || !ready || result) return;
    const payload = submission.current ?? {
      source,
      ...(preview.preparedId ? { preparedId: preview.preparedId } : {}),
      ...(kind ? { kind } : {}),
      digest: preview.digest,
      allowPartial,
      imageHandoffIds,
      createChat: preview.kind === 'bot' && createChat,
      idempotencyKey: (requestKey.current ??= crypto.randomUUID()),
    };
    submission.current = payload;
    active.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const imported = await api<RisuImportResult>('/risu-imports/apply', payload);
      setResult(imported);
      setUncertain(false);
      await refreshAndOpen(imported);
    } catch (cause) {
      const confirmedFailure =
        !uncertain &&
        cause instanceof ApiError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        cause.status !== 408;
      setUncertain(!confirmedFailure);
      if (confirmedFailure) submission.current = null;
      setError((cause as Error).message);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  async function openSavedChat() {
    if (active.current || !result) return;
    active.current = true;
    setBusy(true);
    setNotice('');
    try {
      await refreshAndOpen(result);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  function discardAndClose() {
    if (active.current || uncertain || result) return;
    const preparedId = preview?.preparedId;
    const uploadId = source?.uploadId;
    setSource(null);
    setPreview(null);
    setKind(defaultKind);
    setImageHandoffIds([]);
    setAllowPartial(false);
    setCreateChat(false);
    setError('');
    setNotice('');
    submission.current = null;
    requestKey.current = null;
    setOpen(false);
    if (preparedId || uploadId)
      void api('/risu-imports/discard', {
        ...(preparedId ? { preparedId } : {}),
        ...(uploadId ? { uploadId } : {}),
      }).catch(() => {
        // Local discard is complete; expiry cleanup handles an unreachable server or locked files.
      });
  }

  return (
    <>
      {showTrigger && (
        <IconButton
          label={t('transfer.m016')}
          className="secondary"
          icon={UploadIcon}
          onClick={() => {
            if (!source && !active.current) setKind(defaultKind);
            setOpen(true);
          }}
        />
      )}
      <Dialog
        open={open}
        title={t('transfer.m016')}
        onClose={() => setOpen(false)}
        className="risu-import-dialog"
        wide
      >
        <section
          className={`risu-import-body${result ? ' complete' : ''}`}
          aria-label={t('transfer.m017')}
          aria-busy={busy}
        >
          {!preview && <p className="muted">{t('transfer.m018')}</p>}
          <label className={`risu-import-file${preview ? ' risu-import-file-ready' : ''}`}>
            <span>
              {preview
                ? source?.name
                : t('transfer.d004', {
                    v0: Math.round(RISU_IMPORT_MAX_UPLOAD_BYTES / 1024 / 1024),
                  })}
            </span>
            <input
              type="file"
              aria-label={t('transfer.m019')}
              accept=".charx,.jpg,.jpeg,.png,.risum,.json,.zip,application/json,application/zip,image/png,image/jpeg"
              disabled={busy || uncertain}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void prepare(file);
              }}
            />
            {preview && <span className="risu-import-change">{t('transfer.m020')}</span>}
          </label>
          <details className="risu-import-processing">
            <summary>
              {preview
                ? t('transfer.importTypeChange', { kind: preview.kind })
                : t('transfer.d005', { v0: kindLabel })}
            </summary>
            <div>
              <label>
                {preview ? t('transfer.m023') : t('transfer.m024')}
                <select
                  value={kind}
                  disabled={locked}
                  onChange={(event) => void changeKind(event.target.value as RisuImportKind | '')}
                >
                  <option value="">{t('transfer.m006')}</option>
                  <option value="bot">{t('transfer.m005')}</option>
                  <option value="persona">{t('transfer.m004')}</option>
                  <option value="module">{t('transfer.m003')}</option>
                </select>
              </label>
              <p className="muted">{t('transfer.m025')}</p>
              {preview && preview.lore.length > 0 && <p className="muted">{t('transfer.m026')}</p>}
              <p className="muted">{t('transfer.m027')}</p>
            </div>
          </details>
          {preview && (
            <>
              <div className="risu-import-summary risu-import-hero">
                <h3>{preview.title}</h3>
                {preview.description && <p>{preview.description}</p>}
                <dl className="risu-import-counts">
                  <div>
                    <dt>{t('transfer.m028')}</dt>
                    <dd>{formatNumber(preview.summary.lore)}</dd>
                  </div>
                  <div>
                    <dt>{t('transfer.m029')}</dt>
                    <dd>{formatNumber(preview.summary.starts)}</dd>
                  </div>
                  <div>
                    <dt>{t('transfer.m030')}</dt>
                    <dd>{formatNumber(preview.summary.images)}</dd>
                  </div>
                </dl>
              </div>
              {preview.findings.length > 0 && (
                <section
                  className={`risu-import-findings${unsupported ? ' warn' : ''}`}
                  aria-label={t('transfer.m031')}
                >
                  <h3>{unsupported ? t('transfer.m032') : t('transfer.m033')}</h3>
                  <ul>
                    {preview.findings.map((finding, index) => (
                      <li key={`${finding.code}:${index}`}>
                        <strong>
                          {finding.level === 'unsupported'
                            ? t('transfer.m034')
                            : finding.level === 'warning'
                              ? t('transfer.m035')
                              : t('transfer.m036')}
                          {' · '}
                        </strong>
                        {importFindingMessage(finding)}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {preview.imageHandoff && (
                <RisuImageHandoffFields
                  policy={preview.imageHandoff}
                  selected={imageHandoffIds}
                  disabled={locked}
                  onChange={(ids) => {
                    setImageHandoffIds(ids);
                    selectionChanged();
                  }}
                />
              )}
              {preview.lore.length > 0 && (
                <details className="risu-import-preview" key={preview.digest}>
                  <summary>{t('transfer.lorePreview', { count: preview.lore.length })}</summary>
                  {preview.lore.map((entry) => (
                    <details key={entry.id} className="risu-import-lore-entry">
                      <summary>{entry.title || t('transfer.m039')}</summary>
                      <small className="muted">
                        {entry.enabled ? t('transfer.m040') : t('transfer.m041')} ·{' '}
                        {loreLoadingLabel(entry)}
                      </small>
                      <p className="risu-import-lore-text">{entry.text || t('transfer.m042')}</p>
                    </details>
                  ))}
                </details>
              )}
              {unsupported && (
                <label className="risu-import-choice risu-import-partial">
                  <SelectionCheckbox
                    checked={allowPartial}
                    disabled={locked}
                    onChange={(event) => {
                      setAllowPartial(event.target.checked);
                      selectionChanged();
                    }}
                  />
                  <span>{t('transfer.m043')}</span>
                </label>
              )}
              {preview.kind === 'bot' && !result && (
                <label className="risu-import-choice">
                  <SelectionCheckbox
                    checked={createChat}
                    disabled={locked}
                    onChange={(event) => {
                      setCreateChat(event.target.checked);
                      selectionChanged();
                    }}
                  />
                  <span>{t('transfer.m044')}</span>
                </label>
              )}
              {uncertain && (
                <NoticeBanner>
                  {t('transfer.uncertainResource', {
                    kind: preview.kind === 'bot' && createChat ? 'chat' : preview.kind,
                  })}
                </NoticeBanner>
              )}
              {result ? (
                <div className="risu-import-result">
                  <CheckIcon size={28} aria-hidden="true" />
                  <h3>{t('transfer.m051')}</h3>
                  <p className="muted">{preview.title}</p>
                  <p role="status">
                    {preview.kind === 'module'
                      ? t('transfer.m052')
                      : preview.kind === 'persona'
                        ? t('transfer.m053')
                        : result.chat
                          ? t('transfer.m054')
                          : submission.current?.createChat === false
                            ? t('transfer.m055')
                            : t('transfer.m056')}
                  </p>
                  {result.chat && onContinueChat && (
                    <button type="button" disabled={busy} onClick={() => void openSavedChat()}>
                      {t('transfer.m057')}
                    </button>
                  )}
                </div>
              ) : (
                <button type="button" disabled={busy || !ready} onClick={() => void apply()}>
                  {uncertain
                    ? t('transfer.m058')
                    : preview.kind !== 'bot'
                      ? t('transfer.importKind', { kind: preview.kind })
                      : createChat
                        ? t('transfer.m059')
                        : t('transfer.m060')}
                </button>
              )}
              {!result && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || uncertain}
                  title={uncertain ? t('transfer.m061') : undefined}
                  onClick={discardAndClose}
                >
                  {t('transfer.m062')}
                </button>
              )}
            </>
          )}
          {busy && <LoadingState presentation="inline" label={t('transfer.m063')} />}
          {preparing && (
            <button type="button" onClick={() => preparation.current?.abort()}>
              {t('transfer.m064')}
            </button>
          )}
          {notice && <NoticeBanner>{translateMessage(notice)}</NoticeBanner>}
          {error && (
            <NoticeBanner className="error" tone="error">
              {translateMessage(error)}
            </NoticeBanner>
          )}
        </section>
      </Dialog>
    </>
  );
}
