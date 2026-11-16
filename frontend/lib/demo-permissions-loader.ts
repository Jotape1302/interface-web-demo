// Ponte leve para o modo demo: o código das fixtures e do store em memória
// (lib/demo-permissions.ts) só é baixado (import() dinâmico, chunk separado) quando alguém
// de fato usa o demo. Este arquivo é o único que o bundle principal importa estaticamente.

/** Usuário do perfil demo padrão (Admin ROOT). Definido aqui para o bundle principal não puxar as fixtures. */
export const DEMO_ROOT_USERNAME = 'admin_jp';

type DemoPermissionsModule = typeof import('./demo-permissions');

let cache: Promise<DemoPermissionsModule> | null = null;

export function loadDemoPermissions(): Promise<DemoPermissionsModule> {
  cache ??= import('./demo-permissions');
  return cache;
}
