"""
Roteador FinOps de Inteligência Artificial para E-mail Marketing e Carrossel Norvia.

Provedores configurados:
- Seleção e Triagem: Groq (openai/gpt-oss-120b), Gemini (gemini-3.8-flash), Anthropic, OpenAI.
- Redação: Anthropic (claude-sonnet-5-5), OpenAI (gpt-4o), Groq, Gemini.

Regras invioláveis:
1. Sem fallback silencioso em modo real (MOCK_MODE=false). Falha levanta IAIndisponivel.
2. Prompts enxutos (<12.000 caracteres) com base factual resumida (descricao_curta).
3. 429: lê Retry-After / x-ratelimit-reset-* e aguarda até 60s (máx 3 tentativas).
4. 404 Gemini: reporta erro de configuração claro ("ajuste GEMINI_FREE_MODEL").
5. Validação rigorosa do JSON produzido; retry no mesmo provedor com feedback se reprovado.
"""
from __future__ import annotations

import json
import logging
import re
import time
import unicodedata
from typing import Any, Callable, Dict, List, Optional, Tuple

import requests

from app.config import KB_NORVIA, PRODUTOS_NORVIA, settings

logger = logging.getLogger("marketing.finops")


class IAIndisponivel(Exception):
    """Levantada quando nenhum provedor de IA consegue gerar um resultado válido."""
    pass


def _normalizar_texto(texto: str) -> str:
    """Normaliza texto para busca insensível a acento, maiúsculas e pontuação."""
    if not texto:
        return ""
    nfkd = unicodedata.normalize("NFKD", texto)
    sem_acento = "".join(c for c in nfkd if not unicodedata.combining(c))
    sem_pont = re.sub(r"[^\w\s]", " ", sem_acento.lower())
    return " ".join(sem_pont.split())


def _resumo_factual_catalogo() -> str:
    """
    Bloco factual ultra-enxuto para os prompts (<2.000 caracteres),
    usando descricao_curta para caber com folga nas cotas das IAs.
    """
    linhas_txt = []
    for slug, info in PRODUTOS_NORVIA.items():
        desc_curta = info.get("descricao_curta") or info.get("resumo_card") or ""
        linhas_txt.append(
            f"- SLUG '{slug}': {info.get('nome_curto')} (Ref: {info.get('referencia')} | {info.get('categoria_oficial')})\n"
            f"  * Função oficial: {desc_curta}\n"
            f"  * Opções no site: {info.get('especificacoes_site') or 'Consultar opções'}"
        )

    empresa = KB_NORVIA.get("empresa") or {}
    razao = empresa.get("razao_nome", "Norvia Acabamentos")
    fundacao = empresa.get("fundacao", "Fundada em 2014 em Curitiba-PR")

    return f"""BASE FACTUAL NORVIA (https://www.norvia.example/ — PROIBIDO INVENTAR FORA DISTO):
Empresa: {razao} ({fundacao}). CDs em Campinas-SP e Curitiba-PR.

REGRAS TÉCNICAS ESTRITAS:
- Perfil T (perfil_t): Transição e dilatação entre pisos no MESMO NÍVEL. NUNCA associar a vidro, esquadrias ou paredes!
- Redutor (redutor_piso): Transição suave entre pisos em NÍVEIS DIFERENTES (desníveis).
- Cantoneira (cantoneira): Proteção e acabamento de quinas e cantos de parede ou degraus de escada.
- Rodapés Invertidos (rodape_invertido, rodape_invertido_aquila, rodape_orion_led): Perfis em alumínio para parede suspensa e luz indireta em LED.
- Perfis de LED e Listelos (perfil_led_embutir, listelo_velino): Iluminação linear difusa e filetes decorativos para paredes e móveis.

PRODUTOS NORVIA DISPONÍVEIS:
{chr(10).join(linhas_txt)}"""


def _extrair_json_seguro(texto: str) -> Dict[str, Any]:
    texto_limpo = (texto or "").strip()
    match = re.search(r"\{[\s\S]*\}", texto_limpo)
    if match:
        texto_limpo = match.group(0)
    return json.loads(texto_limpo)


def _obter_segundos_espera_429(resp: requests.Response) -> float:
    """Extrai o tempo de espera recomendado em respostas HTTP 429."""
    retry_after = resp.headers.get("Retry-After")
    if retry_after:
        try:
            return float(retry_after)
        except ValueError:
            pass
    for h in ("x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"):
        val = resp.headers.get(h)
        if val:
            m = re.match(r"^([\d.]+)(ms|s|m)?$", val.strip())
            if m:
                qtd = float(m.group(1))
                unidade = m.group(2) or "s"
                if unidade == "ms":
                    return qtd / 1000.0
                elif unidade == "m":
                    return qtd * 60.0
                return qtd
    return 3.0


