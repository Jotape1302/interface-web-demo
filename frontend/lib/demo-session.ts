// Sessão de demonstração: variável de build (NEXT_PUBLIC_DATA_MODE=demo) ou login pelo botão
// "Modo Demonstração" (token 'mock-demo-token'). Os serviços trocam a API por dados fictícios.
export function isDemoSession(): boolean {
  if (process.env.NEXT_PUBLIC_DATA_MODE === 'demo') return true;
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem('norvia_session_token') === 'mock-demo-token';
  } catch {
    return false;
  }
}

/** Resposta fictícia com um atraso curto, para os estados de carregamento aparecerem como na API real. */
export function demoDelay<T>(valor: T, ms = 350): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(structuredClone(valor)), ms));
}
