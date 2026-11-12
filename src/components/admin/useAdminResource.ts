import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';

export function useAdminResource<T>(path: string) {
  const [state, setState] = useState<{ path: string; data: T | null; error: string; loading: boolean }>({ path, data: null, error: '', loading: true });
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    setState(previous => ({ path, data: previous.path === path ? previous.data : null, error: '', loading: true }));
    try {
      const data = await api<T>(path);
      if (request === sequence.current) setState({ path, data, error: '', loading: false });
    } catch (error) {
      if (request === sequence.current) setState(previous => ({ ...previous, path, error: (error as Error).message, loading: false }));
    }
  }, [path]);
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30000);
    window.addEventListener('focus', onFocus);
    return () => { ++sequence.current; clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [refresh]);
  return { data: state.path === path ? state.data : null, error: state.path === path ? state.error : '', loading: state.path !== path || state.loading, refresh };
}