def _chamar_groq_json(prompt_sistema: str, prompt_usuario: str) -> Tuple[Optional[Dict[str, Any]], str]:
    if not settings.GROQ_API_KEY:
        return None, ""

    modelos = [settings.GROQ_FREE_MODEL or "openai/gpt-oss-120b", "openai/gpt-oss-20b"]
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.GROQ_API_KEY}",
        "Content-Type": "application/json",
    }
    ultimo_motivo = "sem resposta"

    for modelo in dict.fromkeys(modelos):
        payload = {
            "model": modelo,
            "temperature": 0.2,
            "max_completion_tokens": 8192,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": prompt_sistema},
                {"role": "user", "content": prompt_usuario},
            ],
        }
        for tentativa in range(3):
            try:
                resp = requests.post(url, headers=headers, json=payload, timeout=(10, 90))
                if resp.ok:
                    data = resp.json()
                    raw_text = data["choices"][0]["message"]["content"]
                    try:
                        parsed = _extrair_json_seguro(raw_text)
                    except Exception:
                        ultimo_motivo = "JSON inválido"
                        break
                    parsed["_provedor"] = f"Groq API ({modelo})"
                    return parsed, ""
                elif resp.status_code == 429:
                    espera = min(60.0, max(1.0, _obter_segundos_espera_429(resp)))
                    logger.warning("Groq (%s) HTTP 429 (tentativa %d/3). Aguardando %.1fs...", modelo, tentativa + 1, espera)
                    ultimo_motivo = "HTTP 429 após 3 tentativas"
                    time.sleep(espera)
                    continue
                elif resp.status_code == 413:
                    logger.warning("Groq (%s) HTTP 413: prompt excessivamente grande. Abortando este modelo.", modelo)
                    ultimo_motivo = "HTTP 413: prompt excessivamente grande"
                    break
                else:
                    ultimo_motivo = f"HTTP {resp.status_code}"
                    logger.warning("Groq (%s) HTTP %s: %s", modelo, resp.status_code, resp.text[:200])
                    break
            except requests.Timeout:
                ultimo_motivo = "timeout"
                logger.warning("Groq (%s) timeout", modelo)
                break
            except Exception as exc:
                ultimo_motivo = f"exceção ({exc})"
                logger.warning("Falha ao chamar Groq (%s): %s", modelo, exc)
                break
    return None, ultimo_motivo


def _chamar_gemini_json(prompt_sistema: str, prompt_usuario: str) -> Tuple[Optional[Dict[str, Any]], str]:
    """Tenta o GEMINI_FREE_MODEL e, se ele estiver sobrecarregado (500/503), os de GEMINI_FALLBACK_MODELS."""
    if not settings.GEMINI_API_KEY:
        return None, ""
    principal = settings.GEMINI_FREE_MODEL or "gemini-3.8-flash"
    reservas = [m.strip() for m in (settings.GEMINI_FALLBACK_MODELS or "").split(",") if m.strip()]
    motivos: List[str] = []
    for modelo in dict.fromkeys([principal, *reservas]):
        dados, motivo = _chamar_gemini_modelo(modelo, prompt_sistema, prompt_usuario)
        if dados is not None:
            return dados, ""
        motivos.append(f"{modelo}: {motivo}")
        if not motivo.startswith(("HTTP 500", "HTTP 503")):
            break
    return None, "; ".join(motivos)


def _chamar_gemini_modelo(modelo: str, prompt_sistema: str, prompt_usuario: str) -> Tuple[Optional[Dict[str, Any]], str]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent"
    payload = {
        "systemInstruction": {"parts": [{"text": prompt_sistema}]},
        "contents": [{"parts": [{"text": prompt_usuario}]}],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 8192,
            "responseMimeType": "application/json",
        },
    }
    headers = {"x-goog-api-key": settings.GEMINI_API_KEY, "Content-Type": "application/json"}
    ultimo_motivo = "sem resposta"

    for tentativa in range(3):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=(10, 90))
            if resp.ok:
                data = resp.json()
                raw_text = data["candidates"][0]["content"]["parts"][0]["text"]
                try:
                    parsed = _extrair_json_seguro(raw_text)
                except Exception:
                    return None, "JSON inválido"
                parsed["_provedor"] = f"Google Gemini ({modelo})"
                return parsed, ""
            elif resp.status_code == 404:
                motivo = f"HTTP 404: modelo {modelo} indisponível — ajuste GEMINI_FREE_MODEL"
                logger.error(motivo)
                return None, motivo
            elif resp.status_code == 429:
                espera = min(60.0, max(1.0, _obter_segundos_espera_429(resp)))
                logger.warning("Gemini HTTP 429 (tentativa %d/3). Aguardando %.1fs...", tentativa + 1, espera)
                ultimo_motivo = "HTTP 429 após 3 tentativas"
                time.sleep(espera)
                continue
            elif resp.status_code in (500, 503):
                espera = 5.0 * (tentativa + 1)
                logger.warning("Gemini HTTP %s (tentativa %d/3). Aguardando %.0fs...", resp.status_code, tentativa + 1, espera)
                ultimo_motivo = f"HTTP {resp.status_code} após 3 tentativas"
                time.sleep(espera)
                continue
            elif resp.status_code == 413:
                logger.warning("Gemini HTTP 413: payload grande demais.")
                return None, "HTTP 413: payload grande demais"
            else:
                logger.warning("Gemini HTTP %s: %s", resp.status_code, resp.text[:200])
                return None, f"HTTP {resp.status_code}"
        except requests.Timeout:
            ultimo_motivo = "timeout"
            logger.warning("Gemini timeout")
            break
        except Exception as exc:
            ultimo_motivo = f"exceção ({exc})"
            logger.warning("Falha ao chamar Gemini API: %s", exc)
            break
    return None, ultimo_motivo


