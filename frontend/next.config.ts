import type { NextConfig } from 'next';

// A aplicação é servida como subpath do nginx compartilhado
// (servidor.norvia.example/automacoes/), ao lado de /tms/, /pcp-extrusao/ etc.
// No GitHub Pages o subpath é o nome do repositório (BASE_PATH=/<repo>, ver deploy-pages.yml).
const BASE_PATH = process.env.BASE_PATH ?? '/automacoes';

const nextConfig: NextConfig = {
  // Export estático: o app não usa server actions, route handlers nem
  // rotas dinâmicas — todo dado vem de fetch no browser contra o Gateway.
  output: 'export',
  // Prefixa rotas e assets; sem isso o browser buscaria /_next/... na raiz
  // do domínio e cairia no location / do sistemaproducao.
  basePath: BASE_PATH,
  // Gera contas-a-pagar/index.html em vez de contas-a-pagar.html, para o
  // nginx resolver a rota como diretório sem regra extra.
  trailingSlash: true,
  // basePath não reescreve <img src> escrito à mão (só Link, next/image e
  // os assets do framework). Exposto para os componentes montarem a URL
  // de arquivos de public/ a partir de uma fonte única da verdade.
  env: { NEXT_PUBLIC_BASE_PATH: BASE_PATH },
};

export default nextConfig;
