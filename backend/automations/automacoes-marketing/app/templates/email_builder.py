"""
Construtor de E-mail Marketing Norvia — Padrão "Arch Journal".

Gera o código HTML completo e responsivo (600px, tabelas + CSS inline)
fiel ao modelo aprovado em email_marketing_norvia.html.

Regras e Diretrizes (Seções B1, B2, B4 de email-marketing-padrao-arch-journal.md):
1. Cabeçalho com logo e selo ARCH JOURNAL // ED. #NN.
2. Hero com foto de ambiente aprovada (B3), headline, copy com destaque <strong> e crédito da matéria.
3. Caderno de especificação com 3 cards técnicos (cards 01, 02 e 03 com foto de ambiente, pasta, frase e etiqueta).
4. Bloco B2B (#091322) com texto institucional fixo e link direto para o Canva.
5. Rodapé com links oficiais (WhatsApp, Instagram, Site com UTM) e macro {{unsubscribe_url}}.
6. Zero href="#", zero links vazios, zero data: base64, tamanho final < 100 KB.
7. Dois modos:
   - usar_cdn_externa=True: código pronto para o RD Station com URLs absolutas.
   - usar_cdn_externa=False: prévia segura no iframe do painel com caminhos autenticados /api/marketing/*.
"""
from __future__ import annotations

import html
from typing import Any, Dict, List
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from app.config import PRODUTOS_NORVIA, settings


def _e(valor: Any) -> str:
    """Escapa texto para inserção segura no HTML."""
    return html.escape("" if valor is None else str(valor), quote=True)


def _adicionar_utm(url: str, numero_edicao: int, bloco: str) -> str:
    """Adiciona parâmetros UTM caso a URL aponte para norvia.example."""
    if not url:
        return "https://www.norvia.example"
    if "norvia.example" not in url.lower():
        return url

    parsed = urlparse(url)
    params = dict(parse_qsl(parsed.query))
    params["utm_source"] = "rdstation"
    params["utm_medium"] = "email"
    params["utm_campaign"] = f"arch-journal-{numero_edicao:02d}"
    params["utm_content"] = bloco

    novo_query = urlencode(params)
    return urlunparse((parsed.scheme or "https", parsed.netloc or "www.norvia.example", parsed.path, parsed.params, novo_query, parsed.fragment))


def _formatar_data_edicao(data_prevista: str, numero_edicao: int) -> str:
    if data_prevista:
        parte = data_prevista[:10]
        partes = parte.split("-")
        if len(partes) == 3:
            return f"ED. {partes[2]}/{partes[1]}/{partes[0]}"
        return f"ED. {parte}"
    return f"ED. #{numero_edicao:02d}"


