// Contrato de GET /api/roi — espelho de RoiAutomacao/RoiResponse em backend/gateway/src/contracts.ts.
import type { RoiAutomacao, RoiResponse as GatewayRoiResponse } from '../../backend/gateway/src/contracts';

export type { RoiAutomacao };
/** Período aplicado pelo gateway (null = sem limite). */
export interface RoiPeriodoAplicado {
  de: string | null;
  ate: string | null;
}
export type RoiResponse = GatewayRoiResponse & { periodo: RoiPeriodoAplicado };

export interface RoiService {
  getRoi(signal?: AbortSignal, periodo?: Partial<RoiPeriodoAplicado>): Promise<RoiResponse>;
}