def _chamar_anthropic_json(prompt_sistema: str, prompt_usuario: str) -> Tuple[Optional[Dict[str, Any]], str]:
    if not settings.ANTHROPIC_API_KEY:
        return None, ""

    headers = {
        "x-api-key": settings.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    payload = {
        "model": settings.ANTHROPIC_MODEL,
        "max_tokens": 4096,
        "system": prompt_sistema,
        "messages": [
            {"role": "user", "content": prompt_usuario + "\n\nResponda estritamente com JSON puro."}
        ],
    }
    try:
        resp = requests.post("https://api.anthropic.com/v1/messages", headers=headers, json=payload, timeout=(10, 120))
        if resp.ok:
            data = resp.json()
            content_blocks = data.get("content") or []
            text_block = next((b.get("text") for b in content_blocks if b.get("type") == "text"), None)
            if text_block:
                try:
                    parsed = _extrair_json_seguro(text_block)
                except Exception:
                    return None, "JSON inválido"
                parsed["_provedor"] = f"Anthropic ({settings.ANTHROPIC_MODEL})"
                return parsed, ""
        return None, f"HTTP {resp.status_code}"
    except requests.Timeout:
        return None, "timeout"
    except Exception as exc:
        return None, f"exceção ({exc})"


def _chamar_openai_json(prompt_sistema: str, prompt_usuario: str) -> Tuple[Optional[Dict[str, Any]], str]:
    if not settings.OPENAI_API_KEY:
        return None, ""

    headers = {
        "Authorization": f"Bearer {settings.OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": settings.OPENAI_MODEL,
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": prompt_sistema},
            {"role": "user", "content": prompt_usuario},
        ],
    }
    try:
        resp = requests.post("https://api.openai.com/v1/chat/completions", headers=headers, json=payload, timeout=(10, 120))
        if resp.ok:
            data = resp.json()
            raw_text = data["choices"][0]["message"]["content"]
            try:
                parsed = _extrair_json_seguro(raw_text)
            except Exception:
                return None, "JSON inválido"
            parsed["_provedor"] = f"OpenAI ({settings.OPENAI_MODEL})"
            return parsed, ""
        return None, f"HTTP {resp.status_code}"
    except requests.Timeout:
        return None, "timeout"
    except Exception as exc:
        return None, f"exceção ({exc})"


def _executar_com_provedores(
    prompt_sistema: str,
    prompt_usuario: str,
    provedores: List[Tuple[str, Callable[[str, str], Tuple[Optional[Dict[str, Any]], str]]]],
    validador_fn: Optional[Callable[[Dict[str, Any]], List[str]]] = None,
) -> Dict[str, Any]:
    """
    Executa a requisição passando pelos provedores configurados em ordem.
    Provedores sem chave ficam fora da lista de falhas.
    Se o validador reprovar, reenvia para o mesmo provedor uma vez com feedback.
    Se todos falharem:
      - Em modo real: levanta IAIndisponivel com motivo exato.
    """
    falhas: List[str] = []

    for nome, fn in provedores:
        try:
            resultado, motivo_falha = fn(prompt_sistema, prompt_usuario)
            if resultado is None:
                if motivo_falha:
                    falhas.append(f"{nome}: {motivo_falha}")
                continue

            if validador_fn:
                erros = validador_fn(resultado)
                if erros:
                    logger.warning("%s retornou JSON inválido: %s. Tentando correção...", nome, "; ".join(erros))
                    prompt_correcao = (
                        f"{prompt_usuario}\n\nATENÇÃO: A sua resposta anterior foi recusada pelos seguintes erros:\n"
                        + "\n".join(f"- {e}" for e in erros)
                        + "\nCorrija todos os pontos acima e retorne o JSON estritamente válido."
                    )
                    resultado_corrigido, motivo_corr = fn(prompt_sistema, prompt_correcao)
                    if resultado_corrigido:
                        erros_segunda = validador_fn(resultado_corrigido)
                        if not erros_segunda:
                            return resultado_corrigido
                        falhas.append(f"{nome}: inválido após retry ({'; '.join(erros_segunda)})")
                    else:
                        falhas.append(f"{nome}: falha no retry de validação ({motivo_corr or 'sem resposta'})")
                    continue

            return resultado
        except Exception as e:
            falhas.append(f"{nome}: exceção ({e})")

    motivo = "; ".join(falhas) if falhas else "nenhum provedor configurado com chave respondeu"
    raise IAIndisponivel(f"Nenhum provedor de IA entregou resultado válido. Detalhes: {motivo}")


def _contem_reticencias_qualquer_nivel(obj: Any) -> bool:
    """Verifica recursivamente se qualquer string em qualquer nível contém reticências."""
    if isinstance(obj, str):
        return "..." in obj or "…" in obj or obj.strip().endswith("...") or obj.strip().endswith("…")
    elif isinstance(obj, list):
        return any(_contem_reticencias_qualquer_nivel(item) for item in obj)
    elif isinstance(obj, dict):
        return any(_contem_reticencias_qualquer_nivel(v) for k, v in obj.items() if k != "_provedor")
    return False


