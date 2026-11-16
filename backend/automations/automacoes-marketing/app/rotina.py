"""
Orquestração editorial do e-mail marketing da Norvia.

Na sexta (agendada às HORA_GERACAO_SEXTA, ou pelo botão do painel) gera as 2 edições da semana
seguinte: segunda e quinta. A geração roda em segundo plano: o painel recebe 202 e acompanha por /status.

Regras invioláveis:
- Rascunho já APROVADO não é sobrescrito e não troca de produto.
- O número da edição é sequencial (estado.json) e se mantém quando a mesma semana é gerada de novo.
- Sem rascunhos, a lista vem vazia (nada de edição de exemplo em produção).
- Troca de produto refaz a edição completa (triagem, copy, carrossel e HTML) em segundo plano (202/409/400).
- Após redação, gera os slides do carrossel via Pillow.
"""
from __future__ import annotations

import logging
import threading
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from app import config
from app.ai.finops_router import (
    gerar_copy_edicao_norvia,
    selecionar_melhores_pautas_da_semana,
    triar_e_conectar_produto_norvia,
)
from app.ambientes.gerenciador import registrar_hero_usado
from app.collectors.rss_collector import coletar_todas_noticias, extrair_texto_limpo_artigo
from app.config import FUSO_SP, PRODUTOS_NORVIA, settings
from app.historico import alterar_estado, gravar_json, ler_estado, ler_json, registrar_execucao
from app.instagram.carrossel import gerar_slides_carrossel
from app.templates.email_builder import renderizar_email_marketing

logger = logging.getLogger("marketing.rotina")

_geracao_lock = threading.Lock()
_geracao: Dict[str, Any] = {"em_andamento": False, "iniciada_em": None, "iniciada_por": None, "ultimo_erro": None}
_rascunhos_lock = threading.Lock()


def agora() -> datetime:
    return datetime.now(FUSO_SP)


def listar_catalogo_oficial(apenas_marca_propria: bool = True) -> List[Dict[str, Any]]:
    """Produtos do catálogo de norvia.example; por padrão só os da marca Norvia (sem revenda)."""
    prods = config.KB_NORVIA.get("produtos", [])
    if apenas_marca_propria:
        return [p for p in prods if p.get("marca_propria", False)]
    return list(prods)


def listar_rascunhos() -> List[Dict[str, Any]]:
    rascunhos = ler_json(config.CAMINHO_RASCUNHOS_JSON, [])
    return rascunhos if isinstance(rascunhos, list) else []


def _salvar_rascunhos(rascunhos: List[Dict[str, Any]]) -> None:
    gravar_json(config.CAMINHO_RASCUNHOS_JSON, rascunhos)


def proxima_segunda(hoje: date) -> date:
    dias = (0 - hoje.weekday() + 7) % 7 or 7
    return hoje + timedelta(days=dias)


def _selecionar_imagens_rascunho(slug: str, copy: Dict[str, Any]) -> Dict[str, Any]:
    """Escolhe e fixa os IDs de imagens aprovadas para hero, 3 cards e carrossel 4:5 (sem gravar estado)."""
    from app.ambientes.gerenciador import escolher_imagem_aprovada

    hero_reg = escolher_imagem_aprovada(slug)
    if not hero_reg:
        raise ValueError(f"Nenhuma imagem de ambiente aprovada para '{slug}'.")
    usados = {hero_reg["id"]}

    cards_ids: List[str] = []
    for card in copy.get("cards") or []:
        c_slug = card.get("produto_slug") or slug
        reg = escolher_imagem_aprovada(c_slug, evitar_ids=usados)
        if not reg:
            raise ValueError(f"Nenhuma imagem de ambiente aprovada para o card '{c_slug}'.")
        usados.add(reg["id"])
        cards_ids.append(reg["id"])

    carrossel_reg = escolher_imagem_aprovada(slug, evitar_ids={hero_reg["id"]}) or hero_reg
    return {
        "hero": hero_reg["id"],
        "cards": cards_ids,
        "carrossel": carrossel_reg["id"],
    }


