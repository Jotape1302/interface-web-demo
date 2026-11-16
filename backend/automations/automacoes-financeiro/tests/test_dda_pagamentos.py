"""
Boletos do DDA (Polp) → conta a pagar do Tiny → pagamento no Inter → baixa (app/dda_pagamentos.py).
Casamento exato (fornecedor, vencimento, valor), nunca cria conta sozinho, nunca agenda duas vezes
o mesmo boleto no Inter, baixa só depois de o Inter confirmar o pagamento.
"""
from datetime import date
from decimal import Decimal

import pytest

from app import dda_pagamentos as dda
from app.config import settings
from app.inter_client import PagamentoInterIncerto
from app.tiny_client import LancamentoCaixaIncerto

CAMPINAS = "27184930000107"
FORNECEDOR = "11222333000181"
HOJE = date(2026, 11, 16)
BARRAS = "23793381286000000000000000000000000000000000"[:44]


def _boleto_polp(bid="b1", valor_cent=150000, venc="2026-11-20", status=0, emissor=FORNECEDOR, sacador=None, **kw):
    return {
        "id": bid, "dda_id": "d1", "barcode": BARRAS, "digitable_line": None, "owner_tax_id": CAMPINAS,
        "issuer": {"name": "Fornecedor Ltda", "taxId": emissor}, "guarantor_tax_id": sacador,
        "cost": valor_cent, "cost_updated": valor_cent, "due_date": venc, "issue_date": "2026-11-01",
        "document_number": "NF 123", "status": status, "status_label": "Aberto", **kw,
    }


class _Polp:
    def __init__(self, boletos):
        self.boletos = boletos
        self.desde = []

    def configurada(self):
        return True

    def listar_ddas(self):
        return [{"id": "d1", "tax_id": CAMPINAS, "status": 1, "status_label": "Sucesso"}]

    def listar_boletos(self, dda_id, desde=None):
        self.desde.append(desde)
        return list(self.boletos)


class _Inter:
    def __init__(self, existentes=None, status="AGUARDANDO_APROVACAO", incerto=False):
        self.existentes = existentes or []
        self.status = status
        self.incerto = incerto
        self.pagamentos = []

    def buscar_pagamentos_boleto(self, empresa, codigo_transacao=None, codigo_barras=None):
        if codigo_transacao:
            return [{"codigoTransacao": codigo_transacao, "statusPagamento": self.status, "valorPago": 1500.0,
                     "dataPagamento": "2026-11-20 10:00:00", "aprovacoesRealizadas": 1}]
        return list(self.existentes)

    def pagar_boleto(self, empresa, codigo, valor, venc, data_pagamento=None, cnpj_beneficiario=None):
        self.pagamentos.append((empresa, codigo, valor, venc, data_pagamento, cnpj_beneficiario))
        if self.incerto:
            self.existentes = [{"codigoTransacao": "tx-incerto", "statusPagamento": "AGUARDANDO_APROVACAO"}]
            raise PagamentoInterIncerto("timeout")
        return {"codigoTransacao": "tx-1", "statusPagamento": "AGUARDANDO_APROVACAO", "quantidadeAprovadores": 1}


class _Tiny:
    def __init__(self, contas=None, situacao="aberto", contatos=None, incerto=False):
        self.contas = contas if contas is not None else [_conta(10)]
        self.situacao = situacao
        self.contatos = contatos if contatos is not None else [{"id": 5, "nome": "Fornecedor Ltda", "cpfCnpj": "11.222.333/0001-81"}]
        self.incerto = incerto
        self.baixas = []
        self.criadas = []

    def list_contas_pagar_abertas(self, token, data_inicial_vencimento=None, data_final_vencimento=None):
        return list(self.contas)

    def obter_conta_pagar_v3(self, token, conta_id):
        conta = next((c for c in self.contas if int(c["id"]) == int(conta_id)), _conta(conta_id))
        return {**conta, "situacao": self.situacao}, token

    def resolve_conta_origem_inter(self, token, account_id):
        return 777

    def baixar_conta_pagar_v3(self, **kw):
        self.baixas.append(kw)
        return True

    def buscar_contatos_v3(self, token, nome="", cpf_cnpj=""):
        return list(self.contatos)

    def list_categorias_receita_despesa_v3(self, token):
        return [{"id": 2, "descricao": "Aluguel", "grupo": "Despesas fixas"}, {"id": 1, "descricao": "Energia", "grupo": "Despesas fixas"}, {"id": 3}]

    def criar_conta_pagar_v3(self, token, **kw):
        self.criadas.append(kw)
        if self.incerto:
            raise LancamentoCaixaIncerto("HTTP 502")
        return 99


