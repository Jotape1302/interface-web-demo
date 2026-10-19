/**
 * Circuit Breaker para resiliência e fail-fast de serviços upstream do Gateway
 * (SEFAZ DFe, Tiny ERP v3, Banco Inter e Microsserviços Python).
 *
 * Estados:
 * - CLOSED: Operação normal. Todas as requisições passam. Falhas consecutivas são contabilizadas.
 * - OPEN: Upstream instável/indisponível. Falha imediatamente (fail-fast, 0ms de espera),
 *   evitando prender conexões do Gateway e sobrecarregar o serviço degradado.
 * - HALF_OPEN: Após `resetTimeoutMs`, permite requisições de teste (probes). Se tiverem sucesso,
 *   o circuito fecha novamente; se falharem, volta a abrir.
 */

export type CircuitBreakerState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  name: string;
  /** Quantidade de falhas consecutivas antes de abrir o circuito. Padrão: 5. */
  failureThreshold?: number;
  /** Tempo em milissegundos que o circuito permanece aberto antes do modo de teste. Padrão: 30s. */
  resetTimeoutMs?: number;
  /** Quantidade de sucessos consecutivos em half_open para fechar o circuito. Padrão: 2. */
  successThreshold?: number;
  /** Timeout padrão para chamadas gerenciadas pelo breaker. Padrão: 10s. */
  timeoutMs?: number;
  /** Função para determinar se um erro é falha de upstream (5xx/rede/timeout) ou erro de cliente (4xx). */
  isFailure?: (error: unknown) => boolean;
}

export class CircuitBreakerOpenError extends Error {
  public readonly breakerName: string;
  public readonly resetTimeoutMs: number;
  public readonly resetAt: Date;

  constructor(name: string, resetTimeoutMs: number, resetAt: Date) {
    super(
      `Circuito '${name}' está temporariamente ABERTO devido a falhas consecutivas no serviço upstream. Próxima tentativa em ${Math.max(
        0,
        Math.round((resetAt.getTime() - Date.now()) / 1000),
      )}s.`,
    );
    this.name = "CircuitBreakerOpenError";
    this.breakerName = name;
    this.resetTimeoutMs = resetTimeoutMs;
    this.resetAt = resetAt;
  }
}

function defaultIsFailure(err: unknown): boolean {
  if (err instanceof CircuitBreakerOpenError) return false;

  // Erros HTTP com status 4xx são erros do cliente/negócio (ex: 404, 422, 401), não colapso de infraestrutura
  if (typeof err === "object" && err !== null) {
    const status = (err as { status?: number }).status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return false;
    }
  }

  // Abort direto sem timeout (ex: cliente desconectou) não deve derrubar o circuito
  if (err instanceof DOMException && err.name === "AbortError") {
    return false;
  }

  return true;
}

export class CircuitBreaker {
  public readonly name: string;
  private state: CircuitBreakerState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private nextAttemptAt = 0;
  private lastError: unknown = null;
  private lastStateChange = new Date();

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly successThreshold: number;
  private readonly defaultTimeoutMs: number;
  private readonly isFailure: (error: unknown) => boolean;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.successThreshold = options.successThreshold ?? 2;
    this.defaultTimeoutMs = options.timeoutMs ?? 10_000;
    this.isFailure = options.isFailure ?? defaultIsFailure;
  }

  public getState(): CircuitBreakerState {
    if (this.state === "open" && Date.now() >= this.nextAttemptAt) {
      this.transitionTo("half_open");
    }
    return this.state;
  }

  public getStats() {
    return {
      name: this.name,
      state: this.getState(),
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastError:
        this.lastError instanceof Error
          ? this.lastError.message
          : this.lastError
            ? String(this.lastError)
            : null,
      lastStateChange: this.lastStateChange.toISOString(),
      nextAttemptAt: this.state === "open" ? new Date(this.nextAttemptAt).toISOString() : null,
    };
  }

  /**
   * Executa uma função assíncrona protegida pelo Circuit Breaker,
   * unificando o sinal do cliente e o timeout de upstream.
   */
  public async execute<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    options?: { clientSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    const currentState = this.getState();
    if (currentState === "open") {
      throw new CircuitBreakerOpenError(this.name, this.resetTimeoutMs, new Date(this.nextAttemptAt));
    }

    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = options?.clientSignal
      ? AbortSignal.any([options.clientSignal, timeoutSignal])
      : timeoutSignal;

    try {
      const result = await fn(combinedSignal);
      this.onSuccess();
      return result;
    } catch (err) {
      // Se a requisição foi abortada pelo cliente antes do timeout, repassa sem penalizar o circuito
      if (options?.clientSignal?.aborted && !timeoutSignal.aborted) {
        throw err;
      }

      if (this.isFailure(err)) {
        this.onFailure(err);
      }
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === "half_open") {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.transitionTo("closed");
      }
    } else if (this.state === "closed") {
      this.failureCount = 0;
      this.lastError = null;
    }
  }

  private onFailure(err: unknown): void {
    this.lastError = err;
    if (this.state === "half_open") {
      this.transitionTo("open");
    } else if (this.state === "closed") {
      this.failureCount++;
      if (this.failureCount >= this.failureThreshold) {
        this.transitionTo("open");
      }
    }
  }

  private transitionTo(newState: CircuitBreakerState): void {
    this.state = newState;
    this.lastStateChange = new Date();
    if (newState === "open") {
      this.nextAttemptAt = Date.now() + this.resetTimeoutMs;
      this.successCount = 0;
    } else if (newState === "closed") {
      this.failureCount = 0;
      this.successCount = 0;
      this.lastError = null;
    } else if (newState === "half_open") {
      this.successCount = 0;
    }
  }

  public reset(): void {
    this.transitionTo("closed");
  }
}

// Catálogo singleton de Circuit Breakers por serviço upstream
const registry = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(name: string, options?: Partial<CircuitBreakerOptions>): CircuitBreaker {
  let breaker = registry.get(name);
  if (!breaker) {
    breaker = new CircuitBreaker({ name, ...options });
    registry.set(name, breaker);
  }
  return breaker;
}

export function getAllCircuitBreakers(): Record<string, ReturnType<CircuitBreaker["getStats"]>> {
  const result: Record<string, ReturnType<CircuitBreaker["getStats"]>> = {};
  for (const [name, breaker] of registry) {
    result[name] = breaker.getStats();
  }
  return result;
}

export function resetAllCircuitBreakers(): void {
  for (const breaker of registry.values()) {
    breaker.reset();
  }
}