def validar_copy_edicao(
    copy: Dict[str, Any],
    produto: Dict[str, Any],
    tem_materia: bool = True,
    titulo_original_materia: Optional[str] = None,
) -> List[str]:
    """
    Validador estrito do JSON da edição conforme o padrão editorial Arch Journal (Seção B4).
    Retorna lista vazia se válido, ou lista com as razões de recusa.
    """
    erros: List[str] = []
    campos_obrigatorios = [
        "assunto",
        "assunto_alt",
        "preheader",
        "selo_pauta",
        "titulo_principal",
        "texto_hero",
        "destaque_hero",
        "cta_hero_texto",
        "cards",
        "carrossel",
        "legenda_instagram",
    ]

    for campo in campos_obrigatorios:
        val = copy.get(campo)
        if val is None or (isinstance(val, str) and not val.strip()) or (isinstance(val, list) and not val):
            erros.append(f"campo obrigatório ausente ou vazio: '{campo}'")

    if erros:
        return erros

    # Limites de tamanho dos campos de texto
    if len(copy.get("assunto", "")) > 70:
        erros.append(f"'assunto' excede 70 caracteres ({len(copy.get('assunto', ''))})")
    if len(copy.get("preheader", "")) > 140:
        erros.append(f"'preheader' excede 140 caracteres ({len(copy.get('preheader', ''))})")
    if len(copy.get("selo_pauta", "")) > 50:
        erros.append(f"'selo_pauta' excede 50 caracteres ({len(copy.get('selo_pauta', ''))})")
    if len(copy.get("titulo_principal", "")) > 110:
        erros.append(f"'titulo_principal' excede 110 caracteres ({len(copy.get('titulo_principal', ''))})")
    if len(copy.get("texto_hero", "")) > 380:
        erros.append(f"'texto_hero' excede 380 caracteres ({len(copy.get('texto_hero', ''))})")
    if len(copy.get("cta_hero_texto", "")) > 40:
        erros.append(f"'cta_hero_texto' excede 40 caracteres ({len(copy.get('cta_hero_texto', ''))})")
    if len(copy.get("legenda_instagram", "")) > 2200:
        erros.append(f"'legenda_instagram' excede 2200 caracteres ({len(copy.get('legenda_instagram', ''))})")

    # Verificação profunda de reticências em qualquer nível (A6)
    if _contem_reticencias_qualquer_nivel(copy):
        erros.append("conteúdo contém reticências proibidas (...) ou (…)")

    # Validação do destaque_hero (deve constar literalmente em texto_hero)
    texto_hero = copy.get("texto_hero", "")
    destaque_hero = copy.get("destaque_hero", "")
    if destaque_hero and destaque_hero not in texto_hero:
        erros.append(f"'destaque_hero' ('{destaque_hero}') não aparece literalmente em 'texto_hero'")

    # Validação dos cards técnicos (B4 & B6)
    cards = copy.get("cards") or []
    if not isinstance(cards, list) or len(cards) != 3:
        erros.append(f"'cards' deve ter exatamente 3 itens (tem {len(cards) if isinstance(cards, list) else 0})")
    else:
        from app.ambientes.gerenciador import listar_produtos_elegiveis
        elegiveis = set(listar_produtos_elegiveis())

        slugs_cards = []
        for idx, c in enumerate(cards):
            if not isinstance(c, dict):
                erros.append(f"card {idx + 1} não é um objeto")
                continue
            c_slug = c.get("produto_slug", "")
            slugs_cards.append(c_slug)
            if not c_slug or c_slug not in PRODUTOS_NORVIA:
                erros.append(f"card {idx + 1} possui produto_slug inválido: '{c_slug}'")
            elif c_slug not in elegiveis:
                erros.append(f"card {idx + 1} usa linha '{c_slug}' sem imagem de ambiente aprovada")

            pasta = c.get("pasta_tema", "")
            if len(pasta) > 28:
                erros.append(f"pasta_tema do card {idx + 1} excede 28 caracteres ({len(pasta)})")
            frase = c.get("frase", "")
            if len(frase) > 120:
                erros.append(f"frase do card {idx + 1} excede 120 caracteres ({len(frase)})")
            etiqueta = c.get("etiqueta_tecnica", "")
            if len(etiqueta) > 30:
                erros.append(f"etiqueta_tecnica do card {idx + 1} excede 30 caracteres ({len(etiqueta)})")

        if len(slugs_cards) == 3:
            if len(set(slugs_cards)) < 3:
                erros.append("cards não podem repetir produto_slug")
            prod_slug_esperado = produto.get("slug")
            if prod_slug_esperado and slugs_cards[0] != prod_slug_esperado:
                erros.append(f"primeiro card deve ser o produto da edição ('{prod_slug_esperado}'), recebido '{slugs_cards[0]}'")

    # Carrossel: 6 a 8 slides
    carrossel = copy.get("carrossel") or []
    if not (6 <= len(carrossel) <= 8):
        erros.append(f"'carrossel' deve ter entre 6 e 8 slides (tem {len(carrossel)})")
    else:
        if carrossel[0].get("tipo") != "capa":
            erros.append("primeiro slide do carrossel deve ser do tipo 'capa'")
        if carrossel[-1].get("tipo") != "cta":
            erros.append("último slide do carrossel deve ser do tipo 'cta'")
        if not any(s.get("tipo") == "produto" for s in carrossel):
            erros.append("carrossel deve ter pelo menos um slide do tipo 'produto'")

        for idx, s in enumerate(carrossel):
            if not isinstance(s, dict):
                erros.append(f"slide {idx + 1} não é um objeto")
                continue
            t = s.get("titulo", "")
            txt = s.get("texto", "")
            if not t or not txt:
                erros.append(f"slide {idx + 1} deve ter 'titulo' e 'texto'")
            if len(t) > 60:
                erros.append(f"título do slide {idx + 1} excede 60 caracteres ({len(t)})")
            if len(txt) > 240:
                erros.append(f"texto do slide {idx + 1} excede 240 caracteres ({len(txt)})")

    if tem_materia and titulo_original_materia:
        if copy.get("titulo_principal", "").strip().lower() == titulo_original_materia.strip().lower():
            erros.append("título principal em inglês idêntico à matéria (deve ser traduzido para pt-BR)")

    return erros


