#!/usr/bin/env python3
"""
sync_ml_tokens.py — Sincroniza tokens do Mercado Livre via API do TMS.

Fluxo:
  1. POST /tms_api/auth/login com {"name": "...", "password": "..."} -> extrai Bearer Token.
  2. GET /tms_api/tokens?id=3 -> Token ML da Revesta ("revesta").
  3. GET /tms_api/tokens?id=4 -> Token ML de Campinas ("norvia").
  4. Grava atomicamente o ml_tokens.json (0640) no data/ do marketplace e do financeiro.

Credenciais: TMS_USER/TMS_PASSWORD do ambiente ou de um .env explícito (--env-file).

Uso:
  python scripts/sync_ml_tokens.py --env-file .env       # Execução única (cron do servidor)
  python scripts/sync_ml_tokens.py --dry-run             # Consulta e exibe sem gravar
  python scripts/sync_ml_tokens.py --loop --interval 7200 # Executa a cada 2 horas
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("sync_ml_tokens")

DEFAULT_BASE_URL = "https://servidor.norvia.example/tms_api"


def carregar_env(caminho_env: Optional[Path] = None) -> None:
    """Lê variáveis simples de arquivo .env explícito se fornecido (SA-09)."""
    if not caminho_env:
        return
    if not caminho_env.is_file():
        logger.warning(f"Arquivo .env não encontrado: {caminho_env}")
        return
    try:
        for linha in caminho_env.read_text(encoding="utf-8").splitlines():
            linha = linha.strip()
            if not linha or linha.startswith("#") or "=" not in linha:
                continue
            chave, valor = linha.split("=", 1)
            chave = chave.strip()
            valor = valor.strip().strip("'\"")
            if chave and chave not in os.environ:
                os.environ[chave] = valor
    except Exception as e:
        logger.debug(f"Não foi possível ler {caminho_env}: {e}")


def http_request_json(
    url: str,
    method: str = "GET",
    data: Optional[Dict[str, Any]] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: int = 30,
    insecure: bool = False,
) -> Any:
    """Executa requisição HTTP usando biblioteca padrão com suporte a JSON."""
    headers = dict(headers or {})
    headers.setdefault("Accept", "application/json")

    corpo_bytes = None
    if data is not None:
        headers.setdefault("Content-Type", "application/json")
        corpo_bytes = json.dumps(data).encode("utf-8")

    req = urllib.request.Request(url, data=corpo_bytes, headers=headers, method=method)

    import ssl
    ssl_ctx = None
    if insecure:
        parsed = urllib.parse.urlparse(url)
        host = (parsed.hostname or "").lower()
        eh_loopback = host in ("127.0.0.1", "localhost", "::1")
        if not eh_loopback:
            raise ValueError(
                f"Flag --insecure é permitida apenas em hosts loopback (127.0.0.1/localhost). Recusado para host: {host}"
            )
        logger.warning(f"[SEGURANCA] Validação TLS desativada via --insecure para host loopback: {host}")
        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE

    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_ctx) as resp:
            conteudo = resp.read().decode("utf-8")
            if not conteudo.strip():
                return None
            try:
                return json.loads(conteudo)
            except json.JSONDecodeError:
                return conteudo
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} ao acessar {url}") from e
    except urllib.error.URLError as e:
        msg = f"Erro de conexão ao acessar {url}: {e.reason}"
        if "servidor.norvia.example" in url:
            msg += " (Dica: se estiver executando no próprio servidor norviaServidor, configure TMS_BASE_URL explicitamente)"
        raise RuntimeError(msg) from e


def extrair_token_auth(payload: Any) -> str:
    """Extrai token Bearer do retorno de autenticação do TMS."""
    if isinstance(payload, str):
        return payload.strip()

    if isinstance(payload, dict):
        for chave in ["token", "access_token", "accessToken", "jwt", "id_token"]:
            valor = payload.get(chave)
            if valor and isinstance(valor, str):
                return valor.strip()

        for aninhado in ["data", "auth", "session"]:
            sub = payload.get(aninhado)
            if isinstance(sub, dict):
                try:
                    return extrair_token_auth(sub)
                except ValueError:
                    pass

    raise ValueError("Não foi possível localizar token de autenticação no retorno do TMS")


def extrair_dados_token_ml(payload: Any) -> Dict[str, Any]:
    """
    Extrai access_token e refresh_token (e outros metadados) do retorno do TMS.
    Aceita dict, lista de dicts, lista de tokens ou string.
    """
    resultado: Dict[str, Any] = {}

    if isinstance(payload, str):
        tok = payload.strip()
        if tok.startswith("TG-"):
            resultado["refresh_token"] = tok
        else:
            resultado["access_token"] = tok
        return resultado

    if isinstance(payload, list):
        for item in payload:
            try:
                sub = extrair_dados_token_ml(item)
                for k, v in sub.items():
                    if v and k not in resultado:
                        resultado[k] = v
            except ValueError:
                pass
        if resultado.get("access_token") or resultado.get("refresh_token"):
            return resultado

    if isinstance(payload, dict):
        base = dict(payload)
        for sub_chave in ["data", "result", "tokens"]:
            if isinstance(base.get(sub_chave), (dict, list)):
                try:
                    aninhado = extrair_dados_token_ml(base[sub_chave])
                    for k, v in aninhado.items():
                        if v and k not in resultado:
                            resultado[k] = v
                except ValueError:
                    pass

        # Procura access_token
        for k in ["access_token", "accessToken", "token", "ml_token", "access_token_ml", "valor", "value"]:
            val = base.get(k)
            if val and isinstance(val, str) and not resultado.get("access_token"):
                val_limpo = val.strip()
                if not val_limpo.startswith("TG-"):
                    resultado["access_token"] = val_limpo
                    break

        # Procura refresh_token
        for k in ["refresh_token", "refreshToken", "refresh", "token_refresh"]:
            val = base.get(k)
            if val and isinstance(val, str) and not resultado.get("refresh_token"):
                resultado["refresh_token"] = val.strip()
                break

        # Metadados adicionais úteis do Mercado Livre
        for k in ["user_id", "userId", "expires_in", "expiresIn", "token_type", "scope"]:
            val = base.get(k)
            if val is not None and k not in resultado:
                chave_norm = "user_id" if k in ("userId", "user_id") else ("expires_in" if k in ("expiresIn", "expires_in") else k)
                resultado[chave_norm] = val

        # Se houver campo indicando o tipo (ex.: {"name": "refresh_token", "token": "..."})
        tipo = str(base.get("type") or base.get("tipo") or base.get("name") or base.get("descricao") or "").lower()
        tok = base.get("token") or base.get("valor") or base.get("value")
        if isinstance(tok, str):
            tok_limpo = tok.strip()
            if "refresh" in tipo or tok_limpo.startswith("TG-"):
                if not resultado.get("refresh_token"):
                    resultado["refresh_token"] = tok_limpo
            elif "access" in tipo or tok_limpo.startswith("APP_USR-"):
                if not resultado.get("access_token"):
                    resultado["access_token"] = tok_limpo

    if not resultado.get("access_token") and not resultado.get("refresh_token"):
        raise ValueError("Não foi possível localizar tokens do Mercado Livre no retorno do TMS")

    return resultado


def extrair_token_ml(payload: Any) -> str:
    """Extrai token do Mercado Livre do retorno de tokens do TMS (compatibilidade)."""
    dados = extrair_dados_token_ml(payload)
    return str(dados.get("access_token") or dados.get("refresh_token") or "")


def login_tms(base_url: str, usuario: str, senha: str, timeout: int = 30, insecure: bool = False) -> str:
    """Realiza login no TMS e obtém o token de sessão Bearer."""
    url = f"{base_url.rstrip('/')}/auth/login"
    payload = {"name": usuario, "password": senha}
    resp = http_request_json(url, method="POST", data=payload, timeout=timeout, insecure=insecure)
    token = extrair_token_auth(resp)
    if not token:
        raise ValueError("Token de autenticação do TMS vazio.")
    return token


def buscar_token_ml_tms(
    base_url: str,
    token_auth: str,
    token_id: int,
    timeout: int = 30,
    insecure: bool = False,
) -> Dict[str, Any]:
    """Busca os dados do token (access e refresh) do Mercado Livre de uma filial específica pelo ID."""
    url = f"{base_url.rstrip('/')}/tokens?id={token_id}"
    headers = {"Authorization": f"Bearer {token_auth}"}
    resp = http_request_json(url, method="GET", headers=headers, timeout=timeout, insecure=insecure)
    return extrair_dados_token_ml(resp)


def obter_todos_tokens_ml(
    base_url: str,
    usuario: str,
    senha: str,
    timeout: int = 30,
    insecure: bool = False,
) -> Dict[str, Dict[str, Any]]:
    """Executa o ciclo completo de login e busca dos tokens Revesta (id=3) e Campinas (id=4)."""
    logger.info("Realizando login na API do TMS...")
    token_tms = login_tms(base_url, usuario, senha, timeout=timeout, insecure=insecure)
    logger.info("Login no TMS concluído com sucesso.")

    logger.info("Buscando tokens da Revesta (id=3)...")
    dados_revesta = buscar_token_ml_tms(base_url, token_tms, token_id=3, timeout=timeout, insecure=insecure)

    logger.info("Buscando tokens de Campinas (id=4)...")
    dados_campinas = buscar_token_ml_tms(base_url, token_tms, token_id=4, timeout=timeout, insecure=insecure)

    agora_iso = datetime.now(timezone.utc).isoformat()
    return {
        "norvia": {
            **dados_campinas,
            "renovado_em": agora_iso,
        },
        "revesta": {
            **dados_revesta,
            "renovado_em": agora_iso,
        },
    }


def gravar_json_atomico(caminho: Path, dados: Dict[str, Any], modo: int = 0o640) -> None:
    """
    Grava JSON atomicamente com modo restrito (0640 por padrão, SA-02): sem leitura para "outros".
    Não usar 0600: no Docker rootless o container do marketplace lê o arquivo por ACL, e o chmod
    define a máscara da ACL pelos bits de grupo — 0600 zera a máscara e o container perde a leitura.
    """
    caminho.parent.mkdir(parents=True, exist_ok=True)
    temp_dir = caminho.parent
    with tempfile.NamedTemporaryFile("w", dir=temp_dir, delete=False, encoding="utf-8") as tf:
        json.dump(dados, tf, indent=2, ensure_ascii=False)
        tf.write("\n")
        temp_path = Path(tf.name)

    try:
        os.chmod(temp_path, modo)
        temp_path.replace(caminho)
    except Exception:
        if temp_path.exists():
            temp_path.unlink()
        raise


def resolver_caminhos_destino(saida_cli: Optional[list[str]] = None) -> list[Path]:
    """
    Onde gravar ml_tokens.json: os `--output` informados, senão ML_TOKENS_FILE, senão o `data/` do
    marketplace e do financeiro. Este script roda no host (cron) e é a única fonte dos tokens das
    duas automações — o financeiro só renova sozinho se tiver TMS_USER/TMS_PASSWORD no próprio .env.
    """
    if saida_cli:
        return [Path(s) for s in saida_cli]

    env_file = os.environ.get("ML_TOKENS_FILE")
    if env_file:
        return [Path(env_file)]

    automacoes = Path(__file__).resolve().parent.parent / "backend" / "automations"
    padroes = [automacoes / nome / "data" / "ml_tokens.json" for nome in ("automacoes-marketplace", "automacoes-financeiro")]
    existentes = [p for p in padroes if p.parent.is_dir()]
    return existentes or padroes[:1]


ML_USERS_ME = "https://api.mercadolibre.com/users/me"


def validar_token_ml(access_token: str, timeout: int = 15) -> Optional[bool]:
    """
    Testa o access token no próprio Mercado Livre (GET /users/me).
    True = aceito; False = recusado (HTTP 401/403); None = não deu para testar (rede, 5xx).
    O TMS entrega o token que tem guardado: se a renovação dele atrasou, o token já vem vencido
    (13/10/2026: marketplace e conciliação ficaram horas com 401 sem nenhum aviso).
    """
    try:
        http_request_json(
            ML_USERS_ME,
            headers={"Authorization": f"Bearer {access_token}", "User-Agent": "norvia-sync-ml-tokens"},
            timeout=timeout,
        )
        return True
    except RuntimeError as e:
        if "HTTP 401" in str(e) or "HTTP 403" in str(e):
            return False
        logger.warning(f"Não foi possível testar o token no Mercado Livre: {e}")
        return None


def sincronizar_tokens(
    base_url: str,
    usuario: str,
    senha: str,
    destinos: list[Path],
    dry_run: bool = False,
    timeout: int = 30,
    insecure: bool = False,
    validar: bool = True,
) -> Dict[str, Dict[str, Any]]:
    """Fluxo principal de sincronização."""
    tokens = obter_todos_tokens_ml(base_url, usuario, senha, timeout=timeout, insecure=insecure)

    if validar:
        for filial, info in tokens.items():
            acc = info.get("access_token")
            if not acc:
                continue
            valido = validar_token_ml(acc, timeout=min(timeout, 15))
            info["valido"] = valido
            info["validado_em"] = datetime.now(timezone.utc).isoformat()
            if valido is False:
                logger.error(
                    f"TOKEN INVÁLIDO: o TMS entregou para {filial} um access token que o Mercado Livre recusa "
                    "(HTTP 401). As automações vão falhar com esta conta até o TMS renovar o token; "
                    "o próximo ciclo do cron busca de novo."
                )
            elif valido:
                logger.info(f"Token de {filial} conferido no Mercado Livre: válido.")

    for filial, info in tokens.items():
        acc = info.get("access_token")
        ref = info.get("refresh_token")
        detalhes = []
        if acc:
            detalhes.append(f"access_token={acc[:12]}...")
        if ref:
            detalhes.append(f"refresh_token={ref[:12]}...")
        desc = ", ".join(detalhes) if detalhes else "sem tokens reconhecidos"
        logger.info(f"Tokens obtidos para {filial}: {desc} (renovado em {info.get('renovado_em')})")

    if dry_run:
        logger.info("[DRY-RUN] Nenhuma gravação em disco realizada.")
        return tokens

    for dest in destinos:
        try:
            gravar_json_atomico(dest, tokens)
            logger.info(f"Tokens salvos com sucesso em: {dest.resolve()}")
        except Exception as e:
            logger.error(f"Falha ao salvar tokens em {dest}: {e}")

    return tokens


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default=None, help=f"URL base do TMS (padrão: {DEFAULT_BASE_URL} ou env TMS_BASE_URL)")
    parser.add_argument("--user", "--name", dest="user", default=None, help="Usuário do TMS (ou env TMS_USER / TMS_NAME)")
    parser.add_argument("--output", action="append", default=None, help="Caminho do ml_tokens.json de saída (pode repetir; padrão: data/ do marketplace e do financeiro)")
    parser.add_argument("--env-file", default=None, help="Caminho para arquivo .env customizado")
    parser.add_argument("--dry-run", action="store_true", help="Apenas obtém e exibe os tokens sem gravar")
    parser.add_argument("--insecure", action="store_true", help="Desabilita validação de certificado SSL (permitido apenas em hosts loopback)")
    parser.add_argument("--loop", action="store_true", help="Executa em loop contínuo")
    parser.add_argument("--interval", type=int, default=7200, help="Intervalo em segundos para o loop (padrão: 7200s / 2h)")
    parser.add_argument("--sem-validar", action="store_true", help="Não testa os tokens no Mercado Livre (/users/me) depois de buscá-los")
    parser.add_argument("--timeout", type=int, default=30, help="Timeout das requisições HTTP (padrão: 30s)")
    args = parser.parse_args()

    carregar_env(Path(args.env_file) if args.env_file else None)

    base_url = args.base_url or os.environ.get("TMS_BASE_URL") or DEFAULT_BASE_URL
    user = args.user or os.environ.get("TMS_USER") or os.environ.get("TMS_NAME")
    password = os.environ.get("TMS_PASSWORD")

    if not user or not password:
        logger.error("Credenciais do TMS não informadas. Defina TMS_USER e TMS_PASSWORD no ambiente ou use --env-file.")
        return 1

    destinos = resolver_caminhos_destino(args.output)

    codigo = 0
    while True:
        try:
            tokens = sincronizar_tokens(
                base_url=base_url,
                usuario=user,
                senha=password,
                destinos=destinos,
                dry_run=args.dry_run,
                timeout=args.timeout,
                insecure=args.insecure,
                validar=not args.sem_validar,
            )
            # Código 3: gravou, mas o Mercado Livre recusou algum token (o cron registra a falha).
            codigo = 3 if any(i.get("valido") is False for i in tokens.values()) else 0
        except Exception as e:
            logger.error(f"Erro durante a sincronização de tokens: {e}")
            if not args.loop:
                return 2

        if not args.loop:
            break

        logger.info(f"Aguardando {args.interval} segundos até a próxima verificação...")
        time.sleep(args.interval)

    return codigo


if __name__ == "__main__":
    sys.exit(main())
