# Frontend — Interface Web Administrativa Norvia

Interface web corporativa moderna desenvolvida com **vinext** (Vite + RSC, com as convenções de rota do App Router do Next.js), **React 19**, **TypeScript** e **Tailwind CSS v4**, construída para visualização de telemetria, governança multi-setor e operação de rotinas automatizadas.

---

## 🏛️ Arquitetura e Organização de Pastas

```
frontend/
├── app/
│   ├── (dashboard)/                   # Layout autenticado com sidebar responsiva e header com notificações
│   │   ├── admin/                     # Administração corporativa
│   │   │   ├── auditoria/             # Trilha de auditoria de operações sensíveis
│   │   │   ├── erros/                 # Central de incidentes e erros do sistema
│   │   │   ├── saude/                 # Painel de saúde e latência dos serviços integrados
│   │   │   ├── tokens/                # Monitoramento e renovação de tokens n8n
│   │   │   └── usuarios/              # Gestão de usuários, perfis (Admin/Gestor/User) e permissões por usuário
│   │   ├── chat/                      # Central de mensagens internas operacionais
│   │   ├── conciliacao-mercado-livre/ # Liberações Mercado Pago × vendas ML × Contas a Receber Tiny (visão consolidada de 60 dias)
│   │   ├── contas-a-pagar/            # Conciliação bancária: Extratos Inter × Contas a Pagar Tiny (pendências persistidas)
│   │   ├── contagem-estoque/          # Contagens do bot Telegram: conferência, SKU informado e exclusão no painel
│   │   ├── danfe-tiny/                # Varredura SEFAZ, upload de DANFEs, OCR e revisão humana
│   │   ├── dashboard-financeiro/      # Fluxo de caixa, DRE gerencial, inadimplência e insights
│   │   ├── financeiro/                # Visão geral da área Financeiro (cards, ROI e tendências)
│   │   ├── fretes-a-combinar/         # Gestão de fretes Mercado Envios (ME1 e ME2)
│   │   ├── logistica/                 # Visão geral da área Logística
│   │   ├── marketplace/               # Visão geral da área Marketplace
│   │   ├── padronizacao-dimensoes/    # Comparação e padronização de medidas (Tiny vs Meli)
│   │   ├── producao/                  # Visão geral da área Produção e download do instalador de etiquetas
│   │   └── page.tsx                   # Roteamento inteligente baseado nas permissões concedidas ao usuário
│   │
│   ├── components/                    # Design System: cards, tabelas, modais, gráficos e badges
│   ├── login/                         # Tela de autenticação com tratamento de credenciais
│   └── globals.css                    # Variáveis de cor, design tokens e utilitários Tailwind v4
│
├── lib/                               # Clientes HTTP, contratos tipados, adaptadores e testes
│   ├── api.ts                         # Cliente HTTP universal com suporte a demo/live
│   ├── areas.ts                       # Mapeamento de áreas ("pastas") e controle RBAC de visibilidade
│   ├── auth-context.tsx               # Provedor React Context para estado de autenticação e sessão
│   ├── contracts.ts                   # Contratos de dados compartilhados com o gateway
│   └── ...                            # Testes unitários com o executor nativo do Node.js
│
└── public/                            # Ativos estáticos e pacotes de instalação (downloads)
```

---

## 🔐 Controle de Acesso e Permissões por Usuário (RBAC)

O controle de acesso é definido **por usuário** através do painel de Gestão de Usuários (matriz de abas × ações granulares):

1. **Perfis de Usuário**:
   - **Admin**: Acesso total e irrestrito a todas as rotas e ações. Gerencia perfis e permissões de todos os usuários. O ROOT (`is_root`) é protegido contra alteração ou exclusão por terceiros.
   - **Gestor**: Papel intermediário capaz de gerenciar usuários do perfil `User` (aprovar/rejeitar, criar, editar permissões dentro de seu próprio teto, alterar setor e derrubar sessões). Não pode gerenciar outros Gestores ou Admins.
   - **User**: Operador padrão do sistema, sem privilégios de gestão.

2. **Permissões Granulares (Abas × Ações)**:
   - O acesso visual a cada aba (`<aba>:ver`) e as ações específicas dentro dela (ex: `contas_pagar:baixar`, `revisao_nfe:forcar_varredura`, `tokens_n8n:executar`) são concedidos explicitamente pelo administrador.
   - **Ações de Risco**: Operações como forçar varredura SEFAZ ou forçar sincronização do dashboard demandam confirmação explícita de risco.
   - **Rotas Livres**: Início, Chat, perfil próprio e notificações pessoais são sempre liberados para qualquer usuário autenticado.

3. **Setor**:
   - Mantido como rótulo de equipe para organização e filtros operacionais, não conferindo permissões implícitas.

4. **Transição e Novos Cadastros**:
   - Novos usuários nascem sem nenhuma permissão concedida até que o administrador aprove o cadastro e marque os acessos permitidos. Na migração de virada, não-administradores iniciam sem permissões até atribuição manual.

---

## 🌓 Modos de Operação (`Live` vs `Demo`)

O frontend suporta alternância transparente através da variável `NEXT_PUBLIC_DATA_MODE` no `.env.local`:

- **Modo Demonstrativo (`demo`)**:
  - Utiliza fixtures em memória ricas e determinísticas.
  - Permite testes de interface, validação visual e homologação sem conexão com os servidores reais ou risco a dados operacionais.
- **Modo Real (`live`)**:
  - Estabelece comunicação direta com o API Gateway (`http://localhost:3100` ou `https://servidor.norvia.example`).
  - Utiliza autenticação com credenciais de sessão e canais de streaming SSE para notificações.

---