def _renderizar(rascunho: Dict[str, Any], produto: Dict[str, Any]) -> None:
    copy = rascunho["copy"]
    copy["numero_edicao"] = rascunho["edicao_numero"]
    copy["data_prevista"] = rascunho.get("data_prevista") or ""
    copy["fonte_nome"] = rascunho.get("artigo_fonte") or "Radar Norvia"
    copy["fonte_link"] = rascunho.get("artigo_url") or ""
    copy["titulo_traduzido_ptbr"] = rascunho.get("titulo_traduzido_ptbr") or ""
    copy["pauta"] = rascunho.get("pauta") or "artigo_rss"
    imagens = rascunho.get("imagens")
    rascunho["html_email_preview"] = renderizar_email_marketing(copy, produto, usar_cdn_externa=False, imagens=imagens)
    rascunho["html_email_rd_station"] = renderizar_email_marketing(copy, produto, usar_cdn_externa=True, imagens=imagens)


def _gerar_carrossel_para_rascunho(rascunho: Dict[str, Any], produto: Dict[str, Any]) -> None:
    carrossel = rascunho.get("copy", {}).get("carrossel") or []
    if not carrossel:
        rascunho["carrossel_slides"] = 0
        rascunho["carrossel_erro"] = None
        return
    try:
        imagem_id = (rascunho.get("imagens") or {}).get("carrossel")
        gerados = gerar_slides_carrossel(rascunho["id"], carrossel, produto, imagem_id=imagem_id)
        rascunho["carrossel_slides"] = len(gerados)
        rascunho["carrossel_erro"] = None
    except Exception as exc:
        logger.warning("Falha ao gerar slides do carrossel para '%s': %s", rascunho["id"], exc)
        rascunho["carrossel_slides"] = 0
        rascunho["carrossel_erro"] = f"Falha na geração gráfica: {exc}"


def aprovar_rascunho(rascunho_id: str, aprovado_por: str) -> Optional[Dict[str, Any]]:
    with _rascunhos_lock:
        rascunhos = listar_rascunhos()
        encontrado = next((r for r in rascunhos if r.get("id") == rascunho_id), None)
        if encontrado is None:
            return None
        momento = agora().isoformat()
        encontrado.update(status="aprovado", aprovado_por=aprovado_por, aprovado_em=momento, atualizado_em=momento)
        _salvar_rascunhos(rascunhos)
    registrar_execucao(
        tipo="marketing_rascunho_aprovado",
        sucesso=True,
        detalhes={
            "rascunho_id": rascunho_id,
            "dia_semana": encontrado.get("dia_semana"),
            "produto": encontrado.get("produto_nome"),
            "aprovado_por": aprovado_por,
        },
    )
    return encontrado


def validar_troca_produto(rascunho_id: str, novo_produto_slug: str) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
    """Valida antes de disparar a thread (retorna 400 se inválido)."""
    if novo_produto_slug not in PRODUTOS_NORVIA:
        return False, f"Produto '{novo_produto_slug}' inválido.", None
    from app.ambientes.gerenciador import listar_produtos_elegiveis
    elegiveis = listar_produtos_elegiveis()
    if novo_produto_slug not in elegiveis:
        return False, f"Produto '{novo_produto_slug}' não possui imagem de ambiente aprovada.", None
    rascunhos = listar_rascunhos()
    encontrado = next((r for r in rascunhos if r.get("id") == rascunho_id), None)
    if encontrado is None:
        return False, f"Rascunho '{rascunho_id}' não encontrado.", None
    if encontrado.get("status") == "aprovado":
        return False, "Edição já aprovada não pode ter o produto alterado.", None
    return True, "", encontrado


