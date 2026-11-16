"""Registro de treino: cada chamada ao modelo e os desfechos viram exemplos rotulados (treino.py)."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pydantic import BaseModel, ConfigDict

from agentes import llm, monitor, pipeline, repo, treino
from agentes.banco import Banco
import test_fase2 as f2
from test_fase2 import DIAG, EXEC, INC, RES_CODIGO, avaliacao


class Livre(BaseModel):
    model_config = ConfigDict(extra="allow")


class FalsoLLM:
    """Agente que passa pelo llm.gerar de verdade (Ollama trocado por mock) para o registro valer."""

    def __init__(self, nome, saidas, chamadas):
        self.nome, self.saidas, self.chamadas = nome, list(saidas), chamadas

    def rodar(self, inc, anteriores):
        self.chamadas.append(self.nome)
        saida = self.saidas.pop(0) if len(self.saidas) > 1 else self.saidas[0]
        if isinstance(saida, Exception):
            raise saida
        resposta = {"message": {"content": json.dumps({k: v for k, v in saida.items() if k != "diff"})}}
        with mock.patch.object(llm, "_post", return_value=resposta):
            llm.gerar("qwen-teste", f"sistema {self.nome}", f"incidente {inc['id']}", Livre)
        return dict(saida), []


class GerarTest(unittest.TestCase):
    def test_registra_a_resposta_invalida_e_a_valida_com_as_mensagens(self):
        class Saida(BaseModel):
            resumo: str

        registros = []
        respostas = [{"message": {"content": "{}"}}, {"message": {"content": '{"resumo": "ok"}'}}]
        with mock.patch.object(llm, "_post", side_effect=respostas), llm.registrando(lambda **c: registros.append(c)):
            self.assertEqual(llm.gerar("m", "s", "u", Saida).resumo, "ok")
        self.assertEqual([r["valida"] for r in registros], [False, True])
        self.assertEqual(len(registros[0]["mensagens"]), 2)
        self.assertEqual(registros[1]["mensagens"][2:], [
            {"role": "assistant", "content": "{}"},
            {"role": "user", "content": mock.ANY},
        ])
        self.assertTrue(registros[0]["erro"])

    def test_sem_registro_ativo_nao_grava_nada(self):
        with mock.patch.object(llm, "_post", return_value={"message": {"content": "{}"}}):
            llm.gerar("m", "s", "u", Livre)


class PipelineTreinoTest(f2.PipelineFase2Test):
    """Herda os testes da fase 2: o pipeline tem de dar o mesmo resultado com o registro ligado."""

    def cadeia(self, res=RES_CODIGO, execs=(EXEC,), avals=(avaliacao(True),)):
        return [
            mock.patch.object(pipeline, "CADEIA", [FalsoLLM("diagnostico", [DIAG], self.chamadas), FalsoLLM("resolucao", [res], self.chamadas)]),
            mock.patch.object(pipeline, "EXECUTOR", FalsoLLM("executor", execs, self.chamadas)),
            mock.patch.object(pipeline, "QUALIDADE", FalsoLLM("qualidade", avals, self.chamadas)),
        ]

    def rotulos(self):
        return [(e["contexto"]["volta"], e["agente"], e["rotulo"]) for e in treino.exemplos(self.banco)]

    def test_volta_com_teste_falhando_e_a_seguinte_confirmada_em_producao(self):
        self.testar.side_effect = [[{"comando": "npm run test:gateway", "ok": False, "saida": "1 failed"}], [{"comando": "npm run test:gateway", "ok": True, "saida": ""}]]
        self.assertEqual(self.rodar(), ["nova_volta", "pr_aberto"])
        self.assertEqual(self.rotulos(), [
            (1, "diagnostico", "incerto"), (1, "resolucao", "incerto"), (1, "executor", "errado"), (1, "qualidade", "errado"),
            (2, "diagnostico", "pendente"), (2, "resolucao", "pendente"), (2, "executor", "pendente"), (2, "qualidade", "pendente"),
        ])

        with mock.patch.object(monitor, "estado_do_pr", return_value=("MERGED", "abc")), mock.patch.object(monitor.rag, "adicionar"):
            monitor.verificar(self.banco)
            self.banco.mudar_estado(self.inc_id, "monitorando", deploy_em="2026-10-30T12:00:00Z")
            self.banco.receber_execucoes({"servico": "gateway", "rotas": {"POST /api/x": {"ok": 5, "erro": 0}}, "ocorrido_em": "2026-10-30T12:05:00Z"})
            self.banco.db.execute("UPDATE incidentes SET rota='POST /api/x' WHERE id=?", (self.inc_id,))
            monitor.verificar(self.banco)
        self.assertEqual({r for v, _, r in self.rotulos() if v == 2}, {"certo"})

        ex = treino.exemplos(self.banco)[-1]
        self.assertEqual([m["role"] for m in ex["messages"]], ["system", "user", "assistant"])
        self.assertIn("confirmado_em_producao", [d["evento"] for d in ex["contexto"]["desfechos"]])

    def test_correcao_que_reaparece_marca_a_volta_como_errada(self):
        self.assertEqual(self.rodar(), ["pr_aberto"])
        self.banco.mudar_estado(self.inc_id, "monitorando", deploy_em="2026-10-30T12:00:00Z")
        self.banco.receber(INC)
        self.assertEqual({r for _, _, r in self.rotulos()}, {"errado"})

    def test_refazer_do_ti_marca_a_volta_recusada_como_errada(self):
        self.assertEqual(self.rodar(), ["pr_aberto"])
        self.banco.gravar_desfecho(self.inc_id, 1, "ti_pediu_ajuste", detalhe="logue em WARNING")
        self.assertEqual({r for _, _, r in self.rotulos()}, {"errado"})

    def test_edicao_que_nao_aplica_vira_desfecho_do_executor(self):
        self.assertEqual(self.rodar(execs=(repo.ErroEdicao("trecho não encontrado"), EXEC)), ["nova_volta", "pr_aberto"])
        eventos = [d["evento"] for d in self.banco.db.execute("SELECT evento FROM desfechos WHERE volta=1")]
        self.assertEqual(eventos, ["edicao_nao_aplicou", "volta_reprovada"])

    def test_reprocessar_descarta_a_volta_e_exportar_filtra(self):
        self.assertEqual(self.rodar(), ["pr_aberto"])
        self.banco.gravar_desfecho(self.inc_id, 1, "ti_reprocessou")
        self.assertEqual({r for _, _, r in self.rotulos()}, {"descartado"})
        destino = Path(self.dir.name) / "t.jsonl"
        self.assertEqual(sum(treino.exportar(self.banco, destino, rotulos={"certo", "errado"}).values()), 0)
        self.assertEqual(destino.read_text(), "")


class RotularTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.banco = Banco(Path(self.dir.name) / "i.db")
        self.inc_id, _ = self.banco.receber(INC)

    def tearDown(self):
        self.dir.cleanup()

    def chamada(self, agente, valida=True):
        self.banco.gravar_chamada(self.inc_id, 1, agente, modelo="m", mensagens=[{"role": "user", "content": "u"}],
                                  resposta="{}", valida=valida, erro="" if valida else "campo faltando", segundos=1)

    def test_json_invalido_e_tentativa_recusada_do_executor_sao_errados(self):
        self.chamada("executor", valida=False)
        self.chamada("executor")
        self.chamada("executor")
        self.banco.gravar_desfecho(self.inc_id, 1, "testes_passaram", "executor")
        self.assertEqual([(e["rotulo"], e["motivo"][:20]) for e in treino.exemplos(self.banco)], [
            ("errado", "JSON fora do esquema"), ("errado", "tentativa recusada ("), ("pendente", ""),
        ])

    def test_qualidade_que_reprova_junto_com_os_testes_acerta(self):
        self.chamada("qualidade")
        for ev in ("testes_falharam", "qualidade_reprovou", "volta_reprovada"):
            self.banco.gravar_desfecho(self.inc_id, 1, ev)
        self.assertEqual(treino.exemplos(self.banco)[0]["rotulo"], "certo")

    def test_ti_resolveu_sem_pr_nao_garante_o_diagnostico(self):
        self.chamada("diagnostico")
        self.banco.gravar_desfecho(self.inc_id, 1, "sem_arquivo_editavel", "resolucao")
        self.banco.gravar_desfecho(self.inc_id, 1, "ti_resolveu", detalhe="liberei a permissão no Tiny")
        ex = treino.exemplos(self.banco)[0]
        self.assertEqual(ex["rotulo"], "incerto")
        self.assertIn("liberei a permissão no Tiny", json.dumps(ex["contexto"], ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()

