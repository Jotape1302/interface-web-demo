"""
Gerenciador do Banco de Ambientes Norvia:
- Estoque inicial a partir de referencias/estoque_inicial/ (e marca/ em PUBLICO_DIR)
- Geração assíncrona de opções em 3:2 e 4:5 via provedores reais ou mock
- Aprovação e recusa com auditoria e publicação segura (0755/0644) em PUBLICO_DIR
- Controle de elegibilidade e rodízio por linha em estado.json
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from app.ambientes.provedores import (
    gerar_composicao_ambiente,
    processar_e_recortar_jpeg,
    validar_provedor_configurado,
)
from app.config import (
    CAMINHO_INDICE_AMBIENTES,
    FUSO_SP,
    PASTA_AMBIENTES_DATA,
    PASTA_AMBIENTES_PUBLICO,
    PASTA_MARCA_PUBLICO,
    PASTA_REFERENCIAS,
    PRODUTOS_NORVIA,
    settings,
)
from app.historico import alterar_estado, ler_estado

logger = logging.getLogger("marketing.ambientes")

_ambientes_lock = threading.Lock()
_geracao_img_lock = threading.Lock()
_geracao_img_estado: Dict[str, Any] = {
    "em_andamento": False,
    "iniciada_em": None,
    "ultimo_erro": None,
}

REGRAS_APLICACAO_LINHA: Dict[str, str] = {
    "rodape_invertido": "Na base da parede, recuado, com luz indireta de LED integrada à alvenaria, criando efeito de parede suspensa.",
    "rodape_invertido_aquila": "Na base da parede, recuado com iluminação linear em LED integrada para efeito de parede flutuante.",
    "rodape_orion_led": "Rodapé com canaleta oculta para fita de LED e iluminação suave de piso em ambiente residencial contemporâneo.",
    "perfil_t": "Na junta de dilatação e transição suave entre dois revestimentos de piso NO MESMO NÍVEL (ex: porcelanato e madeira). NUNCA associar a vidro, esquadrias ou paredes!",
    "redutor_piso": "Perfil redutor na transição suave entre pisos em ALTURAS DIFERENTES (desníveis entre revestimentos).",
    "cantoneira": "Proteção e arremate técnico de quinas vivas de paredes ou no bocel de degraus de escada.",
    "listelo_velino": "Faixa metálica linear decorativa embutida entre placas de porcelanato, painéis de madeira ripada ou marcenaria.",
    "perfil_led_embutir": "Linha contínua de luz difusa embutida no forro de gesso, na parede de alvenaria ou em painéis de madeira.",
}


def _agora() -> datetime:
    return datetime.now(FUSO_SP)


def estado_geracao_imagens() -> Dict[str, Any]:
    with _geracao_img_lock:
        return dict(_geracao_img_estado)


def _ler_indice() -> List[Dict[str, Any]]:
    if not CAMINHO_INDICE_AMBIENTES.exists():
        return []
    try:
        dados = json.loads(CAMINHO_INDICE_AMBIENTES.read_text(encoding="utf-8"))
        return dados if isinstance(dados, list) else []
    except Exception as exc:
        logger.warning("Erro ao ler índice de ambientes: %s", exc)
        return []


def _gravar_indice(dados: List[Dict[str, Any]]) -> None:
    PASTA_AMBIENTES_DATA.mkdir(parents=True, exist_ok=True)
    tmp = CAMINHO_INDICE_AMBIENTES.with_suffix(".tmp")
    tmp.write_text(json.dumps(dados, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, CAMINHO_INDICE_AMBIENTES)


def _publicar_marca() -> None:
    """Copia logo-norvia.png e logo-norvia-negativo.png de referencias/marca/ para PUBLICO_DIR/marca/."""
    origem_marca = PASTA_REFERENCIAS / "marca"
    if not origem_marca.exists():
        return
    PASTA_MARCA_PUBLICO.mkdir(parents=True, exist_ok=True)
    os.chmod(PASTA_MARCA_PUBLICO, 0o755)
    for nome in ("logo-norvia.png", "logo-norvia-negativo.png"):
        src = origem_marca / nome
        dst = PASTA_MARCA_PUBLICO / nome
        if src.exists() and (not dst.exists() or src.read_bytes() != dst.read_bytes()):
            shutil.copy2(src, dst)
            os.chmod(dst, 0o644)


def inicializar_estoque_inicial() -> None:
    """
    Copia as imagens aprovadas iniciais de referencias/estoque_inicial/ para DATA_DIR e PUBLICO_DIR
    e publica as logos em PUBLICO_DIR/marca/. Idempotente: não reescreve arquivos nem registros existentes.
    """
    _publicar_marca()

    pasta_estoque = PASTA_REFERENCIAS / "estoque_inicial"
    caminho_indice_ref = pasta_estoque / "indice.json"
    if not caminho_indice_ref.exists():
        logger.warning("Estoque inicial não encontrado em %s", caminho_indice_ref)
        return

    try:
        registros_ref = json.loads(caminho_indice_ref.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.error("Falha ao ler indice.json do estoque inicial: %s", exc)
        return

    with _ambientes_lock:
        PASTA_AMBIENTES_DATA.mkdir(parents=True, exist_ok=True)
        PASTA_AMBIENTES_PUBLICO.mkdir(parents=True, exist_ok=True)
        os.chmod(PASTA_AMBIENTES_PUBLICO, 0o755)

        indice = _ler_indice()
        ids_existentes = {item.get("id") for item in indice}
        alterado = False

        for reg in registros_ref:
            img_id = reg.get("id")
            slug = reg.get("produto_slug") or "geral"
            if not img_id:
                continue

            src_jpg = pasta_estoque / f"{img_id}.jpg"
            if not src_jpg.exists():
                continue

            # Copia para pasta privada DATA_DIR/ambientes/ se não existir
            dst_priv = PASTA_AMBIENTES_DATA / f"{img_id}.jpg"
            if not dst_priv.exists():
                shutil.copy2(src_jpg, dst_priv)
                os.chmod(dst_priv, 0o644)

            # Copia para pasta pública PUBLICO_DIR/ambientes/<slug>/ se não existir
            pasta_pub_slug = PASTA_AMBIENTES_PUBLICO / slug
            pasta_pub_slug.mkdir(parents=True, exist_ok=True)
            os.chmod(pasta_pub_slug, 0o755)
            dst_pub = pasta_pub_slug / f"{img_id}.jpg"
            if not dst_pub.exists():
                shutil.copy2(src_jpg, dst_pub)
                os.chmod(dst_pub, 0o644)

            # Garante também a versão 4:5 para carrossel do Instagram
            dst_priv_4x5 = PASTA_AMBIENTES_DATA / f"{img_id}_4x5.jpg"
            dst_pub_4x5 = pasta_pub_slug / f"{img_id}_4x5.jpg"
            if not dst_priv_4x5.exists():
                src_4x5 = pasta_estoque / f"{img_id}_4x5.jpg"
                if src_4x5.exists():
                    shutil.copy2(src_4x5, dst_priv_4x5)
                else:
                    bytes_4x5, _, _ = processar_e_recortar_jpeg(src_jpg.read_bytes(), proporcao="4:5")
                    dst_priv_4x5.write_bytes(bytes_4x5)
                os.chmod(dst_priv_4x5, 0o644)
            if not dst_pub_4x5.exists() and dst_priv_4x5.exists():
                shutil.copy2(dst_priv_4x5, dst_pub_4x5)
                os.chmod(dst_pub_4x5, 0o644)

            if img_id not in ids_existentes:
                novo_reg = dict(reg)
                novo_reg.setdefault("arquivo_3x2", f"{img_id}.jpg")
                novo_reg.setdefault("arquivo_4x5", f"{img_id}_4x5.jpg")
                novo_reg["url_publica"] = f"{settings.MARKETING_URL_PUBLICA_IMAGENS}/ambientes/{slug}/{img_id}.jpg"
                indice.append(novo_reg)
                ids_existentes.add(img_id)
                alterado = True

        if alterado:
            _gravar_indice(indice)


def listar_ambientes(filtro_slug: Optional[str] = None) -> List[Dict[str, Any]]:
    """Lista todas as imagens de ambientes (aprovadas, candidatas, recusadas)."""
    with _ambientes_lock:
        indice = _ler_indice()
    if filtro_slug:
        indice = [item for item in indice if item.get("produto_slug") == filtro_slug]
    return sorted(indice, key=lambda x: x.get("gerada_em", ""), reverse=True)


def obter_caminho_imagem(imagem_id: str) -> Optional[Path]:
    """Localiza o arquivo JPEG da imagem para prévia segura pelo gateway."""
    if not imagem_id or not all(c.isalnum() or c in "-_" for c in imagem_id):
        return None
    caminho_priv = PASTA_AMBIENTES_DATA / f"{imagem_id}.jpg"
    if caminho_priv.exists():
        return caminho_priv
    with _ambientes_lock:
        indice = _ler_indice()
    base_id = imagem_id[:-4] if imagem_id.endswith("_4x5") else imagem_id
    for item in indice:
        if item.get("id") == base_id:
            slug = item.get("produto_slug") or ""
            caminho_pub = PASTA_AMBIENTES_PUBLICO / slug / f"{imagem_id}.jpg"
            if caminho_pub.exists():
                return caminho_pub
    return None


def obter_registro_imagem(imagem_id: str) -> Optional[Dict[str, Any]]:
    with _ambientes_lock:
        indice = _ler_indice()
    return next((item for item in indice if item.get("id") == imagem_id), None)


def aprovar_ambiente(imagem_id: str, usuario: str) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
    """Aprova uma imagem candidata e copia seus arquivos (3:2 e 4:5) para PUBLICO_DIR com permissão 0644."""
    with _ambientes_lock:
        indice = _ler_indice()
        encontrado = next((item for item in indice if item.get("id") == imagem_id), None)
        if not encontrado:
            return False, f"Imagem '{imagem_id}' não encontrada.", None

        slug = encontrado.get("produto_slug") or "geral"
        caminho_origem = PASTA_AMBIENTES_DATA / f"{imagem_id}.jpg"
        if not caminho_origem.exists():
            return False, f"Arquivo da imagem '{imagem_id}' não existe no disco.", None

        pasta_pub_slug = PASTA_AMBIENTES_PUBLICO / slug
        pasta_pub_slug.mkdir(parents=True, exist_ok=True)
        os.chmod(pasta_pub_slug, 0o755)

        caminho_pub = pasta_pub_slug / f"{imagem_id}.jpg"
        shutil.copy2(caminho_origem, caminho_pub)
        os.chmod(caminho_pub, 0o644)

        # Copia também a versão 4:5 se existir
        caminho_4x5_orig = PASTA_AMBIENTES_DATA / f"{imagem_id}_4x5.jpg"
        if caminho_4x5_orig.exists():
            caminho_4x5_pub = pasta_pub_slug / f"{imagem_id}_4x5.jpg"
            shutil.copy2(caminho_4x5_orig, caminho_4x5_pub)
            os.chmod(caminho_4x5_pub, 0o644)

        momento = _agora().isoformat()
        encontrado["status"] = "aprovada"
        encontrado["aprovada_por"] = usuario
        encontrado["aprovada_em"] = momento
        encontrado["url_publica"] = f"{settings.MARKETING_URL_PUBLICA_IMAGENS}/ambientes/{slug}/{imagem_id}.jpg"

        _gravar_indice(indice)

    return True, "Imagem aprovada com sucesso.", encontrado


def recusar_ambiente(imagem_id: str, usuario: str) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
    """Marca uma imagem como recusada e remove de PUBLICO_DIR caso estivesse publicada."""
    with _ambientes_lock:
        indice = _ler_indice()
        encontrado = next((item for item in indice if item.get("id") == imagem_id), None)
        if not encontrado:
            return False, f"Imagem '{imagem_id}' não encontrada.", None

        slug = encontrado.get("produto_slug") or "geral"
        for sufixo in (".jpg", "_4x5.jpg"):
            caminho_pub = PASTA_AMBIENTES_PUBLICO / slug / f"{imagem_id}{sufixo}"
            if caminho_pub.exists():
                caminho_pub.unlink()

        encontrado["status"] = "recusada"
        encontrado["recusada_por"] = usuario
        encontrado["recusada_em"] = _agora().isoformat()
        encontrado["url_publica"] = ""

        _gravar_indice(indice)

    return True, "Imagem recusada.", encontrado


def contar_geracoes_hoje() -> int:
    """Conta quantas opções de imagem foram geradas hoje (excluindo o estoque inicial)."""
    hoje = _agora().strftime("%Y-%m-%d")
    with _ambientes_lock:
        indice = _ler_indice()
    return sum(
        1
        for item in indice
        if str(item.get("gerada_em", "")).startswith(hoje)
        and item.get("provedor") != "modelo_aprovado"
    )


def listar_produtos_elegiveis() -> List[str]:
    """Retorna os slugs de produtos da marca Norvia que possuem AO MENOS UMA imagem aprovada."""
    with _ambientes_lock:
        indice = _ler_indice()
    aprovados = {
        item.get("produto_slug")
        for item in indice
        if item.get("status") == "aprovada" and item.get("produto_slug")
    }
    return [slug for slug in PRODUTOS_NORVIA if slug in aprovados]


def escolher_imagem_aprovada(
    slug: str,
    evitar_ids: Optional[Set[str]] = None,
) -> Optional[Dict[str, Any]]:
    """
    Escolhe uma imagem aprovada para a linha sem gravar estado.
    - Sem evitar_ids (uso do hero): aplica rodízio circular em cima de ultimo_hero_por_linha
      em ordem estável (aprovada_em, id).
    - Com evitar_ids (cards e carrossel): prefere uma foto que não esteja em evitar_ids.
    """
    with _ambientes_lock:
        indice = _ler_indice()

    aprovadas = [
        item
        for item in indice
        if item.get("produto_slug") == slug and item.get("status") == "aprovada"
    ]
    if not aprovadas:
        return None

    aprovadas.sort(key=lambda x: (x.get("aprovada_em") or "", x.get("id") or ""))

    if evitar_ids is not None:
        sem_evitadas = [a for a in aprovadas if a.get("id") not in evitar_ids]
        return sem_evitadas[0] if sem_evitadas else aprovadas[0]

    estado = ler_estado()
    ultimos = estado.get("ultimo_hero_por_linha") or {}
    ultimo_id = ultimos.get(slug)
    if ultimo_id:
        ids = [a.get("id") for a in aprovadas]
        if ultimo_id in ids:
            idx = ids.index(ultimo_id)
            return aprovadas[(idx + 1) % len(aprovadas)]

    return aprovadas[0]


def registrar_hero_usado(slug: str, img_id: str) -> None:
    """Grava o último hero efetivamente salvo em rascunho para o rodízio circular."""
    estado = ler_estado()
    ultimos = dict(estado.get("ultimo_hero_por_linha") or {})
    ultimos[slug] = img_id
    alterar_estado(ultimo_hero_por_linha=ultimos)


def iniciar_geracao_ambientes(produto_slug: str, usuario: str = "", quantidade: int = 4) -> Tuple[bool, str, int]:
    """Dispara geração de opções de imagens de ambiente em segundo plano (202)."""
    if produto_slug not in PRODUTOS_NORVIA:
        return False, f"Linha de produto '{produto_slug}' inválida.", 400

    ok_prov, msg_prov = validar_provedor_configurado()
    if not ok_prov:
        return False, msg_prov, 400

    limite = settings.MARKETING_IMAGENS_LIMITE_DIA
    with _geracao_img_lock:
        if _geracao_img_estado["em_andamento"]:
            return False, "Já existe uma geração de imagens em andamento.", 409

        hoje_qtd = contar_geracoes_hoje()
        if hoje_qtd + quantidade > limite:
            return (
                False,
                f"Limite diário de {limite} imagens atingido ({hoje_qtd}/{limite} geradas hoje).",
                429,
            )

        _geracao_img_estado.update(
            em_andamento=True,
            iniciada_em=_agora().isoformat(),
            ultimo_erro=None,
        )

    def _executar_geracao():
        erro = None
        try:
            _executar_geracao_tarefa(produto_slug, usuario, quantidade)
        except Exception as exc:
            erro = str(exc) or exc.__class__.__name__
            logger.error("[MARKETING] Falha na geração de imagens para '%s': %s", produto_slug, exc, exc_info=True)
        finally:
            with _geracao_img_lock:
                _geracao_img_estado.update(em_andamento=False, ultimo_erro=erro)

    threading.Thread(target=_executar_geracao, name=f"gerar-amb-{produto_slug}", daemon=True).start()
    return True, f"Geração de {quantidade} opções de ambiente iniciada para {PRODUTOS_NORVIA[produto_slug]['nome_curto']}.", 202


def _construir_prompt_ambiente(produto_slug: str) -> str:
    prod = PRODUTOS_NORVIA[produto_slug]
    regra_aplicacao = REGRAS_APLICACAO_LINHA.get(produto_slug, prod.get("descricao_curta") or "")
    return (
        f"Fotografia de interior residencial brasileiro de alto padrão, fotorrealista, luz natural, "
        f"paleta neutra, enquadramento editorial, sem distorção, aplicando o produto Norvia '{prod['nome']}'. "
        f"Regra de aplicação arquitetônica: {regra_aplicacao} "
        "O perfil deve ter exatamente a forma, a aba, o encaixe e a cor do render de referência. "
        "PROIBIDO: texto, logotipo, marca d'água, pessoas, mudar forma ou cor do perfil, produto de outra categoria no lugar."
    )


def _executar_geracao_tarefa(produto_slug: str, usuario: str, quantidade: int) -> None:
    prod = PRODUTOS_NORVIA[produto_slug]
    prompt = _construir_prompt_ambiente(produto_slug)
    prompt_4x5 = (
        "Recomponha esta mesma cena no formato vertical 4:5, mantendo o ambiente, "
        "a luz e o perfil exatamente como estão; não acrescente nem remova elementos. "
        "PROIBIDO: texto, logotipo, marca d'água, pessoas, mudar forma ou cor do perfil, produto de outra categoria no lugar."
    )
    PASTA_AMBIENTES_DATA.mkdir(parents=True, exist_ok=True)

    provedor_usado = "mock" if settings.MOCK_MODE else settings.MARKETING_IMAGEM_PROVEDOR
    modelo_usado = (
        "mock"
        if settings.MOCK_MODE
        else (settings.GEMINI_IMAGE_MODEL if provedor_usado == "gemini" else settings.OPENAI_IMAGE_MODEL)
    )

    salvas = 0
    for i in range(quantidade):
        agora_dt = _agora()
        img_id = f"cand-{produto_slug}-{agora_dt.strftime('%Y%m%d%H%M%S%f')}-{i+1}"
        caminho_3x2 = PASTA_AMBIENTES_DATA / f"{img_id}.jpg"
        caminho_4x5 = PASTA_AMBIENTES_DATA / f"{img_id}_4x5.jpg"

        try:
            raw_3x2, refs_usadas = gerar_composicao_ambiente(produto_slug, prompt, aspect_ratio="3:2")
            jpeg_3x2, w_3x2, h_3x2 = processar_e_recortar_jpeg(raw_3x2, "3:2")

            formato_4x5 = "gerado"
            try:
                if provedor_usado in ("gemini", "mock"):
                    raw_4x5, _ = gerar_composicao_ambiente(
                        produto_slug,
                        prompt_4x5,
                        aspect_ratio="4:5",
                        imagem_base_bytes=jpeg_3x2,
                    )
                    jpeg_4x5, w_4x5, h_4x5 = processar_e_recortar_jpeg(raw_4x5, "4:5")
                else:
                    formato_4x5 = "recorte"
                    jpeg_4x5, w_4x5, h_4x5 = processar_e_recortar_jpeg(raw_3x2, "4:5")
            except Exception as exc_4x5:
                logger.warning(
                    "Falha ao gerar versão 4:5 para '%s', usando recorte central da 3:2: %s",
                    produto_slug,
                    exc_4x5,
                )
                formato_4x5 = "recorte"
                jpeg_4x5, w_4x5, h_4x5 = processar_e_recortar_jpeg(raw_3x2, "4:5")

            caminho_3x2.write_bytes(jpeg_3x2)
            os.chmod(caminho_3x2, 0o644)

            caminho_4x5.write_bytes(jpeg_4x5)
            os.chmod(caminho_4x5, 0o644)

            registro = {
                "id": img_id,
                "produto_slug": produto_slug,
                "linha": produto_slug,
                "status": "candidata",
                "aprovada_por": None,
                "aprovada_em": None,
                "gerada_em": agora_dt.isoformat(),
                "gerada_por": usuario or "solicitação no painel",
                "descricao": f"Opção gerada por IA para {prod['nome']}",
                "provedor": provedor_usado,
                "modelo": modelo_usado,
                "prompt": prompt,
                "referencias_usadas": refs_usadas,
                "arquivo_3x2": caminho_3x2.name,
                "arquivo_4x5": caminho_4x5.name,
                "formato_4x5": formato_4x5,
                "proporcao": "3:2",
                "largura": w_3x2,
                "altura": h_3x2,
                "largura_4x5": w_4x5,
                "altura_4x5": h_4x5,
                "tamanho_bytes": len(jpeg_3x2),
                "tamanho_bytes_4x5": len(jpeg_4x5),
                "url_publica": "",
                "url_preview": f"/api/marketing/ambientes/{img_id}.jpg",
            }
            with _ambientes_lock:
                indice = _ler_indice()
                indice.append(registro)
                _gravar_indice(indice)
            salvas += 1
        except Exception as exc:
            for p_orfao in (caminho_3x2, caminho_4x5):
                if p_orfao.exists():
                    try:
                        p_orfao.unlink()
                    except OSError:
                        pass
            motivo = str(exc) or exc.__class__.__name__
            raise RuntimeError(
                f"Opção {i + 1} de {quantidade} falhou: {motivo}; {salvas} opção(ões) gerada(s) e salva(s)"
            ) from exc