def selecionar_melhores_pautas_da_semana(
    artigos: List[Dict[str, Any]],
) -> Tuple[Tuple[Optional[Dict[str, Any]], str, str], Tuple[Optional[Dict[str, Any]], str, str]]:
    """
    Analisa os artigos coletados e seleciona matérias para segunda e quinta.
    Retorna: ((artigo_seg, slug_seg, pauta_seg), (artigo_qui, slug_qui, pauta_qui))
    onde pauta pode ser 'artigo_rss' ou 'guia_tecnico'.
    """
    from app.ambientes.gerenciador import listar_produtos_elegiveis
    elegiveis = listar_produtos_elegiveis()
    if not elegiveis:
        raise IAIndisponivel("Nenhuma linha com imagem de ambiente aprovada.")

    slugs_segunda = [s for s in ["rodape_invertido", "rodape_invertido_aquila", "rodape_orion_led", "perfil_led_embutir"] if s in elegiveis] or elegiveis
    slugs_quinta = [s for s in ["perfil_t", "redutor_piso", "cantoneira", "listelo_velino"] if s in elegiveis] or elegiveis

    if settings.MOCK_MODE:
        art0 = artigos[0] if artigos else None
        art1 = artigos[1] if len(artigos) > 1 else art0
        return ((art0, slugs_segunda[0], "artigo_rss" if art0 else "guia_tecnico"),
                (art1, slugs_quinta[0], "artigo_rss" if art1 else "guia_tecnico"))

    if not artigos:
        return ((None, slugs_segunda[0], "guia_tecnico"), (None, slugs_quinta[0], "guia_tecnico"))

    # Monta lista de matérias compacta (<400 caracteres de resumo)
    linhas_artigos = []
    for idx, a in enumerate(artigos[:18]):
        resumo_curto = (a.get("resumo_rss") or "")[:350].strip()
        linhas_artigos.append(f"[{idx}] Fonte: {a.get('fonte_nome')} | Título: {a.get('titulo')}\n    Resumo: {resumo_curto}")

    prompt_sistema = f"""Você é o Diretor Editorial da Norvia Acabamentos.
Escolha as 2 melhores matérias da lista para conectar com nossos produtos em duas edições semanais.

{_resumo_factual_catalogo()}

REGRAS:
- Segunda-feira: escolha um produto entre {slugs_segunda} e uma matéria de interiores/iluminação compatível.
- Quinta-feira: escolha um produto entre {slugs_quinta} e uma matéria DIFERENTE da de segunda.
- Para cada dia, extraia 'trecho_da_materia': uma frase COPIADA LITERALMENTE do título ou do resumo da matéria que evidencia pisos, rodapés, quinas, paredes ou iluminação.
- 'nota_aderencia': número de 0 a 10 indicando a aderência real da obra com o acabamento.

Retorne ESTRITAMENTE JSON:
{{
  "segunda": {{
    "indice_artigo": número inteiro,
    "produto_slug": "um dos slugs permitidos",
    "nota_aderencia": número de 0 a 10,
    "trecho_da_materia": "frase literal copiada da matéria"
  }},
  "quinta": {{
    "indice_artigo": número inteiro diferente de segunda,
    "produto_slug": "um dos slugs permitidos",
    "nota_aderencia": número de 0 a 10,
    "trecho_da_materia": "frase literal copiada da matéria"
  }}
}}"""

    prompt_usuario = "NOTÍCIAS DA SEMANA PARA SELEÇÃO:\n" + "\n\n".join(linhas_artigos)

    provedores = [
        ("Groq", _chamar_groq_json),
        ("Gemini", _chamar_gemini_json),
        ("Anthropic", _chamar_anthropic_json),
        ("OpenAI", _chamar_openai_json),
    ]

    # Falha na chamada da IA levanta IAIndisponivel e falha a geração (A5)
    dados = _executar_com_provedores(prompt_sistema, prompt_usuario, provedores)

    def _avaliar_dia(info: Dict[str, Any], slugs_permitidos: List[str], idx_bloqueado: Optional[int]) -> Tuple[Optional[Dict[str, Any]], str, str]:
        slug = info.get("produto_slug")
        if slug not in slugs_permitidos:
            slug = slugs_permitidos[0]

        try:
            idx = int(info.get("indice_artigo", -1))
            nota = float(info.get("nota_aderencia", 0))
            trecho = str(info.get("trecho_da_materia") or "").strip()
        except (ValueError, TypeError):
            return (None, slug, "guia_tecnico")

        if idx < 0 or idx >= len(artigos) or (idx_bloqueado is not None and idx == idx_bloqueado):
            return (None, slug, "guia_tecnico")

        if nota < 6.0:
            return (None, slug, "guia_tecnico")

        artigo = artigos[idx]
        conteudo_artigo_norm = _normalizar_texto(f"{artigo.get('titulo', '')} {artigo.get('resumo_rss') or artigo.get('resumo', '')}")
        trecho_norm = _normalizar_texto(trecho)

        if not trecho_norm or trecho_norm not in conteudo_artigo_norm:
            logger.info("Trecho literal '%s' não encontrado na matéria [%d]. Edição vira guia técnico.", trecho, idx)
            return (None, slug, "guia_tecnico")

        return (artigo, slug, "artigo_rss")

    info_seg = dados.get("segunda") or {}
    info_qui = dados.get("quinta") or {}

    art_seg, slug_seg, pauta_seg = _avaliar_dia(info_seg, slugs_segunda, idx_bloqueado=None)
    idx_seg = artigos.index(art_seg) if art_seg in artigos else None
    art_qui, slug_qui, pauta_qui = _avaliar_dia(info_qui, slugs_quinta, idx_bloqueado=idx_seg)

    return ((art_seg, slug_seg, pauta_seg), (art_qui, slug_qui, pauta_qui))