def _conta(cid, valor=1500.0, venc="2026-11-20", cnpj="11.222.333/0001-81"):
    return {"id": cid, "valor": valor, "dataVencimento": venc, "historico": f"NF {cid}",
            "cliente": {"nome": "Fornecedor Ltda", "cpfCnpj": cnpj}}


def _rotina(tmp_path, polp=None, inter=None, tiny=None, agendar=True):
    cfg = settings.model_copy(update={"DATA_DIR": tmp_path, "DDA_AGENDAR_NO_INTER": agendar})
    return dda.RotinaDDA(
        estado=dda.EstadoDDA(pasta=tmp_path / "dda", cfg=cfg), cfg=cfg,
        polp=polp or _Polp([_boleto_polp()]), inter=inter or _Inter(), tiny=tiny or _Tiny(),
        token_tiny=lambda emp: "tok", hoje=lambda: HOJE,
    )


def _b(r, bid="b1"):
    return r.estado.ler()["boletos"][bid]


# --- Polp ------------------------------------------------------------------------------------


def test_boleto_da_polp_converte_centavos_e_empresa_pelo_cnpj_do_pagador(tmp_path):
    r = _rotina(tmp_path)
    assert r.sincronizar()["novos"] == 1
    b = _b(r)
    assert (b["empresa"], b["valor"], b["vencimento"], b["beneficiario_cnpj"], b["situacao"]) == (
        "norvia_campinas", "1500.00", "2026-11-20", FORNECEDOR, dda.SIT_NOVO)
    assert r.estado.ler()["cursores"]["d1"], "próxima leitura só do que mudou"


def test_boleto_ja_pago_na_cip_nao_entra(tmp_path):
    r = _rotina(tmp_path, polp=_Polp([_boleto_polp(status=2)]))
    assert r.sincronizar() == {"cadastros": 1, "novos": 0, "atualizados": 0, "ja_resolvidos": 1}
    assert r.estado.ler()["boletos"] == {}


def test_linha_digitavel_vira_codigo_de_barras():
    linha = "23793381286000000000000000000000000000000000000"
    b = dda.boleto_da_polp({**_boleto_polp(), "barcode": None, "digitable_line": linha}, "norvia_campinas")
    assert len(b["codigo_barras"]) == 44 and b["linha_digitavel"] == linha


# --- casamento -------------------------------------------------------------------------------


def test_casa_com_a_conta_de_mesmo_fornecedor_vencimento_e_valor(tmp_path):
    r = _rotina(tmp_path)
    r.sincronizar()
    assert r.casar() == {"casados": 1, "sem_conta": 0, "ambiguos": 0}
    assert (_b(r)["situacao"], _b(r)["conta_id"]) == (dda.SIT_CASADO, 10)


@pytest.mark.parametrize("conta", [
    _conta(10, valor=1500.01),  # um centavo: sem tolerância
    _conta(10, venc="2026-11-21"),
    _conta(10, cnpj="99.999.999/0001-99"),
])
def test_qualquer_diferenca_fica_sem_conta(tmp_path, conta):
    r = _rotina(tmp_path, tiny=_Tiny(contas=[conta]))
    r.sincronizar()
    r.casar()
    assert _b(r)["situacao"] == dda.SIT_SEM_CONTA and "conta_id" not in _b(r)


