import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Dialog } from './Dialog.js';
import { formatNumber, t, useI18n } from './i18n.js';
import { useCompactLayout } from './useCompactLayout.js';
import { readPresentationChoice, writePresentationSetting } from './presentation-settings.js';
import { storageKeys } from './storage-keys.js';
import {
  ProseHunk,
  TextDiffDocument,
  TextDiffStats,
  textDiffOmission,
  type TextDiffLayout,
} from './TextDiffView.js';
import { reviewTotals, type ReviewCard, type ReviewSection } from './change-review.js';
import { DropdownIcon, ForwardIcon, UndoIcon } from './ui-icons.js';
import './change-review.css';

const LAYOUTS = ['split', 'unified'] as const;
const WIDE_MEDIA = '(min-width: 960px)';
const LAZY_MARGIN = '800px 0px';
const LINE_HEIGHT = 20;
const CURRENT_OFFSET = 24;

function useWideLayout() {
  const [wide, setWide] = useState(() => matchMedia(WIDE_MEDIA).matches);
  useEffect(() => {
    const media = matchMedia(WIDE_MEDIA);
    const update = () => setWide(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return wide;
}

const cardDomId = (prefix: string, card: ReviewCard<string>) =>
  `${prefix}-${encodeURIComponent(card.id).replaceAll('%', '_')}`;

function shownValue(value: unknown) {
  if (value === undefined || value === null || value === '') return t('shared.valueEmpty');
  if (typeof value === 'boolean') return t(value ? 'shared.valueOn' : 'shared.valueOff');
  return String(value);
}

function estimatedHeight(card: ReviewCard<string>) {
  const { view } = card;
  if (view.type !== 'text' || 'omitted' in view.diff) return 40;
  let lines = 0;
  for (const hunk of view.diff.hunks)
    for (const segment of hunk.segments) {
      const breaks = segment.text.split('\n').length;
      lines +=
        view.diff.mode === 'code' ? breaks : Math.ceil(segment.text.length / 70) + breaks - 1;
    }
  return Math.min(4000, 24 + lines * LINE_HEIGHT);
}

function CardBody({ card, layout }: { card: ReviewCard<string>; layout: TextDiffLayout }) {
  const { view, change } = card;
  if (view.type === 'text') {
    if ('omitted' in view.diff)
      return <p className="muted change-review-note">{textDiffOmission(view.diff)}</p>;
    if (!view.diff.hunks.length) return null;
    return (
      <div
        className="text-diff-box change-review-diff"
        role="region"
        aria-label={t('helperChanges.diffRegion', { title: card.name })}
        data-mode={view.diff.mode}
      >
        <TextDiffDocument
          diff={view.diff}
          before={view.before}
          after={view.after}
          layout={layout}
        />
      </div>
    );
  }
  if (view.type === 'value')
    return (
      <div
        className="text-diff-box change-review-diff"
        role="region"
        aria-label={t('helperChanges.diffRegion', { title: card.name })}
      >
        <ProseHunk
          hunk={{
            beforeOffset: 0,
            afterOffset: 0,
            segments: [
              ...(change.kind !== 'added'
                ? [{ op: 'delete' as const, text: shownValue(view.before) }]
                : []),
              ...(change.kind === 'changed' ? [{ op: 'equal' as const, text: ' → ' }] : []),
              ...(change.kind !== 'removed'
                ? [{ op: 'insert' as const, text: shownValue(view.after) }]
                : []),
            ],
          }}
        />
      </div>
    );
  if (view.type === 'summary')
    return (
      <p className="muted change-review-note">
        {view.before !== null && view.after !== null
          ? t('shared.changeItemCount', { before: view.before, after: view.after })
          : t('shared.changeNotCompared')}
      </p>
    );
  return null;
}

function CardStats({ card }: { card: ReviewCard<string> }) {
  const { view } = card;
  return (
    <>
      {view.type === 'text' && !('omitted' in view.diff) && <TextDiffStats diff={view.diff} />}
      {card.badge && <span className="change-review-badge">{t(card.badge)}</span>}
    </>
  );
}

function ReviewCardView({
  card,
  domId,
  layout,
  root,
  onJump,
  onRevert,
}: {
  card: ReviewCard<string>;
  domId: string;
  layout: TextDiffLayout;
  root: HTMLElement | null;
  onJump?: () => void;
  onRevert?: () => void;
}) {
  const element = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const node = element.current;
    if (shown || !node || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setShown(true);
      },
      { root, rootMargin: LAZY_MARGIN }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown, root]);
  return (
    <article
      ref={element}
      id={domId}
      className="change-review-card"
      data-kind={card.change.kind}
      tabIndex={-1}
      aria-labelledby={`${domId}-title`}
    >
      <header className="change-review-card-head">
        <h4 id={`${domId}-title`} className="change-review-card-title">
          {card.label.map((part, index) => (
            <Fragment key={index}>
              {index > 0 && <span className="change-review-card-separator"> / </span>}
              {part.identifier ? <code>{part.text}</code> : <span>{part.text}</span>}
            </Fragment>
          ))}
        </h4>
        <span className="change-review-card-meta">
          <CardStats card={card} />
        </span>
        {(onRevert || onJump) && (
          <span className="change-review-card-actions">
            {onRevert && (
              <button
                type="button"
                className="ghost"
                aria-label={t('shared.revertChangeNamed', { title: card.name })}
                onClick={onRevert}
              >
                <UndoIcon size={16} aria-hidden="true" />
                {t('shared.revertChange')}
              </button>
            )}
            {onJump && (
              <button
                type="button"
                className="ghost"
                aria-label={t('shared.goToChange', { title: card.name })}
                onClick={onJump}
              >
                <ForwardIcon size={16} aria-hidden="true" />
                {t('shared.goToChangeShort')}
              </button>
            )}
          </span>
        )}
      </header>
      {shown ? (
        <CardBody card={card} layout={layout} />
      ) : (
        <div
          className="change-review-placeholder"
          style={{ height: estimatedHeight(card) }}
          aria-hidden="true"
        />
      )}
    </article>
  );
}

function RailStats({ card }: { card: ReviewCard<string> }) {
  return (
    <span className="change-review-rail-meta" aria-hidden="true">
      {card.badge ? (
        <span className="change-review-badge">{t(card.badge)}</span>
      ) : (
        <>
          {card.added > 0 && (
            <span className="helper-change-added">+{formatNumber(card.added)}</span>
          )}
          {card.removed > 0 && (
            <span className="helper-change-removed">−{formatNumber(card.removed)}</span>
          )}
        </>
      )}
    </span>
  );
}

function ChangeRail({
  sections,
  current,
  prefix,
  onPick,
}: {
  sections: readonly ReviewSection<string>[];
  current: string | null;
  prefix: string;
  onPick: (target: string) => void;
}) {
  const [roving, setRoving] = useState<string | null>(null);
  const first = sections[0]?.id ?? null;
  const active = roving ?? current ?? (first ? `section:${first}` : null);
  const move = (event: KeyboardEvent<HTMLElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (!buttons.length) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    buttons[next]?.focus();
  };
  const rovingProps = (key: string) => ({
    tabIndex: active === key ? 0 : -1,
    onFocus: () => setRoving(key),
  });
  return (
    <nav className="change-review-rail" aria-label={t('shared.changeList')} onKeyDown={move}>
      <ul>
        {sections.map((section) => (
          <li key={section.id}>
            <button
              type="button"
              className="change-review-rail-section"
              {...rovingProps(`section:${section.id}`)}
              onClick={() => onPick(`section:${section.id}`)}
            >
              <span className="change-review-rail-label">{section.title}</span>
              {section.pending && (
                <span className="change-review-badge">{t('shared.pendingInput')}</span>
              )}
            </button>
            {section.cards.length > 0 && (
              <ul>
                {section.cards.map((card) => (
                  <li key={card.id}>
                    <button
                      type="button"
                      className="change-review-rail-item"
                      data-card={cardDomId(prefix, card)}
                      aria-current={current === card.id ? 'true' : undefined}
                      {...rovingProps(card.id)}
                      onClick={() => onPick(card.id)}
                    >
                      <span className="change-review-rail-label">{card.name}</span>
                      <RailStats card={card} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function ChangeReview<K extends string>({
  open,
  onClose,
  onAfterClose,
  title = t('shared.reviewChanges'),
  subject,
  sections,
  status,
  help,
  notice,
  actions,
  error,
  onJump,
  onRevert,
  revertable,
}: {
  open: boolean;
  onClose: () => void;
  onAfterClose?: () => void;
  title?: string;
  subject: string;
  sections: readonly ReviewSection<K>[];
  status?: ReactNode;
  help?: string;
  notice?: ReactNode;
  actions: ReactNode;
  error?: ReactNode;
  onJump?: (card: ReviewCard<K>) => void;
  onRevert?: (card: ReviewCard<K>) => void;
  revertable?: (card: ReviewCard<K>, section: ReviewSection<K>) => boolean;
}) {
  useI18n();
  const prefix = useId().replaceAll(':', '');
  const compact = useCompactLayout();
  const wide = useWideLayout();
  const [preferred, setPreferred] = useState<TextDiffLayout>(() =>
    readPresentationChoice(storageKeys.changeReviewLayout, LAYOUTS, 'split')
  );
  const layout: TextDiffLayout = wide ? preferred : 'unified';
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const picker = useRef<HTMLDetailsElement>(null);
  const cards = sections.flatMap((section) => section.cards);
  const cardIds = useRef<string[]>([]);
  cardIds.current = cards.map((card) => card.id);
  const choose = (next: TextDiffLayout) => {
    setPreferred(next);
    writePresentationSetting(storageKeys.changeReviewLayout, next);
  };
  const pinned = useRef<{ id: string; top: number } | null>(null);
  const track = useCallback(() => {
    if (!canvas) return;
    const hold = pinned.current;
    if (hold && Math.abs(canvas.scrollTop - hold.top) < 2) {
      setCurrent(hold.id);
      return;
    }
    pinned.current = null;
    const nodes = [...canvas.querySelectorAll<HTMLElement>('.change-review-card')];
    const top = canvas.scrollTop + CURRENT_OFFSET;
    let low = 0;
    let high = nodes.length - 1;
    let found = nodes.length ? 0 : -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const node = nodes[middle]!;
      if (node.offsetTop + node.offsetHeight <= top) low = middle + 1;
      else {
        found = middle;
        high = middle - 1;
      }
    }
    setCurrent(found >= 0 ? (cardIds.current[found] ?? null) : null);
  }, [canvas]);
  useEffect(() => {
    if (!canvas) return;
    let frame = 0;
    const scheduled = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(track);
    };
    canvas.addEventListener('scroll', scheduled, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener('scroll', scheduled);
    };
  }, [canvas, track]);
  useEffect(() => {
    track();
  });
  useLayoutEffect(() => {
    if (!current || !canvas) return;
    const rail = canvas.parentElement?.querySelector<HTMLElement>('.change-review-rail');
    const item = rail?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!rail || !item) return;
    const top = item.offsetTop;
    if (top < rail.scrollTop) rail.scrollTop = top - 8;
    else if (top + item.offsetHeight > rail.scrollTop + rail.clientHeight)
      rail.scrollTop = top + item.offsetHeight - rail.clientHeight + 8;
  }, [current, canvas]);
  const pick = (target: string) => {
    if (!canvas) return;
    const section = target.startsWith('section:') ? target.slice(8) : null;
    const card = section
      ? sections.find((item) => item.id === section)?.cards[0]
      : cards.find((item) => item.id === target);
    const node = section
      ? canvas.querySelector<HTMLElement>(`[data-review-section="${CSS.escape(section)}"]`)
      : card && document.getElementById(cardDomId(prefix, card));
    if (!node) return;
    canvas.scrollTo({ top: node.offsetTop - CURRENT_OFFSET + 8, behavior: 'instant' });
    node.focus({ preventScroll: true });
    if (picker.current) picker.current.open = false;
    pinned.current = card ? { id: card.id, top: canvas.scrollTop } : null;
    track();
  };
  const totals = reviewTotals(sections);
  const empty = !status && !sections.length;
  const body = status ? (
    <div className="change-review-status">{status}</div>
  ) : empty ? (
    <div className="change-review-status">
      <p>{t('shared.noUnsavedChanges')}</p>
    </div>
  ) : (
    <div className="change-review-main">
      {compact ? (
        <details ref={picker} className="change-review-picker">
          <summary>
            <span>{t('shared.changeListCount', { count: totals.items })}</span>
            <DropdownIcon size={18} aria-hidden="true" />
          </summary>
          <ChangeRail sections={sections} current={current} prefix={prefix} onPick={pick} />
        </details>
      ) : (
        <ChangeRail sections={sections} current={current} prefix={prefix} onPick={pick} />
      )}
      <div ref={setCanvas} className="change-review-canvas">
        {help && <p className="muted change-review-help">{help}</p>}
        {sections.map((section) => (
          <section
            key={section.id}
            className="change-review-section"
            data-review-section={section.id}
            tabIndex={-1}
            aria-labelledby={`${prefix}-${section.id}-heading`}
          >
            <h3 id={`${prefix}-${section.id}-heading`} className="change-review-section-title">
              {section.title}
              {section.pending && (
                <span className="change-review-badge">{t('shared.pendingInput')}</span>
              )}
            </h3>
            {section.pending && (
              <p className="muted change-review-note">{t('shared.pendingInputHelp')}</p>
            )}
            {!section.cards.length && !section.pending && (
              <p className="muted change-review-note">{t('shared.noFieldChanges')}</p>
            )}
            {section.cards.map((card) => (
              <ReviewCardView
                key={card.id}
                card={card}
                domId={cardDomId(prefix, card)}
                layout={layout}
                root={canvas}
                onJump={onJump && (() => onJump(card))}
                onRevert={
                  onRevert && (revertable?.(card, section) ?? true)
                    ? () => onRevert(card)
                    : undefined
                }
              />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
  return (
    <Dialog
      open={open}
      title={title}
      className="change-review-dialog"
      onClose={onClose}
      onAfterClose={onAfterClose}
      headerActions={
        <>
          <span className="change-review-subject">{subject}</span>
          {wide && !status && !empty && (
            <div
              className="segmented compact change-review-layout"
              role="group"
              aria-label={t('shared.diffLayout')}
            >
              <button
                type="button"
                aria-pressed={layout === 'split'}
                onClick={() => choose('split')}
              >
                {t('shared.diffSplit')}
              </button>
              <button
                type="button"
                aria-pressed={layout === 'unified'}
                onClick={() => choose('unified')}
              >
                {t('shared.diffUnified')}
              </button>
            </div>
          )}
        </>
      }
    >
      {body}
      <footer className="change-review-footer">
        {notice}
        {error}
        <div className="change-review-footer-row">
          {!status && !empty && (
            <p className="change-review-totals ui-meta-row">
              <span>{t('shared.reviewSectionCount', { count: totals.sections })}</span>
              <span>{t('shared.reviewItemCount', { count: totals.items })}</span>
              {(totals.added > 0 || totals.removed > 0) && (
                <span>
                  <span aria-hidden="true">
                    {totals.added > 0 && (
                      <span className="helper-change-added">+{formatNumber(totals.added)}</span>
                    )}
                    {totals.removed > 0 && (
                      <span className="helper-change-removed">−{formatNumber(totals.removed)}</span>
                    )}
                  </span>
                  <span className="sr-only">
                    {t('shared.reviewTotals', { added: totals.added, removed: totals.removed })}
                  </span>
                </span>
              )}
            </p>
          )}
          <div className="change-review-actions">{actions}</div>
        </div>
      </footer>
    </Dialog>
  );
}