def triar_e_conectar_produto_norvia(
    artigo: Optional[Dict[str, Any]],
    texto_limpo: str = "",
    produto_preferencial: Optional[str] = None,
    pauta: str = "artigo_rss",
) -> Dict[str, Any]:
    """Prepara a triagem e conexão técnica com o produto Norvia com validação estrita (A6)."""
    slug_alvo = produto_preferencial if produto_preferencial in PRODUTOS_NORVIA else "rodape_invertido"
    produto = PRODUTOS_NORVIA[slug_alvo]

    if pauta == "guia_tecnico" or not artigo:
        return {
            "nota_relevancia_norvia": 100,
            "titulo_traduzido_ptbr": f"Guia de Especificação: {produto['nome_curto']}",
            "produto_norvia_slug": slug_alvo,
            "angulo_conexao_norvia": produto.get("resumo_card") or produto.get("descricao_curta") or "",
            "resumo_executivo": produto.get("descricao_curta") or "",
            "pauta": "guia_tecnico",
            "_provedor": "Catálogo Oficial Norvia",
        }

    if settings.MOCK_MODE:
        return {
            "nota_relevancia_norvia": 95,
            "titulo_traduzido_ptbr": "Arquitetura Residencial e Detalhes de Acabamento",
            "produto_norvia_slug": slug_alvo,
            "angulo_conexao_norvia": produto.get("resumo_card") or "",
            "resumo_executivo": (artigo.get("resumo_rss") or "")[:200],
            "pauta": "artigo_rss",
            "_provedor": "Mock Teste",
        }

    conteudo_base = (texto_limpo or artigo.get("resumo_rss") or artigo.get("titulo") or "")[:3000]

    prompt_sistema = f"""Você é o Arquiteto Especificador da Norvia Acabamentos.
{_resumo_factual_catalogo()}

Conecte a matéria abaixo com o produto '{produto['nome_curto']}' (slug: '{slug_alvo}'):
- Função do produto: {produto.get('descricao_curta')}
- Especificações: {produto.get('especificacoes_site')}

REGRAS:
- Nunca afirme que a obra apresentada usa Norvia. Estabeleça como o desafio do projeto se relaciona ao acabamento.
- 'titulo_traduzido_ptbr': Manchete em português do Brasil sem emojis e sem reticências.
- 'resumo_executivo': Resumo em português em 2 frases completas sem reticências.

Retorne JSON:
{{
  "nota_relevancia_norvia": 90,
  "titulo_traduzido_ptbr": "título editorial em português",
  "produto_norvia_slug": "{slug_alvo}",
  "angulo_conexao_norvia": "como o produto soluciona detalhe similar na obra",
  "resumo_executivo": "resumo de 2 frases da matéria"
}}"""

    prompt_usuario = (
        f"Fonte: {artigo.get('fonte_nome')}\n"
        f"Título Original: {artigo.get('titulo')}\n"
        f"Texto:\n{conteudo_base}"
    )

    provedores = [
        ("Groq", _chamar_groq_json),
        ("Gemini", _chamar_gemini_json),
        ("Anthropic", _chamar_anthropic_json),
        ("OpenAI", _chamar_openai_json),
    ]

    def _validador_triagem(d: Dict[str, Any]) -> List[str]:
        errs = []
        tit = str(d.get("titulo_traduzido_ptbr") or "").strip()
        res_exec = str(d.get("resumo_executivo") or "").strip()
        if not tit:
            errs.append("titulo_traduzido_ptbr vazio")
        elif "..." in tit or "…" in tit:
            errs.append("titulo_traduzido_ptbr com reticências")
        if not res_exec:
            errs.append("resumo_executivo vazio")
        elif "..." in res_exec or "…" in res_exec:
            errs.append("resumo_executivo com reticências")
        return errs

    res = _executar_com_provedores(prompt_sistema, prompt_usuario, provedores, validador_fn=_validador_triagem)
    res["produto_norvia_slug"] = slug_alvo
    res["pauta"] = "artigo_rss"
    return res