def iniciar_troca_produto(rascunho_id: str, novo_produto_slug: str, usuario: str = "") -> Tuple[bool, str, int]:
    """Troca o produto e refaz triagem, copy, carrossel e HTML em segundo plano."""
    valido, erro_val, _ = validar_troca_produto(rascunho_id, novo_produto_slug)
    if not valido:
        return False, erro_val, 400

    with _geracao_lock:
        if _geracao["em_andamento"]:
            return False, "Já existe uma geração em andamento. Aguarde terminar.", 409
        _geracao.update(
            em_andamento=True,
            iniciada_em=agora().isoformat(),
            iniciada_por=usuario or "troca de produto",
            ultimo_erro=None,
        )

    def _executar_troca():
        from app import execucoes
        erro = None
        try:
            with execucoes.execucao(f"troca_produto {rascunho_id}"):
                try:
                    prod = PRODUTOS_NORVIA[novo_produto_slug]
                    rascunhos = listar_rascunhos()
                    r = next((item for item in rascunhos if item.get("id") == rascunho_id), None)
                    if not r or r.get("status") == "aprovado":
                        return

                    pauta = r.get("pauta") or "artigo_rss"
                    artigo = None
                    if pauta != "guia_tecnico" and r.get("artigo_titulo"):
                        artigo = {
                            "fonte_nome": r.get("artigo_fonte"),
                            "titulo": r.get("artigo_titulo"),
                            "link": r.get("artigo_url"),
                            "resumo_rss": r.get("artigo_resumo") or "",
                        }

                    texto_limpo = ""
                    if artigo and artigo.get("link"):
                        texto_limpo = extrair_texto_limpo_artigo(artigo["link"], fallback_resumo=artigo.get("resumo_rss") or "")[:3000]

                    triagem = triar_e_conectar_produto_norvia(
                        artigo,
                        texto_limpo=texto_limpo,
                        produto_preferencial=novo_produto_slug,
                        pauta=pauta,
                    )
                    copy = gerar_copy_edicao_norvia(
                        artigo,
                        triagem,
                        dia_publicacao=r.get("dia_semana", "Segunda-feira"),
                        numero_edicao=int(r.get("edicao_numero", 1)),
                        pauta=pauta,
                    )

                    with _rascunhos_lock:
                        rascunhos_atuais = listar_rascunhos()
                        r_atual = next((item for item in rascunhos_atuais if item.get("id") == rascunho_id), None)
                        if not r_atual:
                            return
                        if r_atual.get("status") == "aprovado":
                            registrar_execucao(
                                tipo="marketing_troca_descartada_ja_aprovado",
                                sucesso=True,
                                detalhes={
                                    "rascunho_id": rascunho_id,
                                    "motivo": "Edição foi aprovada durante a geração da troca de produto; alteração descartada.",
                                },
                            )
                            return

                        imagens = _selecionar_imagens_rascunho(novo_produto_slug, copy)
                        momento = agora().isoformat()
                        r_atual.update(
                            produto_slug=novo_produto_slug,
                            produto_nome=prod["nome"],
                            produto_referencia=prod.get("referencia"),
                            marca="Norvia",
                            titulo_traduzido_ptbr=triagem.get("titulo_traduzido_ptbr"),
                            copy=copy,
                            imagens=imagens,
                            atualizado_em=momento,
                        )
                        _renderizar(r_atual, prod)
                        _gerar_carrossel_para_rascunho(r_atual, prod)
                        _salvar_rascunhos(rascunhos_atuais)
                        if imagens.get("hero"):
                            registrar_hero_usado(novo_produto_slug, imagens["hero"])

                    registrar_execucao(
                        tipo="marketing_produto_alterado",
                        sucesso=True,
                        detalhes={
                            "rascunho_id": rascunho_id,
                            "novo_produto_slug": novo_produto_slug,
                            "produto_nome": prod["nome"],
                            "alterado_por": usuario,
                        },
                    )
                except Exception as exc:
                    erro = str(exc) or exc.__class__.__name__
                    logger.error(f"[MARKETING] Falha ao trocar produto do rascunho '{rascunho_id}': {exc}", exc_info=True)
                    registrar_execucao(
                        tipo="marketing_produto_alterado",
                        sucesso=False,
                        detalhes={"rascunho_id": rascunho_id, "erro": erro, "alterado_por": usuario},
                    )
        finally:
            with _geracao_lock:
                _geracao.update(em_andamento=False, ultimo_erro=erro)

    threading.Thread(target=_executar_troca, name=f"troca-prod-{rascunho_id}", daemon=True).start()
    return True, "Edição em atualização em segundo plano.", 202


