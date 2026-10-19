import argparse
import json
import logging
import os
import shutil
import signal
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from app.config import settings
from app.nfe_client import BaseNFeProvider, NFeData, dados_fiscais_do_arquivo, get_nfe_provider, enrich_nfe_data_from_file_context
from app.scanner import DANFEScanner, ScanResult
from app.tiny_client import TinyClient, TinyContaResult

# Configuração de logging estruturado
def setup_logging() -> None:
    settings.ensure_directories()

    log_format = "%(asctime)s [%(levelname)s] [%(name)s]: %(message)s"
    date_format = "%Y-%m-%d %H:%M:%S"
    level = getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO)

    handlers: List[logging.Handler] = [logging.StreamHandler(sys.stdout)]

    if settings.LOG_TO_FILE:
        try:
            log_file = settings.LOG_DIR / "automacao_nfe.log"
            handlers.append(logging.FileHandler(str(log_file), encoding="utf-8"))
        except Exception as e:
            print(f"Aviso: Não foi possível gravar arquivo de log em {settings.LOG_DIR}: {e}", file=sys.stderr)

    logging.basicConfig(
        level=level,
        format=log_format,
        datefmt=date_format,
        handlers=handlers
    )


logger = logging.getLogger("automacao_nfe")


class NFeAutomationOrchestrator:
    """
    Orquestrador central do fluxo de automação fiscal e integração com o ERP Tiny.
    """

    def __init__(
        self,
        scanner: Optional[DANFEScanner] = None,
        nfe_provider: Optional[BaseNFeProvider] = None,
        tiny_client: Optional[TinyClient] = None
    ) -> None:
        self.scanner = scanner or DANFEScanner()
        self.nfe_provider = nfe_provider or get_nfe_provider(settings)
        self.tiny_client = tiny_client or TinyClient()
        self._running = True

    def stop(self) -> None:
        """Sinaliza para o laço contínuo parar com segurança."""
        logger.info("Recebido sinal de interrupção. Encerrando orquestrador...")
        self._running = False

    def process_file(self, file_path: Path) -> bool:
        """
        Executa o pipeline completo para um arquivo de DANFE:
        1. Leitura de Chave de Acesso (Código de barras com fallback para OCR)
        2. Obtenção dos dados fiscais da NF-e (XML/API)
        3. Lançamento do Contas a Pagar no ERP Tiny
        4. Movimentação do arquivo para diretório de sucesso ou falha
        """
        file_path = Path(file_path)
        logger.info("=" * 70)
        logger.info(f"Processando arquivo: {file_path.name}")

        scan_result: Optional[ScanResult] = None
        error_reason: Optional[str] = None

        try:
            # 1. Extração da Chave de Acesso
            scan_result = self.scanner.scan_file(file_path)
            if not scan_result or not scan_result.key:
                error_reason = "Chave de acesso não localizada por código de barras nem por OCR."
                logger.error(f"[{file_path.name}] {error_reason}")
                self._move_to_failed(file_path, error_reason)
                return False

            logger.info(
                f"[{file_path.name}] Chave identificada com sucesso: {scan_result.key} "
                f"(Método: {scan_result.method.upper()})"
            )

            # 2. Obtenção dos dados fiscais da NF-e
            try:
                nfe_data: NFeData = dados_fiscais_do_arquivo(
                    file_path, scan_result.key, scan_result.method, self.nfe_provider
                )
                nfe_data = enrich_nfe_data_from_file_context(nfe_data, file_path, raw_ocr_text=scan_result.raw_text)
                logger.info(
                    f"[{file_path.name}] Dados fiscais recuperados: "
                    f"NF-e {nfe_data.numero_nota} | Emitente: {nfe_data.emitente_nome} "
                    f"| CNPJ: {nfe_data.emitente_cnpj} | Total: R$ {nfe_data.valor_total}"
                )
            except Exception as e:
                error_reason = f"Falha ao obter dados fiscais da chave {scan_result.key}: {e}"
                logger.error(f"[{file_path.name}] {error_reason}", exc_info=True)
                self._move_to_failed(file_path, error_reason)
                return False

            # 3. Lançamento no ERP Tiny
            try:
                results: List[TinyContaResult] = self.tiny_client.lancar_contas_nfe(nfe_data)
                if not results:
                    raise ValueError("Nenhum lançamento de contas a pagar foi retornado pelo ERP Tiny.")
                logger.info(
                    f"[{file_path.name}] {len(results)} parcela(s) processada(s) no ERP Tiny."
                )
            except Exception as e:
                error_reason = f"Falha ao enviar contas a pagar para a API do Tiny: {e}"
                logger.error(f"[{file_path.name}] {error_reason}", exc_info=True)
                self._move_to_failed(file_path, error_reason)
                return False

            # 4. Pós-processamento de Sucesso
            self._move_to_processed(file_path, scan_result, nfe_data, results)
            logger.info(f"[{file_path.name}] FLUXO CONCLUÍDO COM SUCESSO!")
            return True

        except Exception as e:
            error_reason = f"Erro inesperado durante processamento: {e}"
            logger.critical(f"[{file_path.name}] {error_reason}", exc_info=True)
            self._move_to_failed(file_path, error_reason)
            return False

    def process_all_pending(self) -> int:
        """
        Localiza e processa todos os arquivos pendentes na pasta de entrada.
        Retorna a quantidade de arquivos processados com sucesso.
        """
        settings.ensure_directories()
        supported_extensions = {".pdf", ".png", ".jpg", ".jpeg", ".xml"}

        pending_files = [
            f for f in settings.INPUT_DIR.iterdir()
            if f.is_file() and f.suffix.lower() in supported_extensions
        ]

        # Ordena por data de modificação
        pending_files.sort(key=lambda p: p.stat().st_mtime)

        logger.info(f"Iniciando varredura no diretório: '{settings.INPUT_DIR.resolve()}'...")
        if not pending_files:
            logger.info(f"Nenhum arquivo pendente encontrado em '{settings.INPUT_DIR}'.")
            return 0

        logger.info(f"Encontrados {len(pending_files)} arquivo(s) para processamento.")
        success_count = 0

        for file_path in pending_files:
            if not self._running:
                break
            if self.process_file(file_path):
                success_count += 1

        logger.info(
            f"Fim da rodada: {success_count}/{len(pending_files)} arquivo(s) processados com sucesso."
        )
        return success_count

    def run_daemon(self) -> None:
        """Executa o loop contínuo de monitoramento com intervalo configurável."""
        logger.info(
            f"Iniciando serviço em segundo plano (Daemon). "
            f"Monitorando '{settings.INPUT_DIR}' a cada {settings.POLL_INTERVAL_SECONDS}s..."
        )
        while self._running:
            try:
                self.process_all_pending()
            except Exception as e:
                logger.error(f"Erro durante ciclo do daemon: {e}", exc_info=True)

            # Espera cooperativa para responder rápido a sinais SIGINT/SIGTERM
            for _ in range(settings.POLL_INTERVAL_SECONDS):
                if not self._running:
                    break
                time.sleep(1)

        logger.info("Serviço daemon finalizado.")

    def _resolve_target_path(self, dest_dir: Path, original_path: Path) -> Path:
        """Evita sobrescrita se já existir arquivo com o mesmo nome no destino."""
        base_name = original_path.stem
        suffix = original_path.suffix
        target = dest_dir / original_path.name
        counter = 1

        while target.exists():
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            target = dest_dir / f"{base_name}_{timestamp}_{counter}{suffix}"
            counter += 1

        return target

    def _move_to_processed(
        self,
        file_path: Path,
        scan_result: ScanResult,
        nfe_data: NFeData,
        results: List[TinyContaResult]
    ) -> None:
        """Move o arquivo para processed/ e gera metadados de auditoria JSON."""
        dest_path = self._resolve_target_path(settings.PROCESSED_DIR, file_path)
        shutil.move(str(file_path), str(dest_path))

        meta_path = dest_path.with_suffix(dest_path.suffix + ".meta.json")
        metadata = {
            "processed_at": datetime.now().isoformat(),
            "original_filename": file_path.name,
            "chave_acesso": scan_result.key,
            "metodo_leitura": scan_result.method,
            "pagina_leitura": scan_result.page_number,
            "numero_nota": nfe_data.numero_nota,
            "emitente": {
                "razao_social": nfe_data.emitente_nome,
                "cnpj": nfe_data.emitente_cnpj
            },
            "valor_total": float(nfe_data.valor_total),
            "lancamentos_tiny": [
                {
                    "conta_id": r.conta_id,
                    "nro_documento": r.nro_documento,
                    "valor": float(r.valor),
                    "vencimento": r.vencimento.isoformat(),
                    "situacao": r.situacao,
                    "is_duplicate": r.is_duplicate
                }
                for r in results
            ]
        }

        try:
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump(metadata, f, indent=2, ensure_ascii=False)
        except Exception as e:
            logger.warning(f"Não foi possível salvar arquivo de metadados: {e}")

    def _move_to_failed(self, file_path: Path, reason: str) -> None:
        """Move o arquivo para failed/ e cria um arquivo .error.txt descritivo."""
        dest_path = self._resolve_target_path(settings.FAILED_DIR, file_path)
        shutil.move(str(file_path), str(dest_path))

        error_path = dest_path.with_suffix(dest_path.suffix + ".error.txt")
        try:
            with open(error_path, "w", encoding="utf-8") as f:
                f.write(f"Data/Hora: {datetime.now().isoformat()}\n")
                f.write(f"Arquivo original: {file_path.name}\n")
                f.write(f"Motivo da falha: {reason}\n")
        except Exception as e:
            logger.warning(f"Não foi possível salvar arquivo de relatório de erro: {e}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Automação Fiscal de DANFEs para Lançamento de Contas a Pagar no ERP Tiny"
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Executa uma única varredura dos arquivos pendentes e encerra (ideal para execução via cron)"
    )
    parser.add_argument(
        "--file",
        type=str,
        help="Processa um arquivo específico diretamente para testes ou depuração"
    )
    parser.add_argument(
        "--serve",
        action="store_true",
        help="Inicia o servidor de API REST funcional (FastAPI) para integração com a interface web"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Porta TCP para o servidor da API (padrão: 8000)"
    )
    parser.add_argument(
        "--host",
        type=str,
        default="0.0.0.0",
        help="Host de escuta do servidor da API (padrão: 0.0.0.0)"
    )
    args = parser.parse_args()

    setup_logging()

    serve_mode = (
        args.serve
        or os.environ.get("RUN_MODE") == "serve"
        or os.environ.get("SERVE_API", "").lower() in ("1", "true", "yes")
    )
    if serve_mode:
        import uvicorn
        logger.info(f"Iniciando servidor API REST funcional em http://{args.host}:{args.port}...")
        uvicorn.run("app.api:app", host=args.host, port=args.port, reload=False)
        return

    orchestrator = NFeAutomationOrchestrator()

    # Tratamento de sinais de encerramento gracioso (Docker stop, kill, Ctrl+C)
    def handle_signal(sig, frame):
        orchestrator.stop()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    if args.file:
        target_file = Path(args.file)
        if not target_file.exists():
            logger.error(f"Arquivo não encontrado: {target_file}")
            sys.exit(1)
        success = orchestrator.process_file(target_file)
        sys.exit(0 if success else 1)

    if args.once or settings.RUN_MODE == "once":
        orchestrator.process_all_pending()
    else:
        orchestrator.run_daemon()


if __name__ == "__main__":
    main()