def test_sacador_avalista_tambem_casa(tmp_path):
    r = _rotina(tmp_path, polp=_Polp([_boleto_polp(emissor="00000000000191", sacador=FORNECEDOR)]))
    r.sincronizar()
    r.casar()
    assert _b(r)["situacao"] == dda.SIT_CASADO


def test_duas_contas_iguais_ficam_para_escolher_no_painel(tmp_path):
    r = _rotina(tmp_path, tiny=_Tiny(contas=[_conta(10), _conta(11)]))
    r.sincronizar()
    r.casar()
    assert _b(r)["situacao"] == dda.SIT_AMBIGUO
    assert [c["id"] for c in _b(r)["candidatos"]] == [10, 11]


def test_uma_conta_nao_serve_a_dois_boletos(tmp_path):
    r = _rotina(tmp_path, polp=_Polp([_boleto_polp("b1"), _boleto_polp("b2")]))
    r.sincronizar()
    r.casar()
    assert sorted(b["situacao"] for b in r.estado.ler()["boletos"].values()) == [dda.SIT_CASADO, dda.SIT_SEM_CONTA]


# --- agendamento -----------------------------------------------------------------------------


def _casado(tmp_path, validar=True, **kw):
    r = _rotina(tmp_path, **kw)
    r.sincronizar()
    r.casar()
    if validar:
        r.validar(list(r.estado.ler()["boletos"]), "Gerente")
    return r


def test_casamento_automatico_so_agenda_depois_de_validado(tmp_path):
    inter = _Inter()
    r = _casado(tmp_path, validar=False, inter=inter)
    assert r.agendar() == {"agendados": 0, "vencidos": 0, "erros": 0, "aguardando_validacao": 1}
    assert inter.pagamentos == [] and _b(r)["situacao"] == dda.SIT_CASADO
    assert r.validar(["b1", "xx"], "Gerente") == {"validados": ["b1"], "recusados": [{"id": "xx", "motivo": "Boleto não encontrado."}]}
    assert _b(r)["validacao"]["por"] == "Gerente"
    assert r.agendar()["agendados"] == 1


def test_validar_so_vale_para_casado(tmp_path):
    r = _rotina(tmp_path, tiny=_Tiny(contas=[]))
    r.sincronizar()
    r.casar()
    assert r.validar(["b1"], "Gerente")["recusados"][0]["id"] == "b1"


def test_conta_escolhida_ou_criada_no_painel_ja_vem_validada(tmp_path):
    r = _rotina(tmp_path, tiny=_Tiny(contas=[]))
    r.sincronizar()
    r.casar()
    r.criar_conta("b1", 321, "", "Fulano")
    assert _b(r)["validacao"]["por"] == "Fulano"


def test_reabrir_exige_nova_validacao(tmp_path):
    inter = _Inter()
    r = _casado(tmp_path, inter=inter)
    r.agendar()
    inter.status = "CANCELADO"
    r.acompanhar()
    r.reabrir("b1", "Fulano")
    assert "validacao" not in _b(r)


def test_criar_contas_em_lote_segue_apos_falha(tmp_path):
    tiny = _Tiny(contas=[])
    r = _rotina(tmp_path, polp=_Polp([_boleto_polp("b1"), _boleto_polp("b2", valor_cent=999)]), tiny=tiny)
    r.sincronizar()
    r.casar()
    res = r.criar_contas_lote([
        {"boleto_id": "nao-existe", "categoria_id": 1},
        {"boleto_id": "b1", "categoria_id": 321, "historico": "x"},
        {"boleto_id": "b2", "categoria_id": 321},
    ], "Fulano")
    assert (res["total_sucessos"], res["total_falhas"]) == (2, 1)
    assert [x["situacao"] for x in r.boletos()] == [dda.SIT_CASADO, dda.SIT_CASADO]


