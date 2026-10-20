import { legacyMessage } from './i18n.js';
import {
  t,
  useI18n,
  translateMessage,
  formatNumber,
  message as retainedMessage,
  messageRef,
} from './i18n.js';
import { readImportSource as readSource } from './import-source.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useRef, useState } from 'react';
import type { PromptPreset } from '../core/product.js';
import { RISU_IMPORT_MAX_BYTES, type RisuImportSource } from '../core/risu-import.js';
import type {
  RisuPresetImportApply,
  RisuPresetImportPreview,
  RisuPresetImportResult,
} from '../core/risu-preset.js';
import { ApiError, api } from './api.js';
import { SelectionCheckbox } from './BooleanControls.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { CheckIcon, UploadIcon } from './ui-icons.js';
import './risu-import.css';

/** Parse only the complete host diagnostic contract; embedded card values remain verbatim. */
function presetFindingMessage(finding: RisuPresetImportPreview['findings'][number]): string {
  switch (finding.code) {
    case 'RISU_PRESET_HOST_MEMORY':
      return t('transfer.finding.RISU_PRESET_HOST_MEMORY');
    case 'RISU_PRESET_NATIVE_PROMPT':
      return t('transfer.finding.RISU_PRESET_NATIVE_PROMPT');
    case 'RISU_PRESET_UNSUPPORTED_BLOCK': {
      const match =
        /^(\d+)번 블록\((.*)\)은 저장되지만 실행되지 않아요\. 실행하려면 지원하는 종류의 프롬프트 블록으로 바꿔 주세요\.$/su.exec(
          finding.message
        );
      if (match)
        return t('transfer.finding.unsupportedBlock', { index: Number(match[1]), type: match[2] });
      break;
    }
    case 'RISU_PRESET_HOST_SETTING': {
      const match =
        /^(utilOverride|customChainOfThought)로 지정한 Risu 내장 프롬프트 설정은 적용하지 않아요\. 프리셋의 프롬프트 블록과 Uimori의 작업·모델 설정을 사용해요\.$/u.exec(
          finding.message
        );
      if (match) return t('transfer.finding.hostSetting', { setting: match[1] });
      break;
    }
  }
  return translateMessage(finding.message);
}

