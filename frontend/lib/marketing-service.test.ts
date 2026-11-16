import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extrairIdsAmbienteDaPrevia,
  prefixarImagensDaPrevia,
  substituirAmbientesPorDataUrls,
} from './marketing-service';

void test('prévia do e-mail: imagens de public/ ganham o basePath do painel; CDN e links ficam', () => {
  const html =
    '<img src="/marketing/produto-perfil-t.jpg" /><img src="https://cdn.vnda.com.br/x.png" /><a href="/marketing/x">l</a>';
  assert.equal(
    prefixarImagensDaPrevia(html, '/automacoes'),
    '<img src="/automacoes/marketing/produto-perfil-t.jpg" /><img src="https://cdn.vnda.com.br/x.png" /><a href="/marketing/x">l</a>',
  );
  assert.equal(prefixarImagensDaPrevia(html, ''), html);
});

void test('prévia do e-mail: extrai IDs de ambiente e substitui apenas /api/marketing/ambientes/<id>.jpg por blob:', () => {
  const html =
    '<img src="/api/marketing/ambientes/amb-123.jpg" />' +
    '<img src="/api/marketing/ambientes/amb-123.jpg" />' +
    '<img src="/api/marketing/ambientes/amb-456.jpg" />' +
    '<img src="/marketing/logo-norvia.png" />' +
    '<a href="/api/marketing/ambientes/amb-123.jpg">link</a>';

  assert.deepEqual(extrairIdsAmbienteDaPrevia(html), ['amb-123', 'amb-456']);

  const resultado = substituirAmbientesPorDataUrls(html, {
    'amb-123': 'data:image/jpeg;base64,/9j/4AAQ',
  });
  assert.equal(
    resultado,
    '<img src="data:image/jpeg;base64,/9j/4AAQ" />' +
      '<img src="data:image/jpeg;base64,/9j/4AAQ" />' +
      '<img src="/api/marketing/ambientes/amb-456.jpg" />' +
      '<img src="/marketing/logo-norvia.png" />' +
      '<a href="/api/marketing/ambientes/amb-123.jpg">link</a>',
  );
});
