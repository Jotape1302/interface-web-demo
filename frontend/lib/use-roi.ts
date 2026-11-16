'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './auth-context';
import type { RoiPeriodo } from './roi-period';
import type { RoiResponse } from './roi-contracts';
import { createRoiService } from './roi-service';

const SEM_PERIODO: RoiPeriodo = { de: null, ate: null };

// Carrega GET /api/roi (ou a fixture em demo) para a aba "ROI das automações".
export function useRoi(enabled: boolean, periodo: RoiPeriodo = SEM_PERIODO) {
  const { token, apiBaseUrl } = useAuth();
  const isDemo = token === 'mock-demo-token' || process.env.NEXT_PUBLIC_DATA_MODE === 'demo';
  const service = useMemo(
    () => createRoiService({ mode: isDemo ? 'demo' : 'live', apiBaseUrl }),
    [isDemo, apiBaseUrl],
  );
  const [data, setData] = useState<RoiResponse | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  const { de, ate } = periodo;
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const result = await service.getRoi(controller.signal, { de: de ?? undefined, ate: ate ?? undefined });
      if (!controller.signal.aborted) setData(result);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'Não foi possível consultar o ROI das automações.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [service, de, ate]);

  useEffect(() => {
    if (!enabled || (!isDemo && !token)) return;
    // oxlint-disable-next-line react/react-compiler -- setState síncrono no efeito é intencional (reset/sincronização ao mudar a entrada); refatorar exigiria reestruturar o componente
    void refresh();
    return () => request.current?.abort();
  }, [enabled, isDemo, token, refresh]);

  return { data, loading, error, refresh };
}