def _montar_edicao(
    artigo: Optional[Dict[str, Any]],
    slug: str,
    dia_semana: str,
    data_prevista: date,
    numero: int,
    sufixo: str,
    pauta: str = "artigo_rss",
) -> Dict[str, Any]:
    texto_limpo = ""
    if artigo and artigo.get("link"):
        texto_limpo = extrair_texto_limpo_artigo(artigo["link"], fallback_resumo=artigo.get("resumo_rss") or "")[:3000]
    triagem = triar_e_conectar_produto_norvia(artigo, texto_limpo=texto_limpo, produto_preferencial=slug, pauta=pauta)
    copy = gerar_copy_edicao_norvia(artigo, triagem, dia_semana, numero, pauta=pauta)
    imagens = _selecionar_imagens_rascunho(slug, copy)
    produto = PRODUTOS_NORVIA[slug]
    momento = agora().isoformat()
    rascunho = {
        "id": f"draft-{sufixo}-{data_prevista:%Y%m%d}",
        "dia_semana": dia_semana,
        "data_prevista": data_prevista.isoformat(),
        "edicao_numero": numero,
        "status": "pendente_aprovacao",
        "aprovado_por": None,
        "aprovado_em": None,
        "produto_slug": slug,
        "produto_nome": produto["nome"],
        "produto_referencia": produto.get("referencia"),
        "marca": "Norvia",
        "pauta": pauta,
        "artigo_fonte": artigo.get("fonte_nome") if artigo else None,
        "artigo_titulo": artigo.get("titulo") if artigo else None,
        "titulo_traduzido_ptbr": triagem.get("titulo_traduzido_ptbr"),
        "artigo_url": artigo.get("link") if artigo else None,
        "artigo_resumo": artigo.get("resumo_rss") if artigo else None,
        "copy": copy,
        "imagens": imagens,
        "carrossel_slides": 0,
        "carrossel_erro": None,
        "criado_em": momento,
        "atualizado_em": momento,
    }
    _renderizar(rascunho, produto)
    _gerar_carrossel_para_rascunho(rascunho, produto)
    return rascunho


def _numeros_das_edicoes(ids: Tuple[str, str], existentes: Dict[str, Dict[str, Any]]) -> Tuple[int, int]:
    proximo = int(ler_estado().get("proxima_edicao") or 1)
    numeros = []
    for rid in ids:
        if rid in existentes and existentes[rid].get("edicao_numero"):
            numeros.append(int(existentes[rid]["edicao_numero"]))
        else:
            numeros.append(proximo)
            proximo += 1
    alterar_estado(proxima_edicao=max([proximo, *[n + 1 for n in numeros]]))
    return numeros[0], numeros[1]


def gerar_lote_semanal(usuario: str = "rotina de sexta") -> Dict[str, Any]:
    """Gera as edições de segunda e quinta da próxima semana."""
    inicio = agora()
    segunda = proxima_segunda(inicio.date())
    quinta = segunda + timedelta(days=3)
    ids = (f"draft-seg-{segunda:%Y%m%d}", f"draft-qui-{quinta:%Y%m%d}")
    existentes = {r.get("id"): r for r in listar_rascunhos()}
    try:
        aprovados = {rid for rid in ids if existentes.get(rid, {}).get("status") == "aprovado"}
        if len(aprovados) == 2:
            return {
                "status": "sem_alteracao",
                "mensagem": "As duas edições da semana já estão aprovadas.",
                "rascunhos": [existentes[i] for i in ids],
            }
        num_seg, num_qui = _numeros_das_edicoes(ids, existentes)
        artigos = coletar_todas_noticias(limite_por_fonte=12)
        if not artigos or (len(artigos) < 2 and not settings.MOCK_MODE):
            raise RuntimeError(
                f"Os feeds de arquitetura trouxeram {len(artigos)} matéria(s) aproveitável(is); são precisas no mínimo 2. "
                "Tente de novo mais tarde."
            )

        ((art_seg, slug_seg, pauta_seg), (art_qui, slug_qui, pauta_qui)) = selecionar_melhores_pautas_da_semana(artigos)

        novos = []
        for rid, artigo, slug, dia, data_prev, numero, sufixo, pauta in (
            (ids[0], art_seg, slug_seg, "Segunda-feira", segunda, num_seg, "seg", pauta_seg),
            (ids[1], art_qui, slug_qui, "Quinta-feira", quinta, num_qui, "qui", pauta_qui),
        ):
            if rid in aprovados:
                novos.append(existentes[rid])
            else:
                novos.append(_montar_edicao(artigo, slug, dia, data_prev, numero, sufixo, pauta=pauta))

        with _rascunhos_lock:
            disco = {r["id"]: r for r in listar_rascunhos()}
            final = []
            for r in novos:
                rid = r["id"]
                if disco.get(rid, {}).get("status") == "aprovado":
                    if rid not in aprovados:
                        registrar_execucao(
                            tipo="marketing_lote_descartado_ja_aprovado",
                            sucesso=True,
                            detalhes={
                                "rascunho_id": rid,
                                "motivo": "Edição foi aprovada durante a geração do lote; rascunho novo descartado.",
                            },
                        )
                    final.append(disco[rid])
                else:
                    final.append(r)
            for rid, r in disco.items():
                if rid not in ids and rid not in [x["id"] for x in final]:
                    final.append(r)
            _salvar_rascunhos(final)
            for r in novos:
                rid = r["id"]
                if disco.get(rid, {}).get("status") != "aprovado":
                    hero_id = (r.get("imagens") or {}).get("hero")
                    if hero_id:
                        registrar_hero_usado(r["produto_slug"], hero_id)

        duracao_ms = int((agora() - inicio).total_seconds() * 1000)
        registrar_execucao(
            tipo="marketing_lote_semanal_gerado",
            sucesso=True,
            detalhes={
                "gerado_por": usuario,
                "edicoes_geradas": 2 - len(aprovados),
                "aprovadas_mantidas": len(aprovados),
                "segunda_produto": novos[0].get("produto_nome"),
                "quinta_produto": novos[1].get("produto_nome"),
                "duracao_ms": duracao_ms,
            },
        )
        return {
            "status": "sucesso",
            "mensagem": "Edições de segunda e quinta geradas.",
            "rascunhos": final,
            "duracao_ms": duracao_ms,
        }
    except Exception as exc:
        duracao_ms = int((agora() - inicio).total_seconds() * 1000)
        registrar_execucao(
            tipo="marketing_lote_semanal_gerado",
            sucesso=False,
            detalhes={"gerado_por": usuario, "erro": str(exc), "duracao_ms": duracao_ms},
        )
        raise