def test_agenda_no_inter_para_o_vencimento_pelo_valor_original(tmp_path):
    inter = _Inter()
    r = _casado(tmp_path, inter=inter)
    assert r.agendar() == {"agendados": 1, "vencidos": 0, "erros": 0, "aguardando_validacao": 0}
    assert inter.pagamentos == [("norvia_campinas", BARRAS, Decimal("1500.00"), date(2026, 11, 20), date(2026, 11, 20), FORNECEDOR)]
    assert (_b(r)["situacao"], _b(r)["inter"]["codigo_transacao"]) == (dda.SIT_AGENDADO, "tx-1")
    assert r.estado.ler()["avisos"][-1]["tipo"] == "agendado"


def test_ja_incluido_no_inter_e_adotado_sem_novo_pagamento(tmp_path):
    inter = _Inter(existentes=[{"codigoTransacao": "tx-antigo", "statusPagamento": "AGUARDANDO_APROVACAO"}])
    r = _casado(tmp_path, inter=inter)
    r.agendar()
    assert inter.pagamentos == []
    assert _b(r)["inter"]["codigo_transacao"] == "tx-antigo"


def test_resposta_incerta_do_inter_procura_antes_de_repetir(tmp_path):
    inter = _Inter(incerto=True)
    r = _casado(tmp_path, inter=inter)
    r.agendar()
    assert len(inter.pagamentos) == 1
    assert (_b(r)["situacao"], _b(r)["inter"]["codigo_transacao"]) == (dda.SIT_AGENDADO, "tx-incerto")


def test_vencido_nao_agenda(tmp_path):
    inter = _Inter()
    r = _casado(tmp_path, inter=inter, polp=_Polp([_boleto_polp(venc="2026-11-10")]), tiny=_Tiny(contas=[_conta(10, venc="2026-11-10")]))
    assert r.agendar()["vencidos"] == 1
    assert inter.pagamentos == [] and _b(r)["situacao"] == dda.SIT_VENCIDO


def test_conta_paga_a_mao_no_tiny_nao_agenda(tmp_path):
    inter = _Inter()
    tiny = _Tiny()
    r = _casado(tmp_path, inter=inter, tiny=tiny)
    tiny.situacao = "pago"
    r.agendar()
    assert inter.pagamentos == [] and _b(r)["situacao"] == dda.SIT_ENCERRADO


def test_desligado_so_casa(tmp_path):
    inter = _Inter()
    r = _rotina(tmp_path, inter=inter, agendar=False)
    resumo = r.executar("manual")
    assert "desligado" in resumo["agendar"] and inter.pagamentos == []
    assert _b(r)["situacao"] == dda.SIT_CASADO


# --- acompanhamento e baixa ------------------------------------------------------------------


def test_pago_no_inter_baixa_a_conta_no_tiny(tmp_path):
    inter = _Inter()
    tiny = _Tiny()
    r = _casado(tmp_path, inter=inter, tiny=tiny)
    r.agendar()
    inter.status = "PAGO"
    assert r.acompanhar() == {"pagos": 1, "baixados": 1, "recusados": 0}
    baixa = tiny.baixas[0]
    assert (baixa["conta_id"], baixa["valor_pago"], baixa["data_pagamento"], baixa["conta_origem_id"], baixa["juros"], baixa["desconto"]) == (
        10, 1500.0, "2026-11-20", 777, 0.0, 0.0)
    assert _b(r)["situacao"] == dda.SIT_BAIXADO


def test_aguardando_aprovacao_so_atualiza(tmp_path):
    tiny = _Tiny()
    r = _casado(tmp_path, tiny=tiny)
    r.agendar()
    assert r.acompanhar() == {"pagos": 0, "baixados": 0, "recusados": 0}
    assert _b(r)["situacao"] == dda.SIT_AGENDADO and tiny.baixas == []


