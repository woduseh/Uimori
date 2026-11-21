import { useEffect, useState } from 'react';

const COMPACT_LAYOUT_MEDIA = '(max-width: 760px)';

export function useCompactLayout() {
  const [compact, setCompact] = useState(() => matchMedia(COMPACT_LAYOUT_MEDIA).matches);
  useEffect(() => {
    const media = matchMedia(COMPACT_LAYOUT_MEDIA);
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return compact;
}