def estado_geracao() -> Dict[str, Any]:
    with _geracao_lock:
        return dict(_geracao)


def _executar_em_segundo_plano(usuario: str) -> None:
    from app import execucoes

    erro = None
    try:
        with execucoes.execucao("rotina MARKETING_LOTE_SEMANAL"):
            try:
                gerar_lote_semanal(usuario=usuario)
            except Exception as exc:
                erro = str(exc) or exc.__class__.__name__
                logger.error(f"[MARKETING] Falha na geração do lote semanal: {exc}", exc_info=True)
    finally:
        with _geracao_lock:
            _geracao.update(em_andamento=False, ultimo_erro=erro)


def iniciar_geracao(usuario: str) -> bool:
    with _geracao_lock:
        if _geracao["em_andamento"]:
            return False
        _geracao.update(em_andamento=True, iniciada_em=agora().isoformat(), iniciada_por=usuario, ultimo_erro=None)
    threading.Thread(target=_executar_em_segundo_plano, args=(usuario,), name="marketing-lote", daemon=True).start()
    return True


def proxima_geracao_agendada(momento: Optional[datetime] = None) -> Optional[datetime]:
    if not settings.GERAR_SEXTA_AUTOMATICO:
        return None
    momento = momento or agora()
    alvo = momento.replace(hour=settings.HORA_GERACAO_SEXTA, minute=0, second=0, microsecond=0)
    alvo += timedelta(days=(4 - momento.weekday()) % 7)
    if alvo <= momento:
        alvo += timedelta(days=7)
    return alvo


def obter_status_automacao() -> Dict[str, Any]:
    from app.ambientes.gerenciador import contar_geracoes_hoje, estado_geracao_imagens

    rascunhos = listar_rascunhos()
    proxima = proxima_geracao_agendada()
    ia = [
        nome for nome, chave in (
            ("Groq", settings.GROQ_API_KEY),
            ("Gemini", settings.GEMINI_API_KEY),
            ("Anthropic", settings.ANTHROPIC_API_KEY),
            ("OpenAI", settings.OPENAI_API_KEY),
        ) if chave
    ]
    return {
        "status": "operacional",
        "servico": "automacoes-marketing",
        "total_rascunhos_semana": len(rascunhos),
        "aprovados": sum(1 for r in rascunhos if r.get("status") == "aprovado"),
        "pendentes": sum(1 for r in rascunhos if r.get("status") == "pendente_aprovacao"),
        "proxima_geracao_sexta": proxima.strftime("%d/%m/%Y às %H:%M") if proxima else None,
        "total_produtos_catalogo": len(config.KB_NORVIA.get("produtos", [])),
        "total_produtos_marca_propria": len(listar_catalogo_oficial(True)),
        "marca_oficial_ativa": "Norvia",
        "mock_mode": settings.MOCK_MODE,
        "ia_configurada": ia,
        "geracao": estado_geracao(),
        "geracao_imagens": estado_geracao_imagens(),
        "imagens_geradas_hoje": contar_geracoes_hoje(),
        "imagens_limite_dia": settings.MARKETING_IMAGENS_LIMITE_DIA,
        "provedor_imagem": settings.MARKETING_IMAGEM_PROVEDOR,
    }
