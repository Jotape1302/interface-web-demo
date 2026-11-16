"""Dataset SFT/DPO e métricas do classificador de NF-e (treino_financeiro.py), sem GPU nem Ollama."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agentes import financeiro, financeiro_fila as ff, treino_financeiro as tf
from agentes.banco import Banco
from tests.test_financeiro import CATS, FORN, FABRILUX, OUTRO, vetor_falso

COMPRAS, LIMPEZA, ESCRITORIO = (c["id"] for c in CATS)


def confirmada(chave, staged, itens, emit=FORN, **extra):
    """itens: (item_id, descricao, ncm, categoria, qwen_categoria, codigo)."""
    return {
        "chave": chave, "staged_at": staged, "confirmado_em": f"{staged}-03:00", "destinatario_cnpj": FABRILUX,
        "destinatario_nome": "Fabrilux", "emitente_cnpj": emit, "emitente_nome": "Forn " + emit[:2], "valor_total": 50.0,
        "meio_pagamento_nfe": "15",
        "itens": [
            {"item_id": i, "descricao": d, "ncm": n, "categoria_id": c, "qwen_categoria_id": q, "qwen_confianca": "media" if q else None,
             "codigo": cod, "valor_total": 10.0}
            for i, d, n, c, q, cod in itens
        ],
        **extra,
    }


def atividade(id_, chave, escolhas, sugestoes, status=200, **extra):
    return json.dumps({
        "id": id_, "criado_em": "2026-11-03T20:00:00.000000Z", "rota": "/api/automacao-nfe/danfe/confirm-lancamento",
        "status": status, "truncado": False,
        "entrada": {"chave": chave, "itens": [{"item_id": i, "categoria_id": c} for i, c in escolhas]},
        "contexto": {"chave": chave, "nfe_data": {}, "itens": []},
        "sugestao": {
            i: {"categoria_id": c, "origem": o, "nivel": None, "confianca": None, "motivo": None,
                "alternativas": {"historico": None, "qwen": None, "regra": c}}
            for i, c, o in sugestoes
        },
        **extra,
    })


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.banco = Banco(Path(self.dir.name) / "i.db")
        p = mock.patch.object(financeiro, "vetorizar", vetor_falso)
        p.start()
        self.addCleanup(p.stop)
        ff.sincronizar(self.banco, {"categorias": CATS})

    def tearDown(self):
        self.banco.db.close()
        self.dir.cleanup()

    def historico(self, *notas):
        ff.sincronizar(self.banco, {"confirmadas": list(notas)})
        financeiro.atualizar_vetores(self.banco)


class ImportarAtividadesTest(Base):
    def test_grava_sugestao_da_tela_e_ignora_o_que_nao_serve(self):
        linhas = [
            atividade(5, "N1", [("1", COMPRAS)], [("1", LIMPEZA, "regra")]),
            atividade(3, "N1", [("1", ESCRITORIO)], [("1", ESCRITORIO, "historico")]),  # mais antiga: não sobrescreve
            atividade(6, "N2", [("1", COMPRAS)], [("1", COMPRAS, "regra")], status=502),
            atividade(7, "N3", [("1", COMPRAS)], [("1", COMPRAS, "regra")], truncado=True),
            json.dumps({"id": 8, "rota": "/api/automacao-nfe/danfe/archive", "status": 200}),
            "não é json",
        ]
        contagem = tf.importar_atividades(self.banco, linhas)
        self.assertEqual((contagem["confirmacoes"], contagem["recusadas_pela_vps"], contagem["incompletas"], contagem["json_invalido"]), (2, 1, 1, 1))
        linha = self.banco.db.execute("SELECT * FROM sugestoes_financeiro").fetchall()
        self.assertEqual(len(linha), 1)
        self.assertEqual((linha[0]["atividade_id"], linha[0]["categoria_id"], linha[0]["origem"], linha[0]["escolha_categoria_id"]),
                         (5, LIMPEZA, "regra", COMPRAS))


class DatasetTest(Base):
    def montar_historico(self):
        # 10 notas do mesmo fornecedor, uma por dia; a N05 teve o Qwen corrigido (sugeriu Limpeza, ficou Escritório).
        notas = []
        for d in range(1, 11):
            itens = [("1", f"Detergente neutro lote {d}", "34022000", LIMPEZA, None, None),
                     ("2", f"Papel A4 resma {d}", "48025610", ESCRITORIO, LIMPEZA if d == 5 else None, None)]
            notas.append(confirmada(f"N{d:02d}", f"2026-10-{d:02d}T10:00:00", itens))
        self.historico(*notas)

    @staticmethod
    def exemplos(ex):
        return ex["messages"][1]["content"].split("<exemplos>")[1].split("</exemplos>")[0]

    def test_split_temporal_pega_a_mais_recente(self):
        self.montar_historico()
        self.assertIn("N10", {ex["contexto"]["chave"] for ex in tf.montar(self.banco).validacao})

    def test_nota_da_validacao_nao_vira_exemplo_nem_pista_do_treino(self):
        self.montar_historico()
        citam_n03 = lambda ds: [ex["contexto"]["chave"] for ex in ds.treino if "lote 3 →" in self.exemplos(ex)]
        self.assertTrue(citam_n03(tf.montar(self.banco)))  # sem estar na validação, a N03 é exemplo das seguintes
        with mock.patch.object(tf, "separar", return_value={"N03", "N10"}):
            ds = tf.montar(self.banco)
        self.assertEqual(citam_n03(ds), [])
        self.assertIn("N03", {ex["contexto"]["chave"] for ex in ds.validacao})
        # A validação, por ser o "futuro", pode usar o treino anterior a ela.
        n10 = next(ex for ex in ds.validacao if ex["contexto"]["chave"] == "N10")
        self.assertIn("lote 9 →", self.exemplos(n10))

    def test_exemplos_do_prompt_sao_so_de_notas_anteriores(self):
        self.montar_historico()
        ds = tf.montar(self.banco)
        n03 = next(ex for ex in ds.treino if ex["contexto"]["chave"] == "N03")
        self.assertIn("lote 1 →", self.exemplos(n03))
        self.assertNotIn("lote 4 →", self.exemplos(n03))
        primeira = next(ex for ex in ds.treino if ex["contexto"]["chave"] == "N01")
        self.assertIn("(nenhum ainda)", primeira["messages"][1]["content"])

    def test_alvo_e_a_escolha_humana_no_formato_do_schema(self):
        self.montar_historico()
        ds = tf.montar(self.banco)
        ex = next(ex for ex in ds.treino if ex["contexto"]["chave"] == "N05")
        self.assertEqual(ex["rotulo"], "corrigido_pelo_humano")
        alvo = json.loads(ex["messages"][2]["content"])["itens"]
        modelo = financeiro.esquema(list(financeiro.rotulos(CATS)), ["1", "2"])
        modelo.model_validate({"itens": alvo})  # aceito pelo mesmo schema do Ollama
        self.assertEqual([list(i) for i in alvo], [["item_id", "motivo", "categoria", "confianca"]] * 2)
        self.assertEqual(alvo[1]["categoria"], "4.Despesas Operacionais → Material de Escritório")
        self.assertIn("Parcelas: 1", ex["messages"][1]["content"])
        self.assertIn("Fabrilux", ex["messages"][1]["content"])

    def test_corrigido_gera_par_dpo_e_oversample(self):
        self.montar_historico()
        pasta = Path(self.dir.name) / "treino"
        contagem = tf.exportar(self.banco, pasta)
        dpo = [json.loads(l) for l in (pasta / "financeiro_dpo.jsonl").read_text().splitlines()]
        self.assertEqual(len(dpo), 1)
        escolhido = json.loads(dpo[0]["chosen"][0]["content"])["itens"][1]
        rejeitado = json.loads(dpo[0]["rejected"][0]["content"])["itens"][1]
        self.assertEqual((escolhido["categoria"].split(" → ")[1], rejeitado["categoria"].split(" → ")[1]),
                         ("Material de Escritório", "Materiais de Limpeza"))
        self.assertEqual([m["role"] for m in dpo[0]["prompt"]], ["system", "user"])
        sft = [json.loads(l) for l in (pasta / "financeiro_sft.jsonl").read_text().splitlines()]
        self.assertEqual(sum(ex["contexto"]["chave"] == "N05" for ex in sft), tf.OVERSAMPLE)
        self.assertEqual(contagem["linhas_sft"], len(sft))
        validacao = [json.loads(l) for l in (pasta / "financeiro_validacao.jsonl").read_text().splitlines()]
        self.assertTrue(all("categoria_id" in g for ex in validacao for g in ex["contexto"]["itens"]))

    def test_sugestao_da_tela_corrigida_tambem_conta(self):
        self.montar_historico()
        tf.importar_atividades(self.banco, [atividade(1, "N03", [("1", LIMPEZA), ("2", ESCRITORIO)],
                                                      [("1", LIMPEZA, "historico"), ("2", COMPRAS, "regra")])])
        ex = next(ex for ex in tf.montar(self.banco).treino if ex["contexto"]["chave"] == "N03")
        self.assertEqual([g["rotulo"] for g in ex["contexto"]["itens"]], ["confirmado", "corrigido_pelo_humano"])

    def test_item_com_historico_pelo_codigo_fica_fora_como_na_fila(self):
        self.historico(
            confirmada("A", "2026-10-01T10:00:00", [("1", "Detergente", "34022000", LIMPEZA, None, "DET5")]),
            confirmada("B", "2026-10-02T10:00:00", [("1", "Detergente", "34022000", LIMPEZA, None, "DET5"),
                                                    ("2", "Caneta", "96081000", ESCRITORIO, None, "CAN")]),
        )
        ds = tf.montar(self.banco)
        self.assertEqual(ds.contagem["itens_pelo_codigo"], 1)
        b = next(ex for ex in ds.treino + ds.validacao if ex["contexto"]["chave"] == "B")
        self.assertEqual([g["item_id"] for g in b["contexto"]["itens"]], ["2"])

    def test_categoria_frequente_sempre_na_validacao(self):
        notas = [confirmada(f"C{d:02d}", f"2026-10-{d:02d}T10:00:00", [("1", "Mercadoria", "1", COMPRAS, None, None)]) for d in range(1, 7)]
        notas += [confirmada(f"L{d:02d}", f"2026-10-{d:02d}T11:00:00", [("1", "Sabão", "2", LIMPEZA, None, None)], emit=OUTRO)
                  for d in range(7, 21)]
        self.historico(*notas)
        validacao = tf.separar(tf._notas(self.banco))
        self.assertIn("C06", validacao)  # a mais recente de Compras, que não caiu entre as 10% finais
        self.assertIn("L20", validacao)


class AvaliarTest(Base):
    def test_relatorio(self):
        self.historico(
            confirmada("A", "2026-10-01T10:00:00", [("1", "Papel", "1", ESCRITORIO, LIMPEZA, None), ("2", "Sabão", "2", LIMPEZA, LIMPEZA, None)]),
        )
        texto = tf.avaliar(self.banco)
        self.assertIn("1 nota(s), 2 item(ns)", texto)
        self.assertIn("Qwen na tela: concordância 1/2 (50.0%)", texto)
        self.assertIn("1/1    4.Despesas Operacionais → Material de Escritório", texto)


if __name__ == "__main__":
    unittest.main()