def construir_html_arch_journal(
    copy: Dict[str, Any],
    produto_principal_slug: str,
    numero_edicao: int = 1,
    data_prevista: str = "",
    fonte_nome: str = "Radar Norvia",
    fonte_link: str = "",
    pauta: str = "artigo_rss",
    usar_cdn_externa: bool = True,
    imagens: Dict[str, Any] | None = None,
) -> str:
    """
    Constrói o HTML do e-mail marketing conforme o padrão editorial Arch Journal.
    """
    from app.ambientes.gerenciador import obter_registro_imagem

    slug = produto_principal_slug if produto_principal_slug in PRODUTOS_NORVIA else "rodape_invertido"
    prod_principal = PRODUTOS_NORVIA[slug]
    tem_materia = (pauta != "guia_tecnico") and bool(fonte_link and fonte_link.startswith("http"))

    if not imagens or not imagens.get("hero") or not isinstance(imagens.get("cards"), list) or len(imagens.get("cards")) != 3:
        raise ValueError("Rascunho sem imagens de ambiente aprovadas selecionadas.")

    # Resolve URLs das imagens de ambiente
    url_base_imagens = settings.MARKETING_URL_PUBLICA_IMAGENS.rstrip("/")

    def _resolver_url_ambiente(img_id: str, slug_alvo: str) -> str:
        reg = obter_registro_imagem(img_id)
        if not reg or reg.get("status") != "aprovada":
            raise ValueError(f"Imagem '{img_id}' não está aprovada (recusada ou ausente).")
        if usar_cdn_externa:
            return f"{url_base_imagens}/ambientes/{slug_alvo}/{img_id}.jpg"
        return f"/api/marketing/ambientes/{img_id}.jpg"

    def _resolver_url_logo(negativo: bool = False) -> str:
        arquivo = "logo-norvia-negativo.png" if negativo else "logo-norvia.png"
        if usar_cdn_externa:
            return f"{url_base_imagens}/marca/{arquivo}"
        return f"/marketing/{arquivo}"

    logo_url = _resolver_url_logo(False)
    logo_negativo_url = _resolver_url_logo(True)
    hero_img_url = _resolver_url_ambiente(str(imagens["hero"]), slug)

    # Textos da copy
    preheader = copy.get("preheader") or "Informativo editorial Norvia com tendências de acabamento e especificação."
    selo_pauta = copy.get("selo_pauta") or f"PAUTA DA SEMANA • {prod_principal.get('categoria_tag', 'TENDÊNCIAS').upper()}"
    titulo_principal = copy.get("titulo_principal") or f"Especificação Técnica: {prod_principal['nome']}"
    texto_hero = copy.get("texto_hero") or (prod_principal.get("descricao_curta") or "")
    destaque_hero = copy.get("destaque_hero") or ""

    # Aplicação do <strong> no destaque_hero (com escape prévio seguro)
    texto_hero_escapado = _e(texto_hero)
    if destaque_hero:
        destaque_escapado = _e(destaque_hero)
        if destaque_escapado in texto_hero_escapado:
            texto_hero_escapado = texto_hero_escapado.replace(
                destaque_escapado,
                f'<strong style="color: #0F1E36;">{destaque_escapado}</strong>',
                1,
            )

    cta_hero_texto = copy.get("cta_hero_texto") or "EXPLORAR A TENDÊNCIA NA PRÁTICA →"
    cta_hero_url = _adicionar_utm(prod_principal.get("cta_url") or "https://www.norvia.example", numero_edicao, "hero_cta")

    # Crédito editorial da matéria
    credito_html = ""
    tit_mat = (copy.get("titulo_traduzido_ptbr") or "").strip()
    if tem_materia and tit_mat:
        credito_html = (
            f'<div style="margin-top: 18px; font-family: \'Plus Jakarta Sans\', sans-serif; font-size: 11px; color: #94A3B8;">'
            f'Referência: <a href="{_e(fonte_link)}" target="_blank" style="color: #64748B; text-decoration: underline;">'
            f'{_e(tit_mat)} — {_e(fonte_nome)}</a></div>'
        )

    # Cards técnicos (3 cards obrigatórios)
    cards_dados = copy.get("cards") or []
    if not isinstance(cards_dados, list) or len(cards_dados) != 3:
        raise ValueError("Copy sem os 3 cards técnicos obrigatórios.")

    cards_html_list: List[str] = []
    for idx_card, c in enumerate(cards_dados):
        c_slug = c.get("produto_slug") or slug
        c_prod = PRODUTOS_NORVIA.get(c_slug) or prod_principal
        c_img = _resolver_url_ambiente(str(imagens["cards"][idx_card]), c_slug)
        c_tema = c.get("pasta_tema") or f"PASTA {idx_card+1:02d} // TÉCNICA"
        c_num = f"{idx_card+1:02d}"
        c_frase = c.get("frase") or f"“Especificação técnica com {c_prod['nome_curto']}.”"
        if not (c_frase.startswith("“") or c_frase.startswith('"')):
            c_frase = f"“{c_frase}”"
        c_etiqueta = c.get("etiqueta_tecnica") or c_prod.get("categoria_tag") or "ALUMÍNIO"
        c_url = _adicionar_utm(c_prod.get("cta_url") or "https://www.norvia.example", numero_edicao, f"card_{idx_card+1}")
        margin_bottom = "18px" if idx_card < 2 else "0"

        cards_html_list.append(f"""
              <!-- CARD {c_num} -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #FFFFFF; border-radius: 18px; border: 1px solid #E2E8F0; margin-bottom: {margin_bottom}; box-shadow: 0 6px 16px -4px rgba(15, 30, 54, 0.05); overflow: hidden;">
                <tr>
                  <td style="padding: 18px;">
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td width="190" valign="top" class="stack-col">
                          <img src="{_e(c_img)}" alt="{_e(c_prod['nome'])}" width="190" style="display: block; width: 100%; border-radius: 12px; height: auto;" />
                        </td>
                        <td width="20" class="stack-col" style="height: 14px;"></td>
                        <td valign="top" class="stack-col">
                          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                            <tr>
                              <td align="left" style="font-family: 'Plus Jakarta Sans', sans-serif; font-size: 9.5px; font-weight: 700; letter-spacing: 1.4px; color: #0F1E36; text-transform: uppercase; padding-bottom: 6px;">
                                {_e(c_tema)}
                              </td>
                              <td align="right" style="font-family: 'Plus Jakarta Sans', sans-serif; font-size: 12px; font-weight: 800; color: #B8976C;">
                                {c_num}
                              </td>
                            </tr>
                            <tr>
                              <td colspan="2" style="font-family: 'Plus Jakarta Sans', sans-serif; font-size: 14px; font-weight: 500; line-height: 1.45; color: #0B132B; padding-bottom: 14px;">
                                {_e(c_frase)}
                              </td>
                            </tr>
                            <tr>
                              <td colspan="2" style="border-top: 1px solid #F1F5F9; padding-top: 10px;">
                                <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                                  <tr>
                                    <td align="left" style="font-family: 'Plus Jakarta Sans', sans-serif; font-size: 9px; font-weight: 700; color: #94A3B8; text-transform: uppercase;">
                                      {_e(c_etiqueta)}
                                    </td>
                                    <td align="right">
                                      <a href="{_e(c_url)}" target="_blank" style="font-family: 'Plus Jakarta Sans', sans-serif; font-size: 9.5px; font-weight: 700; color: #0F1E36; text-decoration: none; text-transform: uppercase;">
                                        VER DETALHE &rarr;
                                      </a>
                                    </td>
                                  </tr>
                                </table>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>""")

    cards_html = "\n".join(cards_html_list)

    # Links do Bloco B2B e Rodapé
    url_catalogo_canva = settings.MARKETING_URL_CATALOGO
    url_site_rodape = _adicionar_utm("https://www.norvia.example", numero_edicao, "rodape_site")
    url_instagram = "https://www.instagram.com/norvia.acabamentos/"
    url_atendimento = (settings.MARKETING_LINK_ATENDIMENTO or "").strip()
    atendimento_html = (
        f'\n                &nbsp;&bull;&nbsp;\n                '
        f'<a href="{_e(url_atendimento)}" target="_blank" style="color: #0F1E36; text-decoration: none;">Atendimento para Especificadores</a>'
        if url_atendimento
        else ""
    )

    selo_edicao_header = f"ARCH JOURNAL // ED. #{numero_edicao:02d}"
    selo_edicao_card = _formatar_data_edicao(data_prevista, numero_edicao)

    html_final = f"""<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="pt-BR">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>Norvia Acabamentos — Arch Journal #{numero_edicao:02d}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style type="text/css">
    body, table, td, a {{ -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }}
    table, td {{ mso-table-lspace: 0pt; mso-table-rspace: 0pt; }}
    img {{ -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }}
    body {{ margin: 0; padding: 0; width: 100% !important; background-color: #F1F5F9; font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #334155; }}
    .email-container {{ max-width: 600px; margin: 0 auto; background-color: #FFFFFF; border-radius: 24px; overflow: hidden; box-shadow: 0 20px 40px -10px rgba(15, 30, 54, 0.10); border: 1px solid #E2E8F0; }}
    .btn-pill {{ display: inline-block; background-color: #0F1E36; color: #FFFFFF !important; font-size: 11.5px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; text-decoration: none; padding: 16px 36px; border-radius: 100px; }}
    .btn-white {{ display: inline-block; background-color: #FFFFFF; color: #091322 !important; font-size: 11.5px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; text-decoration: none; padding: 16px 36px; border-radius: 100px; box-shadow: 0 10px 20px rgba(0,0,0,0.25); }}
    @media only screen and (max-width: 620px) {{
      .email-container {{ width: 100% !important; border-radius: 0 !important; }}
      .stack-col {{ display: block !important; width: 100% !important; max-width: 100% !important; }}
      .p-mobile {{ padding-left: 20px !important; padding-right: 20px !important; }}
      .img-mobile {{ width: 100% !important; height: auto !important; }}
    }}
  </style>
</head>
<body style="margin: 0; padding: 30px 10px; background-color: #F1F5F9;">

  <!-- Preheader Oculto para Caixas de Entrada -->
  <div style="display: none; font-size: 1px; color: #F1F5F9; line-height: 1px; max-height: 0px; max-width: 0px; opacity: 0; overflow: hidden;">
    {_e(preheader)}
  </div>

  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
    <tr>
      <td align="center">
        
        <!-- CONTAINER PRINCIPAL DO EMAIL (600px) -->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" class="email-container" style="max-width: 600px; background-color: #FFFFFF; border-radius: 24px; overflow: hidden; border: 1px solid #E2E8F0;">
          
          <!-- [BLOCO 01] CABEÇALHO CLEAN -->
          <tr>
            <td style="padding: 28px 36px; border-bottom: 1px solid #E2E8F0; background-color: #FFFFFF;" class="p-mobile">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="left" valign="middle">
                    <img src="{_e(logo_url)}" alt="Norvia Acabamentos" width="180" style="display: block; width: 180px; max-width: 100%; height: auto;" />
                  </td>
                  <td align="right" valign="middle">
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="background-color: #F8FAFC; border: 1px solid #E2E8F0; padding: 6px 14px; border-radius: 100px; font-family: 'Plus Jakarta Sans', sans-serif; font-size: 9.5px; font-weight: 700; letter-spacing: 1.6px; color: #0F1E36; text-transform: uppercase;">
                          {_e(selo_edicao_header)}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- [BLOCO 02] HERO SECTION -->
          <tr>
            <td style="padding: 34px 36px 40px; background-color: #FFFFFF;" class="p-mobile">
              
              <!-- Hero Image com bordas arredondadas -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 26px;">
                <tr>
                  <td style="border-radius: 20px; overflow: hidden; box-shadow: 0 12px 28px -8px rgba(15, 30, 54, 0.15); border: 1px solid #E2E8F0;">
                    <img src="{_e(hero_img_url)}" alt="{_e(titulo_principal)}" width="528" class="img-mobile" style="display: block; width: 100%; height: auto;" />
                  </td>
                </tr>
              </table>

              <!-- Tag Pauta da Semana -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin-bottom: 18px;">
                <tr>
                  <td style="background-color: #F1F5F9; border: 1px solid #E2E8F0; padding: 6px 14px; border-radius: 100px; font-family: 'Plus Jakarta Sans', sans-serif; font-size: 9px; font-weight: 700; letter-spacing: 1.8px; color: #0F1E36; text-transform: uppercase;">
                    {_e(selo_pauta)}
                  </td>
                </tr>
              </table>

              <!-- Headline Hero -->
              <h1 style="margin: 0 0 18px 0; font-family: 'Plus Jakarta Sans', sans-serif; font-size: 24px; font-weight: 800; color: #0B132B; line-height: 1.30; letter-spacing: -0.4px;">
                {_e(titulo_principal)}
              </h1>

              <!-- Copy Hero -->
              <p style="margin: 0 0 28px 0; font-family: 'Plus Jakarta Sans', sans-serif; font-size: 15.5px; line-height: 1.62; color: #475569;">
                {texto_hero_escapado}
              </p>

              <!-- CTA Principal -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <a href="{_e(cta_hero_url)}" target="_blank" class="btn-pill" style="font-family: 'Plus Jakarta Sans', sans-serif;">
                      {_e(cta_hero_texto)}
                    </a>
                  </td>
                </tr>
              </table>

              {credito_html}

            </td>
          </tr>

          <!-- [BLOCO 03] CADERNO DE ESPECIFICAÇÃO (CARDS MODERNOS) -->
          <tr>
            <td style="padding: 38px 36px; background-color: #F8FAFC; border-top: 1px solid #E2E8F0; border-bottom: 1px solid #E2E8F0;" class="p-mobile">
              
              <!-- Cabeçalho da Seção -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 22px;">
                <tr>
                  <td align="left">
                    <span style="font-family: 'Plus Jakarta Sans', sans-serif; font-size: 9.5px; font-weight: 700; letter-spacing: 1.6px; color: #64748B; text-transform: uppercase; display: block; margin-bottom: 4px;">
                      CADERNO DE ESPECIFICAÇÃO
                    </span>
                    <h3 style="margin: 0; font-family: 'Plus Jakarta Sans', sans-serif; font-size: 19px; font-weight: 800; color: #0B132B;">
                      Amostras Técnicas
                    </h3>
                  </td>
                  <td align="right" valign="bottom">
                    <span style="background-color: #FFFFFF; border: 1px solid #E2E8F0; padding: 4px 12px; border-radius: 100px; font-family: 'Plus Jakarta Sans', sans-serif; font-size: 9px; font-weight: 700; color: #0F1E36;">
                      {_e(selo_edicao_card)}
                    </span>
                  </td>
                </tr>
              </table>

              {cards_html}

            </td>
          </tr>

          <!-- [BLOCO 04] BLOCO EXECUTIVO B2B -->
          <tr>
            <td style="padding: 44px 36px; background-color: #091322;" class="p-mobile">
              
              <!-- Top Row com Tag Dourada e Logo Negativo -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 22px; border-bottom: 1px solid rgba(255,255,255,0.12); padding-bottom: 18px;">
                <tr>
                  <td align="left" valign="middle">
                    <span style="background-color: rgba(184, 151, 108, 0.15); border: 1px solid rgba(184, 151, 108, 0.35); padding: 5px 12px; border-radius: 100px; font-family: 'Plus Jakarta Sans', sans-serif; font-size: 9px; font-weight: 700; letter-spacing: 1.6px; color: #B8976C; text-transform: uppercase;">
                      PORTFÓLIO EXECUTIVO &bull; B2B
                    </span>
                  </td>
                  <td align="right" valign="middle">
                    <img src="{_e(logo_negativo_url)}" alt="Norvia" width="140" style="display: block; width: 140px; height: auto;" />
                  </td>
                </tr>
              </table>

              <!-- Headline B2B -->
              <h2 style="margin: 0 0 16px 0; font-family: 'Plus Jakarta Sans', sans-serif; font-size: 23px; font-weight: 800; color: #FFFFFF; line-height: 1.30;">
                “Leve essa precisão técnica para o seu próximo projeto executivo.”
              </h2>

              <!-- Copy B2B (Fixo institucional) -->
              <p style="margin: 0 0 28px 0; font-family: 'Plus Jakarta Sans', sans-serif; font-size: 15px; line-height: 1.62; color: #CBD5E1;">
                {_e(settings.TEXTO_FIXO_B2B)}
              </p>

              <!-- CTA Secundário Branco -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <a href="{_e(url_catalogo_canva)}" target="_blank" class="btn-white" style="font-family: 'Plus Jakarta Sans', sans-serif;">
                      ACESSAR CATÁLOGO NORVIA &nbsp;→
                    </a>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- [BLOCO 05] RODAPÉ INSTITUCIONAL -->
          <tr>
            <td align="center" style="padding: 38px 36px 32px; background-color: #FFFFFF; text-align: center;" class="p-mobile">
              
              <img src="{_e(logo_url)}" alt="Norvia Acabamentos" width="140" style="display: block; margin: 0 auto 20px auto; width: 140px; height: auto;" />

              <p style="margin: 0 0 20px 0; font-family: 'Plus Jakarta Sans', sans-serif; font-size: 11px; font-weight: 700; color: #0F1E36; text-transform: uppercase; letter-spacing: 0.8px;">
                <a href="{_e(url_site_rodape)}" target="_blank" style="color: #0F1E36; text-decoration: none;">norvia.example</a>
                &nbsp;&bull;&nbsp;
                <a href="{_e(url_instagram)}" target="_blank" style="color: #0F1E36; text-decoration: none;">@norvia.acabamentos</a>{atendimento_html}
              </p>

              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 20px;">
                <tr>
                  <td style="border-top: 1px solid #E2E8F0;"></td>
                </tr>
              </table>

              <p style="margin: 0 0 8px 0; font-family: 'Plus Jakarta Sans', sans-serif; font-size: 11.5px; line-height: 1.5; color: #94A3B8;">
                Você recebeu este informativo editorial por fazer parte da rede de arquitetos e especificadores parceiros da Norvia Acabamentos.
              </p>
              <p style="margin: 0; font-family: 'Plus Jakarta Sans', sans-serif; font-size: 11.5px; line-height: 1.5; color: #94A3B8;">
                Para atualizar suas preferências de comunicação ou descadastrar-se, <a href="{{{{unsubscribe_url}}}}" style="color: #64748B; text-decoration: underline;">acesse o gerenciador de inscrições</a>.
              </p>

            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>"""
    return html_final


def renderizar_email_marketing(
    copy: Dict[str, Any],
    produto: Dict[str, Any],
    para_rd_station: bool | None = None,
    usar_cdn_externa: bool | None = None,
    imagens: Dict[str, Any] | None = None,
) -> str:
    """Função de entrada que mantém compatibilidade de parâmetros."""
    if usar_cdn_externa is not None:
        modo_rd = usar_cdn_externa
    elif para_rd_station is not None:
        modo_rd = para_rd_station
    else:
        modo_rd = True

    slug = produto.get("slug") or "rodape_invertido"
    numero = int(copy.get("numero_edicao") or 1)
    data_prevista = copy.get("data_prevista") or ""
    fonte_nome = copy.get("fonte_nome") or "Radar Norvia"
    fonte_link = copy.get("fonte_link") or ""
    pauta = copy.get("pauta") or "artigo_rss"

    return construir_html_arch_journal(
        copy=copy,
        produto_principal_slug=slug,
        numero_edicao=numero,
        data_prevista=data_prevista,
        fonte_nome=fonte_nome,
        fonte_link=fonte_link,
        pauta=pauta,
        usar_cdn_externa=modo_rd,
        imagens=imagens,
    )