def gerar_copy_edicao_norvia(
    artigo: Optional[Dict[str, Any]],
    triagem: Dict[str, Any],
    dia_publicacao: str = "Segunda-feira",
    numero_edicao: int = 1,
    pauta: str = "artigo_rss",
) -> Dict[str, Any]:
    """Redige a edição completa no padrão Arch Journal com validação estrita (B4)."""
    slug_produto = triagem.get("produto_norvia_slug") or "rodape_invertido"
    if slug_produto not in PRODUTOS_NORVIA:
        slug_produto = "rodape_invertido"
    produto = PRODUTOS_NORVIA[slug_produto]
    tem_materia = pauta != "guia_tecnico" and artigo is not None

    from app.ambientes.gerenciador import listar_produtos_elegiveis
    linhas_elegiveis = listar_produtos_elegiveis()
    if len(linhas_elegiveis) < 3:
        raise IAIndisponivel(
            f"São precisas 3 linhas com imagem aprovada para os cards; aprovadas: {len(linhas_elegiveis)}."
        )

    outras_linhas = [s for s in linhas_elegiveis if s != slug_produto]
    slug_card2 = outras_linhas[0] if outras_linhas else slug_produto
    slug_card3 = outras_linhas[1] if len(outras_linhas) > 1 else (outras_linhas[0] if outras_linhas else slug_produto)
    prod2 = PRODUTOS_NORVIA.get(slug_card2) or produto
    prod3 = PRODUTOS_NORVIA.get(slug_card3) or produto

    if settings.MOCK_MODE:
        ref = produto.get("referencia", "NRV")
        nome_c = produto.get("nome_curto", "Produto Norvia")
        return {
            "assunto": f"{nome_c}: precisão técnica em projetos de interiores"[:70],
            "assunto_alt": f"Especificação técnica Norvia: {nome_c}"[:70],
            "preheader": f"Conheça as soluções de acabamento com {ref} para projetos residenciais."[:120],
            "selo_pauta": f"PAUTA DA SEMANA • {produto.get('categoria_tag', 'TENDÊNCIAS')[:30].upper()}",
            "titulo_principal": f"Por que a especificação de {nome_c} redefine o alto padrão contemporâneo"[:110],
            "texto_hero": f"Na arquitetura contemporânea, o verdadeiro luxo está nos detalhes milimétricos. O minimalismo contínuo substitui arremates pesados pela precisão do {produto['nome']} em alumínio.",
            "destaque_hero": "minimalismo contínuo",
            "cta_hero_texto": "EXPLORAR A TENDÊNCIA NA PRÁTICA →"[:40],
            "cards": [
                {
                    "produto_slug": slug_produto,
                    "pasta_tema": f"PASTA 01 // {produto.get('categoria_tag', 'DETALHE')[:20]}",
                    "frase": f"“Precisão milimétrica e acabamento contínuo com a linha {nome_c}.”",
                    "etiqueta_tecnica": f"REF. {ref} EM ALUMÍNIO"[:30],
                },
                {
                    "produto_slug": slug_card2,
                    "pasta_tema": f"PASTA 02 // {prod2.get('categoria_tag', 'ILUMINAÇÃO')[:20]}",
                    "frase": f"“Luz linear integrada e difusão homogênea em {prod2.get('nome_curto', 'acabamentos')[:30]}.”",
                    "etiqueta_tecnica": f"REF. {prod2.get('referencia', 'NRV')} NORVIA"[:30],
                },
                {
                    "produto_slug": slug_card3,
                    "pasta_tema": f"PASTA 03 // {prod3.get('categoria_tag', 'TRANSIÇÃO')[:20]}",
                    "frase": f"“Proteção de bordas e alinhamento milimétrico com {prod3.get('nome_curto', 'filetes')[:30]}.”",
                    "etiqueta_tecnica": f"REF. {prod3.get('referencia', 'NRV')} NORVIA"[:30],
                },
            ],
            "carrossel": [
                {"tipo": "capa", "titulo": f"{nome_c} na Arquitetura", "texto": "Precisão e acabamento impecável em projetos residenciais contemporâneos."},
                {"tipo": "texto", "titulo": "O Desafio Construtivo", "texto": "O encontro entre diferentes revestimentos exige soluções de dilatação e proteção de quinas."},
                {"tipo": "texto", "titulo": "Solução Técnica", "texto": "Perfis em alumínio proporcionam alinhamento limpo e durabilidade comprovada na obra."},
                {"tipo": "produto", "titulo": f"{produto['nome']}", "texto": f"Ref. {ref} — {produto.get('especificacoes_site', 'Alumínio de alta qualidade')}."},
                {"tipo": "texto", "titulo": "Instalação e Obra", "texto": "Facilidade de aplicação e proteção das bordas dos revestimentos com precisão."},
                {"tipo": "cta", "titulo": "Catálogo Completo", "texto": "Acesse norvia.example e conheça nossa linha completa de acabamentos técnicos."},
            ],
            "legenda_instagram": f"{produto['nome']}\n\nSolução de alto padrão para detalhamento arquitetônico.\n\n#Norvia #Arquitetura",
            "_provedor": "Mock Validado Arch Journal",
        }

    fonte_nome = artigo.get("fonte_nome") or "Radar Norvia" if artigo else "Catálogo Oficial Norvia"
    titulo_orig = artigo.get("titulo") or "Solução Técnica de Acabamento" if artigo else ""
    link_orig = artigo.get("link") or "https://www.norvia.example" if artigo else ""

    prompt_sistema = f"""Você é o Redator Editorial Sênior da Norvia Acabamentos.
Redija a edição #{numero_edicao:02d} ({dia_publicacao}) no padrão "Arch Journal" da Norvia.

{_resumo_factual_catalogo()}

PRODUTO EM DESTAQUE NA EDIÇÃO (CARD 01):
- Nome: {produto['nome']} (Ref: {produto.get('referencia')}) | Slug: '{slug_produto}'
- Especificações: {produto.get('especificacoes_site')}
- Descrição Técnica do Catálogo: {(produto.get('descricao') or '')[:1200]}

LINHAS COMPLEMENTARES COM IMAGEM APROVADA (ESCOLHA DUAS PARA CARDS 02 E 03):
{chr(10).join(f"- Slug '{s}': {PRODUTOS_NORVIA[s]['nome_curto']} (Ref: {PRODUTOS_NORVIA[s].get('referencia')} | {PRODUTOS_NORVIA[s].get('categoria_tag')})" for s in outras_linhas)}

LIMITES DE CARACTERES: são MÁXIMOS RÍGIDOS, contados com espaços e aspas. Qualquer campo acima do limite faz a edição INTEIRA ser recusada. Mire em no máximo 85% de cada limite (ex.: frase do card com até 100 caracteres, texto de slide com até 200).

DIRETRIZES TÉCNICAS E ÉTICAS:
1. NUNCA afirme que o projeto da matéria usou produto Norvia.
2. É ESTRITAMENTE PROIBIDO citar qualquer escritório de arquitetura ou arquiteto que não esteja expressamente no texto recebido.
3. Todas as frases completas; NUNCA use reticências (...) ou (…) em NENHUM campo.
4. 'destaque_hero': escolha um termo de 2 a 4 palavras que apareça LITERALMENTE dentro do 'texto_hero' (ex: "minimalismo contínuo", "parede flutuante").
5. 'cards': exatamente 3 itens:
   - card 1 com produto_slug '{slug_produto}';
   - cards 2 e 3 com duas linhas DIFERENTES de '{slug_produto}' selecionadas da lista de linhas complementares acima.
   - 'frase' deve vir entre aspas (máx 120 chars; escreva até 100);
   - 'etiqueta_tecnica' extraída dos fatos reais do catálogo (máx 30 chars).
6. Carrossel: 6 a 8 slides contando a mesma história (1º slide capa, último cta, pelo menos um produto).

FORMATO DE RESPOSTA (JSON ESTRITO):
{{
  "assunto": "Assunto magnético até 70 caracteres",
  "assunto_alt": "Assunto alternativo para teste A/B",
  "preheader": "Frase de abertura até 120 caracteres",
  "selo_pauta": "PAUTA DA SEMANA • TENDÊNCIAS EM MAIÚSCULAS ATÉ 50 CHARS",
  "titulo_principal": "Manchete editorial em português até 110 caracteres",
  "texto_hero": "Texto de 2 a 3 frases até 380 caracteres contextualizando a arquitetura e a precisão do detalhe.",
  "destaque_hero": "termo literal que aparece dentro de texto_hero",
  "cta_hero_texto": "EXPLORAR A TENDÊNCIA NA PRÁTICA →",
  "cards": [
    {{
      "produto_slug": "{slug_produto}",
      "pasta_tema": "PASTA 01 // TEMA ATÉ 28 CHARS",
      "frase": "“Frase técnica explicativa entre aspas até 120 caracteres.”",
      "etiqueta_tecnica": "FATO REAL DO CATÁLOGO ATÉ 30C"
    }},
    {{
      "produto_slug": "uma das linhas complementares permitidas",
      "pasta_tema": "PASTA 02 // TEMA ATÉ 28 CHARS",
      "frase": "“Frase técnica explicativa entre aspas até 120 caracteres.”",
      "etiqueta_tecnica": "FATO REAL DO CATÁLOGO ATÉ 30C"
    }},
    {{
      "produto_slug": "outra das linhas complementares permitidas",
      "pasta_tema": "PASTA 03 // TEMA ATÉ 28 CHARS",
      "frase": "“Frase técnica explicativa entre aspas até 120 caracteres.”",
      "etiqueta_tecnica": "FATO REAL DO CATÁLOGO ATÉ 30C"
    }}
  ],
  "carrossel": [
    {{"tipo": "capa", "titulo": "Título da capa até 60 chars", "texto": "Texto complementar até 240 chars"}},
    {{"tipo": "texto", "titulo": "Desafio de Acabamento", "texto": "Explicação do desafio construtivo"}},
    {{"tipo": "texto", "titulo": "Alinhamento e Detalhe", "texto": "A importância da precisão no encontro dos materiais"}},
    {{"tipo": "produto", "titulo": "{produto['nome_curto']}", "texto": "Especificações técnicas reais do catálogo"}},
    {{"tipo": "texto", "titulo": "Durabilidade e Obra", "texto": "Benefícios práticos de instalação"}},
    {{"tipo": "cta", "titulo": "Acesse norvia.example", "texto": "Consulte o catálogo técnico e solicite cotação"}}
  ],
  "legenda_instagram": "Legenda completa para post no feed com créditos e hashtags até 1500 chars"
}}"""

    prompt_usuario = (
        f"Edição #{numero_edicao:02d} ({dia_publicacao})\n"
        f"Pauta: {'Guia Técnico' if not tem_materia else triagem.get('titulo_traduzido_ptbr')}\n"
        f"Fonte da Matéria: {fonte_nome}\n"
        f"Título Original: {titulo_orig}\n"
        f"Link: {link_orig}\n"
        f"Resumo da Matéria:\n{triagem.get('resumo_executivo')}\n"
        f"Ângulo de Conexão Norvia: {triagem.get('angulo_conexao_norvia')}\n"
        f"Produto: {produto['nome']} ({produto.get('referencia')})"
    )

    provedores = [
        ("Anthropic", _chamar_anthropic_json),
        ("OpenAI", _chamar_openai_json),
        ("Groq", _chamar_groq_json),
        ("Gemini", _chamar_gemini_json),
    ]

    validador = lambda dados_copy: validar_copy_edicao(
        dados_copy,
        produto,
        tem_materia=tem_materia,
        titulo_original_materia=artigo.get("titulo") if artigo else None,
    )
    return _executar_com_provedores(prompt_sistema, prompt_usuario, provedores, validador_fn=validador)
