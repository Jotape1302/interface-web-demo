/**
 * Fachada da autenticação (GW-07): reexporta a API pública, que agora mora em
 *  - auth-types.ts        tipos, contrato `AuthService` e interface do store
 *  - auth-validators.ts   senhas (scrypt), tokens de sessão e validação de entrada
 *  - auth-store-memory.ts store em memória (demo/testes)
 *  - auth-store-sql.ts    store MariaDB (live)
 *  - auth-service.ts      serviço (login, sessões, RBAC, cadastro), perfis demo e cache
 * Os imports externos continuam apontando para "./auth.js".
 */
export {
  ROLES,
  InvalidCredentialsError,
  type Role,
  type UserStatus,
  type User,
  type AdminUserView,
  type PermissionState,
  type ReplacePermissionsResult,
  type UpdateRoleResult,
  type ChangeRequest,
  type ActiveSession,
  type SessionInfo,
  type AuthService,
} from "./auth-types.js";
export {
  MIN_PASSWORD_LENGTH,
  SCRYPT_PARAMS,
  hashPassword,
  verifyPassword,
  hashSessionToken,
  type ScryptParams,
} from "./auth-validators.js";
export {
  DEMO_PROFILES,
  PERMISSIONS_CACHE_MS,
  TOUCH_SESSION_MIN_MS,
  createAuthService,
  createAuthStore,
  seedDemoProfiles,
  type AuthStore,
} from "./auth-service.js";