/** Closing the dialog retains the reviewed file and exact uncertain submission. */
export function RisuPresetImport({
  showTrigger = true,
  reload,
  onImported,
}: {
  showTrigger?: boolean;
  reload: () => Promise<void>;
  onImported: (preset: PromptPreset) => void;
}) {
  useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const [source, setSource] = useState<RisuImportSource | null>(null);
  const [preview, setPreview] = useState<RisuPresetImportPreview | null>(null);
  const [allowPartial, setAllowPartial] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [result, setResult] = useState<RisuPresetImportResult | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const submission = useRef<RisuPresetImportApply | null>(null);
  const requestKey = useRef<string | null>(null);
  const unsupported = preview?.findings.some((finding) => finding.level === 'unsupported');
  const ready = !!source && !!preview && (uncertain || !unsupported || allowPartial);

  async function prepare(file: File) {
    if (active.current || uncertain) return;
    active.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (!/\.(risup|risupreset|json|zip)$/i.test(file.name))
        throw new Error(legacyMessage('transfer.m065'));
      if (!file.size) throw new Error(legacyMessage('transfer.m008'));
      if (file.size > RISU_IMPORT_MAX_BYTES) throw new Error(legacyMessage('transfer.m066'));
      const nextSource = await readSource(file);
      const nextPreview = await api<RisuPresetImportPreview>('/risu-preset-imports/prepare', {
        source: nextSource,
      });
      setSource(nextSource);
      setPreview(nextPreview);
      setAllowPartial(false);
      setResult(null);
      submission.current = null;
      requestKey.current = null;
    } catch (cause) {
      setError(
        retainedMessage('transfer.reviewError', {
          error: messageRef((cause as Error).message),
          retained: !!preview,
        })
      );
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  async function apply() {
    if (active.current || !source || !preview || !ready || result) return;
    const payload = submission.current ?? {
      source,
      digest: preview.digest,
      allowPartial,
      idempotencyKey: (requestKey.current ??= crypto.randomUUID()),
    };
    submission.current = payload;
    active.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const imported = await api<RisuPresetImportResult>('/risu-preset-imports/apply', payload);
      setResult(imported);
      setUncertain(false);
      try {
        await reload();
      } catch {
        setNotice(retainedMessage('transfer.m067'));
      }
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

  return (
    <>
      {showTrigger && (
        <IconButton
          label={t('transfer.m068')}
          className="secondary"
          icon={UploadIcon}
          onClick={() => setOpen(true)}
        />
      )}
      <Dialog
        open={open}
        title={t('transfer.m068')}
        onClose={() => setOpen(false)}
        className="risu-import-dialog"
        wide
      >
        <section
          className={`risu-import-body${result ? ' complete' : ''}`}
          aria-label={t('transfer.m069')}
          aria-busy={busy}
        >
          {!preview && (
            <>
              <p className="muted">{t('transfer.m070')}</p>
              <p className="muted">{t('transfer.m071')}</p>
            </>
          )}
          <label className={`risu-import-file${preview ? ' risu-import-file-ready' : ''}`}>
            <span>{preview ? source?.name : t('transfer.m072')}</span>
            <input
              type="file"
              aria-label={t('transfer.m073')}
              accept=".risup,.risupreset,.json,.zip,application/json,application/zip"
              disabled={busy || uncertain}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void prepare(file);
              }}
            />
            {preview && <span className="risu-import-change">{t('transfer.m020')}</span>}
          </label>
          {preview && (
            <>
              <div className="risu-import-summary risu-import-hero">
                <h3>{preview.title}</h3>
                <small className="muted">{t('transfer.m074')}</small>
                <dl className="risu-import-counts">
                  <div>
                    <dt>{t('transfer.m075')}</dt>
                    <dd>{formatNumber(preview.summary.blocks)}</dd>
                  </div>
                  <div>
                    <dt>{t('transfer.m076')}</dt>
                    <dd>{formatNumber(preview.summary.controls)}</dd>
                  </div>
                  <div>
                    <dt>{t('transfer.m077')}</dt>
                    <dd>{formatNumber(preview.summary.regex)}</dd>
                  </div>
                </dl>
              </div>
              {preview.findings.length > 0 ? (
                <section
                  className={`risu-import-findings${unsupported ? ' warn' : ''}`}
                  aria-label={t('transfer.m078')}
                >
                  <h3>{unsupported ? t('transfer.m032') : t('transfer.m033')}</h3>
                  <ul>
                    {preview.findings.map((finding, index) => (
                      <li key={`${finding.code}:${index}`}>
                        <strong>
                          {finding.level === 'unsupported'
                            ? t('transfer.m034')
                            : t('transfer.m035')}{' '}
                          ·{' '}
                        </strong>
                        {presetFindingMessage(finding)}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : (
                <p className="muted">{t('transfer.m079')}</p>
              )}
              <details className="risu-import-processing">
                <summary>{t('transfer.m080')}</summary>
                <p className="muted">{t('transfer.m081')}</p>
              </details>
              {unsupported && (
                <label className="risu-import-choice risu-import-partial">
                  <SelectionCheckbox
                    checked={allowPartial}
                    disabled={busy || uncertain || !!result}
                    onChange={(event) => {
                      setAllowPartial(event.target.checked);
                      submission.current = null;
                      requestKey.current = null;
                      setError('');
                    }}
                  />
                  <span>{t('transfer.m043')}</span>
                </label>
              )}
              {uncertain && <NoticeBanner>{t('transfer.m082')}</NoticeBanner>}
              {result ? (
                <div className="risu-import-result">
                  <CheckIcon size={28} aria-hidden="true" />
                  <h3>{t('transfer.m083')}</h3>
                  <p className="muted">{preview.title}</p>
                  <p role="status">{t('transfer.m084')}</p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setOpen(false);
                      onImported(result.preset);
                    }}
                  >
                    {t('transfer.m085')}
                  </button>
                </div>
              ) : (
                <button type="button" disabled={busy || !ready} onClick={() => void apply()}>
                  {uncertain ? t('transfer.m058') : t('transfer.m086')}
                </button>
              )}
            </>
          )}
          {busy && <LoadingState presentation="inline" label={t('transfer.m063')} />}
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