def test_recusado_avisa_e_pode_ser_reaberto(tmp_path):
    inter = _Inter()
    r = _casado(tmp_path, inter=inter)
    r.agendar()
    inter.status = "CANCELADO"
    assert r.acompanhar()["recusados"] == 1
    assert _b(r)["situacao"] == dda.SIT_RECUSADO
    assert r.estado.ler()["avisos"][-1]["tipo"] == "recusado"
    r.reabrir("b1", "Fulano")
    assert _b(r)["situacao"] == dda.SIT_CASADO and _b(r)["inter_anteriores"][0]["codigo_transacao"] == "tx-1"


def test_conta_ja_baixada_a_mao_nao_baixa_de_novo(tmp_path):
    inter = _Inter()
    tiny = _Tiny()
    r = _casado(tmp_path, inter=inter, tiny=tiny)
    r.agendar()
    inter.status = "PAGO"
    tiny.situacao = "pago"
    r.acompanhar()
    assert tiny.baixas == [] and _b(r)["situacao"] == dda.SIT_BAIXADO


# --- painel ----------------------------------------------------------------------------------


def test_escolher_conta_exige_o_mesmo_valor(tmp_path):
    r = _rotina(tmp_path, tiny=_Tiny(contas=[_conta(10), _conta(11), _conta(12, valor=10.0)]))
    r.sincronizar()
    r.casar()
    with pytest.raises(ValueError, match="R\\$"):
        r.vincular_conta("b1", 12, "Fulano")
    r.vincular_conta("b1", 11, "Fulano")
    assert (_b(r)["situacao"], _b(r)["conta_id"]) == (dda.SIT_CASADO, 11)


def test_criar_conta_pelo_painel_usa_o_contato_do_cnpj(tmp_path):
    tiny = _Tiny(contas=[])
    r = _rotina(tmp_path, tiny=tiny)
    r.sincronizar()
    r.casar()
    r.criar_conta("b1", 321, "Boleto aluguel", "Fulano")
    criada = tiny.criadas[0]
    assert (criada["contato_id"], criada["categoria_id"], criada["valor"], criada["data_vencimento"]) == (
        5, 321, Decimal("1500.00"), "2026-11-20")
    assert (_b(r)["situacao"], _b(r)["conta_id"]) == (dda.SIT_CASADO, 99)


def test_sem_contato_no_tiny_nao_cria(tmp_path):
    tiny = _Tiny(contas=[], contatos=[])
    r = _rotina(tmp_path, tiny=tiny)
    r.sincronizar()
    r.casar()
    with pytest.raises(ValueError, match="não cria contatos"):
        r.criar_conta("b1", 321, "", "Fulano")
    assert tiny.criadas == []


def test_criacao_incerta_trava_nova_tentativa(tmp_path):
    tiny = _Tiny(contas=[], incerto=True)
    r = _rotina(tmp_path, tiny=tiny)
    r.sincronizar()
    r.casar()
    with pytest.raises(LancamentoCaixaIncerto):
        r.criar_conta("b1", 321, "", "Fulano")
    with pytest.raises(ValueError, match="sem confirmação"):
        r.criar_conta("b1", 321, "", "Fulano")
    assert len(tiny.criadas) == 1


def test_agendado_nao_pode_ser_descartado(tmp_path):
    r = _casado(tmp_path)
    r.agendar()
    with pytest.raises(ValueError, match="Internet Banking"):
        r.descartar("b1", "", "Fulano")


def test_categorias_do_tiny_da_empresa(tmp_path):
    r = _rotina(tmp_path)
    assert [c["nome"] for c in r.categorias("norvia_campinas")] == ["Aluguel", "Energia"]
    with pytest.raises(ValueError):
        r.categorias("outra")


def test_tarefa_do_dda_nao_aparece_na_rota_das_outras_conciliacoes():
    from fastapi import HTTPException

    from app.routers import jobs

    job = jobs._iniciar_job("dda_executar", lambda progresso: {"erros": []}, sincrono=True)
    assert jobs._consultar_job(job["job_id"], dominio="dda")["status"] == "concluido"
    for kw in ({"conciliacao_ml": True}, {"conciliacao_ml": False}):
        with pytest.raises(HTTPException):
            jobs._consultar_job(job["job_id"], **kw)
