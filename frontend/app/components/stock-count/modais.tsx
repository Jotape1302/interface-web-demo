'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  
  Trash2, 
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import type { StockCountService } from '@/lib/stock-count-service';
import {
  type StockCountConferencia,
  type StockCountConsultaTiny,
  type StockCountEnvioTiny,
  type StockCountItem,
  type StockCountSkuManual,
} from '@/lib/stock-count-contracts';
import { ReportarErro } from '@/components/reportar-erro';
import { formatDataBR, skuDoItem, NOME_COR, COR_BOLINHA, fmtUn, inteiroCampo } from './helpers';

export function ConferenciaContagem({
  item,
  service,
  podeConferir,
  porFardoPadrao,
  onConferida,
}: {
  item: StockCountItem;
  service: StockCountService;
  podeConferir: boolean;
  porFardoPadrao: number;
  onConferida: (conf: StockCountConferencia, tiny: StockCountEnvioTiny | null) => void;
}) {
  const pendente = item.status === 'aguardando_confirmacao';
  const [editando, setEditando] = useState(false);
  const [fardos, setFardos] = useState(String(item.quantidade_final ?? item.quantidade_detectada));
  // Com a cor do prendedor (desde 2026-10-15) o fardo é fixo: verde 5, rosa 10. Só contagens
  // antigas, sem cor, ainda pedem as unidades por fardo.
  const porFardoDaCor = item.cor ? item.unidades_por_fardo : undefined;
  const [porFardo, setPorFardo] = useState(String(porFardoDaCor ?? item.conferencia?.unidades_por_fardo ?? porFardoPadrao));
  const [soltas, setSoltas] = useState(String(item.conferencia?.unidades_soltas ?? 0));
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // Produto e saldo atual no Tiny: confere se o SKU é o certo e compara com a foto. Carrega sozinho
  // nas contagens pendentes; nas já conferidas, sob demanda (o Tiny limita as chamadas).
  const sku = skuDoItem(item);
  const [consulta, setConsulta] = useState<StockCountConsultaTiny | null>(null);
  const [consultando, setConsultando] = useState(false);
  const [erroConsulta, setErroConsulta] = useState<string | null>(null);

  const consultar = useCallback(
    async (atualizar: boolean, signal?: AbortSignal) => {
      setConsultando(true);
      setErroConsulta(null);
      try {
        setConsulta(await service.consultarTiny(item.id, atualizar, signal));
      } catch (e) {
        if (signal?.aborted) return;
        setErroConsulta(e instanceof Error ? e.message : 'Falha ao consultar o produto no Tiny.');
      } finally {
        if (!signal?.aborted) setConsultando(false);
      }
    },
    [service, item.id],
  );

  useEffect(() => {
    if (!sku || !pendente) return;
    const ctrl = new AbortController();
    // oxlint-disable-next-line react/react-compiler -- setState síncrono no efeito é intencional (reset/sincronização ao mudar a entrada); refatorar exigiria reestruturar o componente
    void consultar(false, ctrl.signal);
    return () => ctrl.abort();
  }, [sku, pendente, consultar]);

  const nFardos = inteiroCampo(fardos, 0);
  const nPorFardo = inteiroCampo(porFardo, 1);
  const nSoltas = inteiroCampo(soltas, 0);
  const valido = nFardos !== null && nPorFardo !== null && nSoltas !== null;
  const total = valido ? nFardos * nPorFardo + nSoltas : null;

  async function enviar() {
    if (!valido) return;
    setEnviando(true);
    setErro(null);
    try {
      const res = await service.conferir(item.id, { quantidade: nFardos, unidades_por_fardo: nPorFardo, unidades_soltas: nSoltas });
      onConferida(res.conferencia, res.tiny);
      setEditando(false);
      setConsulta(null); // o saldo do Tiny mudou com a entrada
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao conferir a contagem.');
    } finally {
      setEnviando(false);
    }
  }

  const campo = (rotulo: string, valor: string, set: (v: string) => void, minimo: number, largura = 'w-16') => (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{rotulo}</span>
      <Input
        type="number"
        min={minimo}
        step={1}
        value={valor}
        onChange={(e) => set(e.target.value)}
        className={`h-8 ${largura} rounded-none text-xs`}
        disabled={enviando}
      />
    </label>
  );

  const formAberto = (pendente || editando) && podeConferir;
  const contado = formAberto ? total : (item.conferencia?.unidades_total ?? null);

  return (
    <div className="space-y-2 border-t border-border pt-2.5 text-xs">
      {sku && (
        <div className="space-y-1 border border-border bg-background/60 p-2">
          {consulta ? (
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Produto no Tiny · {consulta.sku}
                  </span>
                  <span className="block font-medium text-foreground" title={consulta.produto}>
                    {consulta.produto || '(sem nome)'}
                  </span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 rounded-none px-2 text-[11px]"
                  disabled={consultando}
                  onClick={() => void consultar(true)}
                >
                  {consultando ? 'Atualizando…' : 'Atualizar'}
                </Button>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 tabular-nums">
                <span>
                  <span className="text-muted-foreground">Estoque no Tiny: </span>
                  <span className="font-semibold text-foreground">
                    {consulta.saldo === null ? '—' : `${fmtUn(consulta.saldo)} ${consulta.unidade || 'un'}`}
                  </span>
                  {consulta.deposito && <span className="text-muted-foreground"> · {consulta.deposito}</span>}
                </span>
                {contado !== null && (
                  <span>
                    <span className="text-muted-foreground">Contado na foto: </span>
                    <span className="font-semibold text-foreground">{fmtUn(contado)} un</span>
                  </span>
                )}
              </div>
              {consulta.saldo !== null && contado !== null && (
                <p className={contado > consulta.saldo ? 'text-[11px] text-foreground' : 'text-[11px] text-muted-foreground'}>
                  {contado > consulta.saldo
                    ? `Diferença: entram ${fmtUn(contado - consulta.saldo)} un no Tiny.`
                    : contado === consulta.saldo
                      ? 'Igual ao Tiny: nada a lançar.'
                      : `Tiny tem ${fmtUn(consulta.saldo - contado)} un a mais que a foto: nada é lançado nem retirado.`}
                </p>
              )}
              {consulta.aviso && <p className="text-[11px] text-amber-800 dark:text-amber-200">{consulta.aviso}</p>}
            </>
          ) : consultando ? (
            <span className="text-[11px] text-muted-foreground">Consultando o produto {sku} no Tiny…</span>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">SKU {sku}</span>
              <Button type="button" size="sm" variant="outline" className="h-7 rounded-none" onClick={() => void consultar(false)}>
                Ver produto e estoque no Tiny
              </Button>
            </div>
          )}
          {erroConsulta && <p className="text-[11px] text-destructive">{erroConsulta}</p>}
        </div>
      )}
      {!pendente && !editando && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            {item.conferencia
              ? `Conferida${item.conferencia.usuario_nome ? ` por ${item.conferencia.usuario_nome}` : ''} em ${formatDataBR(item.conferencia.conferida_em)}.`
              : 'Conferida pelo operador no Telegram.'}
          </span>
          {podeConferir && (
            <Button type="button" size="sm" variant="ghost" className="h-7 rounded-none" onClick={() => setEditando(true)}>
              Alterar quantidade
            </Button>
          )}
        </div>
      )}
      {formAberto && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void enviar();
          }}
        >
          <div className="flex flex-wrap items-end gap-2">
            {campo('Fardos', fardos, setFardos, 0)}
            <span className="pb-2 text-muted-foreground">×</span>
            {porFardoDaCor ? (
              <span className="flex flex-col gap-0.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Un. por fardo</span>
                <span className="flex h-8 items-center gap-1.5 text-sm font-semibold tabular-nums text-foreground" title={`Prendedor ${NOME_COR[item.cor!]}`}>
                  <span className={`h-2.5 w-2.5 ${COR_BOLINHA[item.cor!]}`} aria-hidden />
                  {porFardoDaCor}
                </span>
              </span>
            ) : (
              campo('Un. por fardo', porFardo, setPorFardo, 1)
            )}
            <span className="pb-2 text-muted-foreground">+</span>
            {campo('Un. soltas', soltas, setSoltas, 0)}
            <span className="pb-1.5 text-sm font-semibold tabular-nums text-foreground">= {total === null ? '—' : `${fmtUn(total)} un`}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" className="h-8 rounded-none" disabled={enviando || !valido}>
              {enviando ? 'Lançando no Tiny…' : nFardos === item.quantidade_detectada ? 'Confirmar' : 'Salvar correção'}
            </Button>
            {editando && (
              <Button type="button" size="sm" variant="ghost" className="h-8 rounded-none" disabled={enviando} onClick={() => setEditando(false)}>
                Cancelar
              </Button>
            )}
            <span className="text-[11px] text-muted-foreground">O Tiny recebe só a entrada do que faltar; nada é retirado.</span>
          </div>
        </form>
      )}
      {pendente && !podeConferir && <p className="text-[11px] text-muted-foreground">Aguardando conferência.</p>}
      {erro && <p className="text-[11px] text-destructive">{erro}</p>}
    </div>
  );
}

