import { useEffect, useState } from 'react';

export function useCompactLayout() {
  const [compact, setCompact] = useState(() => matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    const media = matchMedia('(max-width: 760px)');
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return compact;
}
