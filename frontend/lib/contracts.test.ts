import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveApiBaseUrl } from './contracts';

test('resolveApiBaseUrl em ambiente Node/SSR usa fallback ou valor configurado', () => {
  const originalEnv = process.env.NEXT_PUBLIC_API_BASE_URL;
  delete process.env.NEXT_PUBLIC_API_BASE_URL;

  try {
    assert.equal(resolveApiBaseUrl(), 'http://localhost:3100');
    assert.equal(resolveApiBaseUrl('https://api.empresa.com'), 'https://api.empresa.com');
  } finally {
    if (originalEnv !== undefined) {
      process.env.NEXT_PUBLIC_API_BASE_URL = originalEnv;
    }
  }
});

test('resolveApiBaseUrl no navegador sob HTTPS e subpath /automacoes utiliza a origin com /automacoes', () => {
  const originalWindow = (globalThis as any).window;

  try {
    (globalThis as any).window = {
      location: {
        protocol: 'https:',
        hostname: 'servidor.norvia.example',
        port: '',
        pathname: '/automacoes/login',
        origin: 'https://servidor.norvia.example',
      },
    };

    // Sob HTTPS na VPS com Nginx servindo em /automacoes, a base deve ser https://servidor.norvia.example/automacoes
    assert.equal(resolveApiBaseUrl(), 'https://servidor.norvia.example/automacoes');
  } finally {
    (globalThis as any).window = originalWindow;
  }
});

test('resolveApiBaseUrl no navegador sob porta padrao HTTP (80) utiliza a origin do proxy', () => {
  const originalWindow = (globalThis as any).window;

  try {
    (globalThis as any).window = {
      location: {
        protocol: 'http:',
        hostname: 'servidor.norvia.example',
        port: '80',
        pathname: '/automacoes',
        origin: 'http://servidor.norvia.example',
      },
    };

    assert.equal(resolveApiBaseUrl(), 'http://servidor.norvia.example/automacoes');
  } finally {
    (globalThis as any).window = originalWindow;
  }
});

test('resolveApiBaseUrl no navegador via IP de rede local e porta customizada direciona para :3100', () => {
  const originalWindow = (globalThis as any).window;

  try {
    (globalThis as any).window = {
      location: {
        protocol: 'http:',
        hostname: '192.168.50.20',
        port: '3001',
        origin: 'http://192.168.50.20:3001',
      },
    };

    assert.equal(resolveApiBaseUrl(), 'http://192.168.50.20:3100');
  } finally {
    (globalThis as any).window = originalWindow;
  }
});

test('resolveApiBaseUrl no navegador via localhost direciona para http://localhost:3100', () => {
  const originalWindow = (globalThis as any).window;

  try {
    (globalThis as any).window = {
      location: {
        protocol: 'http:',
        hostname: 'localhost',
        port: '3000',
        origin: 'http://localhost:3000',
      },
    };

    assert.equal(resolveApiBaseUrl(), 'http://localhost:3100');
  } finally {
    (globalThis as any).window = originalWindow;
  }
});

test('resolveApiBaseUrl respeita URL remota customizada explicita', () => {
  const originalWindow = (globalThis as any).window;

  try {
    (globalThis as any).window = {
      location: {
        protocol: 'https:',
        hostname: 'servidor.norvia.example',
        port: '',
        origin: 'https://servidor.norvia.example',
      },
    };

    assert.equal(resolveApiBaseUrl('https://custom-gateway.empresa.com'), 'https://custom-gateway.empresa.com');
  } finally {
    (globalThis as any).window = originalWindow;
  }
});