// Situação da contagem no estoque do Tiny, com reenvio quando falhou ou nunca foi enviada.
export function TinyContagem({
  item,
  service,
  podeConferir,
  onTiny,
}: {
  item: StockCountItem;
  service: StockCountService;
  podeConferir: boolean;
  onTiny: (tiny: StockCountEnvioTiny) => void;
}) {
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  if (!item.conferencia) return null;
  const tiny = item.tiny ?? null;
  const temSku = Boolean(item.codigo || item.sku_manual?.sku);

  async function reenviar() {
    setEnviando(true);
    setErro(null);
    try {
      onTiny(await service.enviarTiny(item.id));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao enviar ao Tiny.');
    } finally {
      setEnviando(false);
    }
  }

  let texto: string;
  let tom = 'text-muted-foreground';
  if (!tiny) {
    texto = temSku ? 'Ainda não enviada ao Tiny.' : 'Informe o SKU para lançar no Tiny.';
    if (!temSku) tom = 'text-amber-800 dark:text-amber-200';
  } else if (tiny.status === 'lancado') {
    texto = `Tiny${tiny.produto ? ` (${tiny.produto})` : ''}: entrada de ${fmtUn(tiny.entrada ?? 0)} un (saldo era ${fmtUn(tiny.saldo_anterior ?? 0)}, contado ${fmtUn(tiny.unidades)})${tiny.deposito ? ` · ${tiny.deposito}` : ''}.`;
    tom = 'text-emerald-800 dark:text-emerald-300';
  } else if (tiny.status === 'sem_entrada') {
    texto = `Tiny já tinha ${fmtUn(tiny.saldo_anterior ?? 0)} un (contado ${fmtUn(tiny.unidades)}): nada lançado.`;
  } else {
    texto = tiny.mensagem || 'Falha no envio ao Tiny.';
    tom = 'text-destructive';
  }
  const podeReenviar = podeConferir && temSku && (!tiny || tiny.status === 'erro');

  return (
    <div className="space-y-1.5 border-t border-border pt-2.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`text-[11px] ${tom}`} title={tiny ? `Enviado em ${formatDataBR(tiny.enviado_em)}` : undefined}>
          {texto}
        </span>
        {podeReenviar && (
          <Button type="button" size="sm" variant="outline" className="h-7 rounded-none" disabled={enviando} onClick={() => void reenviar()}>
            {enviando ? 'Enviando…' : tiny ? 'Reenviar ao Tiny' : 'Enviar ao Tiny'}
          </Button>
        )}
      </div>
      {erro && <p className="text-[11px] text-destructive">{erro}</p>}
      {(erro || tiny?.status === 'erro') && (
        <ReportarErro
          automationId="stock-count"
          executionId={`contagem-${item.id}`}
          stoppedNode="Lançamento no Tiny"
          errorMessage={erro ?? texto}
        />
      )}
    </div>
  );
}