## ⚡ Polling Inteligente e Reatividade em Tempo Real (`DataPoller` & `useDataPolling`)

O frontend conta com um motor centralizado de sincronização de dados (`lib/use-data-polling.ts`):

- **Suspensão em Abas Ocultas**: Monitora eventos de visibilidade do navegador (`document.visibilityState`). Quando a aba fica em segundo plano, os timers de polling periódico são pausados automaticamente, economizando CPU do cliente e conexões no servidor.
- **Retomada Imediata**: Ao voltar para a aba, o motor avalia se a janela de atualização já transcorreu e dispara uma requisição imediata.
- **Cancelamento com `AbortController`**: Cada requisição em voo é vinculada a um `AbortSignal`. Ao desmontar um componente ou acionar um refresh manual, a requisição pendente anterior é cancelada de imediato.
- **Invalidação Reativa via SSE (`/api/events`)**: Ao receber eventos de alteração de dados (ex: nova nota SEFAZ importada, alteração em fretes), as telas inscritas revalidam seus dados instantaneamente, sem esperar o próximo ciclo de polling.

---

## 🚀 Como Executar

### 1. Desenvolvimento
```bash
# A partir da raiz do monorepo:
npm run dev:frontend

# Ou dentro de frontend/:
npm run dev

# Modo demonstração (fixtures, sem backend) — o padrão para desenvolvimento local:
npm run dev:mock
```
Acesse em: `http://localhost:3000`

### 2. Testes Automatizados
```bash
# Testes unitários (executor nativo do Node via tsx, 142 testes), checagem de tipos e lint:
npm test
npm run typecheck
npm run lint
```

### 3. Build de Produção
```bash
npm run build
```
Valida a compilação e exportação de todas as 17 rotas estáticas e páginas do sistema. O
resultado publicado é **só** `dist/client/automacoes/` (export estático, sem source maps —
`build.sourcemap: false` em `vite.config.ts`), copiado por `rsync` para `/var/www/automacoes`
e servido pelo NGINX. `npm start` (`vinext start`) só serve o build localmente para conferência.

O `vinext` fica em `devDependencies` (desde 2026-10-08, por causa do GHSA-vfj7-8cjw-p6xm no
`braces`): é ferramenta de build e não roda em produção. Instale com `npm ci` **sem**
`--omit=dev`, senão o build quebra. Detalhes em `docs/seguranca-deploy.md` §9.

---

## 🔒 Headers de segurança (NGINX)

O frontend é um export estático: os headers HTTP vêm do NGINX, não do app. Bloco pronto para
o `location /automacoes/` que serve `/var/www/automacoes` (origens conferidas no código e no
build em 2026-10-06):

```nginx
# Atenção: add_header dentro de um location ANULA os add_header herdados do server{}.
# Repita aqui os que já existirem lá (ex.: HSTS).
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header X-Frame-Options "DENY" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;
```

Por que cada diretiva está assim:

| Diretiva | Valor | Motivo |
| --- | --- | --- |
| `script-src` | `'self' 'unsafe-inline'` | Cada página exportada tem ~20 `<script>` inline do vinext (payload RSC de hidratação) cujo conteúdo — e hash — muda a cada build e por rota (81 hashes distintos no build de 2026-10-06). Sem `'unsafe-inline'` a hidratação quebra. O script de tema (`lib/theme.ts` → `app/layout.tsx`) tem hash fixo `sha256-KqTsCsNcNh8qBmrJYgaeUdxL7wYqFY8oEtEX6h7m8zw=` (conferido por `lib/theme.test.ts`), mas listá-lo só tem efeito quando o `'unsafe-inline'` puder sair. |
| `style-src` | `'self' 'unsafe-inline'` | `<style data-vinext-fonts>` inline (fontes Inter e Geist Mono auto-hospedadas) e atributos `style=""` gerados por React/Recharts. |
| `img-src` | `'self' data: blob:` | Logos em `public/`, avatares em data URL (upload) e blobs de pré-visualização. **Foto de perfil por URL externa** (opção "URL" no perfil) deixa de carregar — intencional (evita rastreio/vazamento de IP entre usuários). Para manter o recurso, troque por `img-src 'self' data: blob: https:`. |
| `font-src` | `'self'` | Fontes servidas de `/automacoes/_next/static/_vinext_fonts/` (nada de Google Fonts em runtime). |
| `connect-src` | `'self'` | Em produção a API é a mesma origem (`https://servidor.norvia.example/automacoes/api/…`, inclusive o stream `/api/events`). Se um dia o gateway ficar em outra origem, acrescente-a aqui (ex.: `connect-src 'self' https://api.exemplo`). Acesso de LAN por porta (`http://IP:3001` → API `:3100`) não passa por este NGINX. |
| `frame-ancestors` / `X-Frame-Options` | `'none'` / `DENY` | Painel não é embutível (clickjacking). |

Links para fora (n8n, Telegram, anúncios do Mercado Livre) são só `href` e não precisam de CSP.

Para validar depois do reload do NGINX: abrir o painel com o DevTools → Console e navegar por
login, Início, Contas a Pagar, DANFE e Chat; não deve aparecer "Refused to … Content Security
Policy". Para testar sem quebrar ninguém, use primeiro `Content-Security-Policy-Report-Only`
com o mesmo valor.

> O token de sessão continua em `localStorage` (migração para cookie `HttpOnly` fica para
> depois). Mitigações já no código: o interceptor global de `fetch` (`lib/auth-context.tsx`)
> só anexa `Authorization`/`x-session-token` a requisições para a origem da API
> (`lib/session-guard.ts`), links de notificação só navegam para caminhos internos e links
> externos vindos da API só aceitam `http(s)`.
