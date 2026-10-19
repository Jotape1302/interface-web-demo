import type { DashboardResponse, Execution } from './contracts';
export interface OverviewAutomation { id: string; title: string; href: string; dashboard: DashboardResponse }
export interface OverviewExecution extends Execution { automationId: string }
export interface OverviewHistory { days: 14; from: string; to: string; complete: boolean; executions: OverviewExecution[]; error: string | null }
export interface OverviewServiceStatus { id: 'mariadb' | 'n8n' | 'tiny' | 'inter'; name: string; status: 'connected' | 'error' | 'unverified' | 'demo'; message: string }
export interface OverviewResponse { mode: 'demo' | 'live'; generatedAt: string; automations: OverviewAutomation[]; history: OverviewHistory; services: OverviewServiceStatus[] }
export interface OverviewService { getOverview(signal?: AbortSignal): Promise<OverviewResponse> }