// SKU informado pelo painel (contagem sem produto) e exclusão da tela, com confirmação inline
// (sem window.confirm). O registro do bot não é alterado: o gateway guarda SKU e exclusão no banco.
export function AcoesContagem({
  item,
  service,
  podeInformarSku,
  podeExcluir,
  onSku,
  onExcluida,
}: {
  item: StockCountItem;
  service: StockCountService;
  podeInformarSku: boolean;
  podeExcluir: boolean;
  onSku: (manual: StockCountSkuManual, tiny: StockCountEnvioTiny | null) => void;
  onExcluida: () => void;
}) {
  const [sku, setSku] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const semProduto = !item.codigo;

  async function salvarSku() {
    if (!sku.trim()) return;
    setEnviando(true);
    setErro(null);
    try {
      const res = await service.informarSku(item.id, sku);
      onSku(res.sku_manual, res.tiny);
      setSku('');
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao informar o SKU.');
    } finally {
      setEnviando(false);
    }
  }

  async function excluir() {
    setEnviando(true);
    setErro(null);
    try {
      await service.excluirContagem(item.id);
      onExcluida();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao excluir a contagem.');
      setEnviando(false);
    }
  }

  if (!semProduto && !podeExcluir) return null;

  return (
    <div className="space-y-2 border-t border-border pt-2.5 text-xs">
      {semProduto && !item.sku_manual && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-amber-800 dark:text-amber-200">
            O bot não identificou o produto desta contagem (sem SKU na legenda e sem código de barras lido).
          </p>
          {podeInformarSku && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void salvarSku();
              }}
            >
              <Input
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="Informe o SKU"
                maxLength={60}
                className="h-8 rounded-none font-mono text-xs"
                disabled={enviando}
              />
              <Button type="submit" size="sm" className="h-8 rounded-none" disabled={enviando || !sku.trim()}>
                Salvar SKU
              </Button>
            </form>
          )}
        </div>
      )}
      {item.sku_manual && (
        <p className="text-[11px] text-muted-foreground">
          SKU informado pelo painel{item.sku_manual.usuario_nome ? ` por ${item.sku_manual.usuario_nome}` : ''} em{' '}
          {formatDataBR(item.sku_manual.informado_em)}.
        </p>
      )}
      {podeExcluir && (
        <div className="flex items-center justify-end gap-2">
          {confirmando ? (
            <>
              <span className="text-[11px] text-muted-foreground">Tirar esta contagem da tela?</span>
              <Button type="button" size="sm" variant="outline" className="h-7 rounded-none" disabled={enviando} onClick={() => setConfirmando(false)}>
                Cancelar
              </Button>
              <Button type="button" size="sm" variant="destructive" className="h-7 rounded-none" disabled={enviando} onClick={() => void excluir()}>
                Confirmar exclusão
              </Button>
            </>
          ) : (
            <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 rounded-none text-muted-foreground" onClick={() => setConfirmando(true)}>
              <Trash2 size={13} /> Excluir contagem
            </Button>
          )}
        </div>
      )}
      {erro && <p className="text-[11px] text-destructive">{erro}</p>}
    </div>
  );
}
