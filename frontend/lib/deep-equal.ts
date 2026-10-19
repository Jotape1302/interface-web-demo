/** Comparação estrutural simples para payloads JSON (respostas de fetch/poll).
 * Evita re-render/recalculo desnecessário quando um poll traz dado idêntico ao já
 * exibido — não é uma implementação de deep-equal genérica (não trata Date, Map,
 * Set, referências circulares), só o suficiente para os objetos planos vindos de API. */
export function jsonEqual<T>(a: T, b: T): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Atualiza o estado só se o novo valor for estruturalmente diferente do atual,
 * evitando re-render em pollings que trazem o mesmo conteúdo com nova referência. */
export function setIfChanged<T>(setter: (updater: (prev: T) => T) => void, next: T): void {
  setter((prev) => (jsonEqual(prev, next) ? prev : next));
}
