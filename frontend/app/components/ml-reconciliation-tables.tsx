"use client";

import { memo } from "react";

// Tabelas das abas da Conciliação ML (ml-reconciliation-view.tsx). Cada uma recebe as linhas
// já filtradas e o estado de filtros/seleção da tela; estados vazios e barras ficam na tela.

import { ColumnFilterHeader } from "./column-filter";
import { contarValores, obterValoresUnicos, type ColumnFilterValue, type ColumnFiltersState } from "@/lib/column-filters";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { money } from "@/lib/formatters";
import type { MlAnalise, MlComparativo, MlGrupo, MlLancamento, MlPendencia } from "@/lib/ml-reconciliation-contracts";
import { casamentoMeta, pendenciaMotivoMeta, podeBaixar, situacaoMeta } from "@/lib/ml-reconciliation-helpers";
import { RECEBIMENTOS_DEFS, VENDAS_DEFS, LANCAMENTOS_DEFS, PENDENCIAS_DEFS } from "./ml-reconciliation-view-parts";

type MlTabFiltrada = "recebimentos" | "vendas" | "lancamentos" | "pendencias";
export type MlColFilters = Record<MlTabFiltrada, ColumnFiltersState>;
export type MlUpdateColFilter = (tabId: MlTabFiltrada, id: string, val: ColumnFilterValue | undefined) => void;

const RecebimentoRow = memo(function RecebimentoRow({ g, marcado, alternar }: { g: MlGrupo; marcado: boolean; alternar: (id: string) => void; }) {
  const meta = situacaoMeta(g.situacao);
  return (
    <TableRow
      data-state={marcado ? "selected" : undefined}
      onClick={podeBaixar(g) ? () => alternar(g.id) : undefined}
      className={cn("align-top", podeBaixar(g) && "cursor-pointer")}
    >
      <TableCell>
        {podeBaixar(g) && (
          <Checkbox
            checked={marcado}
            onCheckedChange={() => alternar(g.id)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Selecionar ${g.nome_cliente}, venda ${g.id_venda}`}
          />
        )}
      </TableCell>
      <TableCell className="tabular-nums">
        {g.data}
        {g.data_venda && g.data_venda !== g.data && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">venda {g.data_venda}</div>
        )}
      </TableCell>
      <TableCell>
        <div className="max-w-56 whitespace-normal font-medium text-foreground">{g.nome_cliente || "—"}</div>
      </TableCell>
      <TableCell>
        <code>{g.id_venda || "sem venda"}</code>
        {g.mlb && <div className="mt-0.5 text-[11px] font-mono text-muted-foreground">{g.mlb}</div>}
        {g.quantidade_movimentos > 1 && (
          <div className="mt-1">
            <Badge variant="secondary">{g.quantidade_movimentos} liberações</Badge>
          </div>
        )}
      </TableCell>
      <TableCell className="text-right font-semibold tabular-nums">{money(g.valor_total)}</TableCell>
      <TableCell>
        {g.contas_vinculadas && g.contas_vinculadas.length > 1 ? (
          <div className="max-w-72 whitespace-normal space-y-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <Badge variant="outline" className="text-[10px] font-mono border-primary/40 text-primary">
                {g.contas_vinculadas.length} parcelas
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                {g.conta_saldo !== null && `saldo ${money(g.conta_saldo)}`}
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground font-mono">
              {g.contas_vinculadas.map((c) => `#${c.id}${c.numero ? ` (${c.numero}ª)` : ""}`).join(", ")}
            </div>
            <p className="line-clamp-2 text-[11px] text-muted-foreground" title={g.conta_historico}>
              {g.conta_historico}
            </p>
          </div>
        ) : g.conta_id ? (
          <div className="max-w-72 whitespace-normal">
            <code>#{g.conta_id}</code>
            <span className="ml-1.5 text-[11px] text-muted-foreground">
              {g.conta_valor !== null && `valor ${money(g.conta_valor)}`}
              {g.conta_saldo !== null && ` · saldo ${money(g.conta_saldo)}`}
            </span>
            <p className="line-clamp-2 text-[11px] text-muted-foreground" title={g.conta_historico}>
              {g.conta_historico}
            </p>
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <div className="max-w-60 space-y-1 whitespace-normal">
          <Badge variant={meta.tone}>{meta.label}</Badge>
          {g.mensagem && (
            <p className="line-clamp-2 text-[11px] text-muted-foreground" title={g.mensagem}>
              {g.mensagem}
            </p>
          )}
        </div>
      </TableCell>
    </TableRow>
          
  );
});

export function RecebimentosTable({
  analise,
  colFilters,
  updateColFilter,
  gruposFiltrados,
  limite,
  selecionados,
  alternar,
  alternarTodos,
  aptosVisiveis,
  todosVisiveisMarcados,
  algunsVisiveisMarcados,
}: {
  analise: MlAnalise;
  colFilters: MlColFilters;
  updateColFilter: MlUpdateColFilter;
  limite: number;
  gruposFiltrados: MlGrupo[];
  selecionados: Set<string>;
  alternar: (id: string) => void;
  alternarTodos: () => void;
  aptosVisiveis: MlGrupo[];
  todosVisiveisMarcados: boolean;
  algunsVisiveisMarcados: boolean;
}) {
  return (
    <Table className="min-w-[900px]">
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <Checkbox
              checked={todosVisiveisMarcados}
              indeterminate={algunsVisiveisMarcados && !todosVisiveisMarcados}
              onCheckedChange={alternarTodos}
              disabled={aptosVisiveis.length === 0}
              aria-label="Selecionar todos os aptos"
            />
          </TableHead>
          <TableHead>
            <ColumnFilterHeader
              title="Liberação"
              def={RECEBIMENTOS_DEFS.data}
              value={colFilters.recebimentos.data}
              onChange={(v) => updateColFilter("recebimentos", "data", v)}
            />
          </TableHead>
          <TableHead>
            <ColumnFilterHeader
              title="Cliente"
              def={RECEBIMENTOS_DEFS.cliente}
              value={colFilters.recebimentos.cliente}
              onChange={(v) => updateColFilter("recebimentos", "cliente", v)}
            />
          </TableHead>
          <TableHead>
            <ColumnFilterHeader
              title="Venda"
              def={RECEBIMENTOS_DEFS.venda}
              value={colFilters.recebimentos.venda}
              onChange={(v) => updateColFilter("recebimentos", "venda", v)}
            />
          </TableHead>
          <TableHead className="text-right">
            <ColumnFilterHeader
              title="Recebido (bruto)"
              align="right"
              def={RECEBIMENTOS_DEFS.valor}
              value={colFilters.recebimentos.valor}
              onChange={(v) => updateColFilter("recebimentos", "valor", v)}
            />
          </TableHead>
          <TableHead>
            <ColumnFilterHeader
              title="Conta a receber (Tiny)"
              def={RECEBIMENTOS_DEFS.conta}
              value={colFilters.recebimentos.conta}
              onChange={(v) => updateColFilter("recebimentos", "conta", v)}
            />
          </TableHead>
          <TableHead>
            <ColumnFilterHeader
              title="Situação"
              def={RECEBIMENTOS_DEFS.situacao}
              value={colFilters.recebimentos.situacao}
              onChange={(v) => updateColFilter("recebimentos", "situacao", v)}
              uniqueValues={obterValoresUnicos(analise.grupos, RECEBIMENTOS_DEFS.situacao.accessor)}
              counts={contarValores(analise.grupos, RECEBIMENTOS_DEFS.situacao.accessor)}
            />
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {gruposFiltrados.slice(0, limite).map((g) => <RecebimentoRow key={g.id} g={g} marcado={selecionados.has(g.id)} alternar={alternar} />)}
      </TableBody>
    </Table>
  );
}

const VendaRow = memo(function VendaRow({ c }: { c: MlComparativo; }) {
  const meta = casamentoMeta(c.casou_por);
  return (
    <TableRow className="align-top">
      <TableCell className="tabular-nums">{c.data}</TableCell>
      <TableCell>
        <code>{c.id_pagamento || "—"}</code>
      </TableCell>
      <TableCell>
        {c.id_pedido ? (
          <>
            <code>{c.id_pedido}</code>
            {c.id_pacote && <div className="text-[11px] text-muted-foreground">pacote {c.id_pacote}</div>}
            {c.mlb && <div className="text-[11px] font-mono text-muted-foreground">{c.mlb}</div>}
            {c.status_venda && <div className="text-[11px] text-muted-foreground">{c.status_venda}</div>}
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="max-w-48 whitespace-normal">{c.nome_cliente || "—"}</TableCell>
      <TableCell className="text-right tabular-nums">{money(c.valor_liberado)}</TableCell>
      <TableCell>
        <div className="max-w-72 space-y-1 whitespace-normal">
          <Badge variant={meta.tone}>{meta.label}</Badge>
          {c.observacao && <p className="text-[11px] text-muted-foreground">{c.observacao}</p>}
        </div>
      </TableCell>
    </TableRow>
          
  );
});

export function VendasTable({
  analise,
  colFilters,
  updateColFilter,
  comparativoFiltrado,
  limite,
}: {
  analise: MlAnalise;
  colFilters: MlColFilters;
  updateColFilter: MlUpdateColFilter;
  limite: number;
  comparativoFiltrado: MlComparativo[];
}) {
  return (
    <Table className="min-w-[980px]">
      <TableHeader>
        <TableRow>
          <TableHead>
            <ColumnFilterHeader
              title="Liberação"
              def={VENDAS_DEFS.data}
              value={colFilters.vendas.data}
              onChange={(v) => updateColFilter("vendas", "data", v)}
            />
          </TableHead>
          <TableHead>
            <ColumnFilterHeader
              title="Pagamento (MP)"
              def={VENDAS_DEFS.pagamento}
              value={colFilters.vendas.pagamento}
              onChange={(v) => updateColFilter("vendas", "pagamento", v)}
            />
          </TableHead>
          <TableHead>
            <ColumnFilterHeader
              title="Venda (ML)"
              def={VENDAS_DEFS.venda}
              value={colFilters.vendas.venda}
              onChange={(v) => updateColFilter("vendas", "venda", v)}
            />
          </TableHead>
          <TableHead>
            <ColumnFilterHeader
              title="Cliente (Tiny)"
              def={VENDAS_DEFS.cliente}
              value={colFilters.vendas.cliente}
              onChange={(v) => updateColFilter("vendas", "cliente", v)}
            />
          </TableHead>
          <TableHead className="text-right">
            <ColumnFilterHeader
              title="Líquido liberado"
              align="right"
              def={VENDAS_DEFS.valor}
              value={colFilters.vendas.valor}
              onChange={(v) => updateColFilter("vendas", "valor", v)}
            />
          </TableHead>
          <TableHead>
            <ColumnFilterHeader
              title="Ligação"
              def={VENDAS_DEFS.ligacao}
              value={colFilters.vendas.ligacao}
              onChange={(v) => updateColFilter("vendas", "ligacao", v)}
              uniqueValues={obterValoresUnicos(analise.comparativo, VENDAS_DEFS.ligacao.accessor)}
              counts={contarValores(analise.comparativo, VENDAS_DEFS.ligacao.accessor)}
            />
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {comparativoFiltrado.slice(0, limite).map((c) => <VendaRow key={`${c.id_pagamento}-${c.data}`} c={c} />)}
      </TableBody>
    </Table>
  );
}

const LancamentoRow = memo(function LancamentoRow({ l }: { l: MlLancamento; }) {
  
  return (
    <TableRow className="align-top">
      <TableCell className="tabular-nums">{l.data}</TableCell>
      <TableCell>
        <Badge variant={l.tipo === "C" ? "success" : "secondary"}>
          {l.tipo === "C" ? "Recebimento MP" : "Pagamento MP"}
        </Badge>
      </TableCell>
      <TableCell className="whitespace-normal">{l.categoria}</TableCell>
      <TableCell>
        <p className="line-clamp-2 max-w-96 whitespace-normal text-[11px]" title={l.historico}>
          {l.historico}
        </p>
      </TableCell>
      <TableCell>
        <div className="max-w-48 whitespace-normal">{l.contato || "—"}</div>
        {l.cnpj && <code className="text-[11px]">{l.cnpj}</code>}
      </TableCell>
      <TableCell
        className={cn(
          "text-right font-semibold tabular-nums",
          l.tipo === "C" ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
        )}
      >
        {l.tipo === "C" ? "+" : "−"}
        {money(l.valor)}
      </TableCell>
    </TableRow>
        
  );
});

export function LancamentosTable({
  analise,
  colFilters,
  updateColFilter,
  lancamentosFiltrados,
  limite,
}: {
  analise: MlAnalise;
  colFilters: MlColFilters;
  updateColFilter: MlUpdateColFilter;
  limite: number;
  lancamentosFiltrados: MlLancamento[];
}) {
  return (
    <Table className="min-w-[980px]">
      <TableHeader>
        <TableRow>
          <TableHead>
            <ColumnFilterHeader
              title="Data"
              def={LANCAMENTOS_DEFS.data}
              value={colFilters.lancamentos.data}
              onChange={(v) => updateColFilter("lancamentos", "data", v)}
            />
          </TableHead>
          <TableHead>
            <ColumnFilterHeader
              title="Fluxo MP"
              def={LANCAMENTOS_DEFS.fluxo}
              value={colFilters.lancamentos.fluxo}
              onChange={(v) => updateColFilter("lancamentos", "fluxo", v)}
              uniqueValues={["Recebimento MP", "Pagamento MP"]}
            />
          </TableHead>
          <TableHead>
            <ColumnFilterHeader
              title="Categoria"
              def={LANCAMENTOS_DEFS.categoria}
              value={colFilters.lancamentos.categoria}
              onChange={(v) => updateColFilter("lancamentos", "categoria", v)}
              uniqueValues={obterValoresUnicos(analise.lancamentos, LANCAMENTOS_DEFS.categoria.accessor)}
              counts={contarValores(analise.lancamentos, LANCAMENTOS_DEFS.categoria.accessor)}
            />
          </TableHead>
          <TableHead>
            <ColumnFilterHeader
              title="Histórico"
              def={LANCAMENTOS_DEFS.historico}
              value={colFilters.lancamentos.historico}
              onChange={(v) => updateColFilter("lancamentos", "historico", v)}
            />
          </TableHead>
          <TableHead>
            <ColumnFilterHeader
              title="Contato"
              def={LANCAMENTOS_DEFS.contato}
              value={colFilters.lancamentos.contato}
              onChange={(v) => updateColFilter("lancamentos", "contato", v)}
            />
          </TableHead>
          <TableHead className="text-right">
            <ColumnFilterHeader
              title="Valor"
              align="right"
              def={LANCAMENTOS_DEFS.valor}
              value={colFilters.lancamentos.valor}
              onChange={(v) => updateColFilter("lancamentos", "valor", v)}
            />
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lancamentosFiltrados.slice(0, limite).map((l) => <LancamentoRow key={l.indice} l={l} />)}
      </TableBody>
    </Table>
  );
}

const PendenciaRow = memo(function PendenciaRow({ p }: { p: MlPendencia; }) {
  const meta = pendenciaMotivoMeta(p.motivo);
  const ehRecebimento = p.valor >= 0;
  return (
    <TableRow className="align-top">
      <TableCell className="tabular-nums">{p.data}</TableCell>
      <TableCell>
        <Badge variant={ehRecebimento ? "success" : "secondary"}>
          {ehRecebimento ? "Recebimento MP" : "Pagamento MP"}
        </Badge>
      </TableCell>
      <TableCell className="whitespace-normal font-medium">{p.tipo_operacao}</TableCell>
      <TableCell>
        <code>{p.operacao_relacionada || "—"}</code>
        {p.id_venda && <div className="text-[11px] text-muted-foreground">venda {p.id_venda}</div>}
        {p.nome_cliente && <div className="text-[11px] text-muted-foreground">{p.nome_cliente}</div>}
      </TableCell>
      <TableCell
        className={cn(
          "text-right tabular-nums font-semibold",
          ehRecebimento ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
        )}
      >
        {ehRecebimento ? "+" : "−"}
        {money(Math.abs(p.valor))}
      </TableCell>
      <TableCell className="max-w-80 whitespace-normal">
        <div className="space-y-1">
          <Badge variant={meta.tone}>{meta.label}</Badge>
          <p className="text-[11px] text-muted-foreground">{p.motivo}</p>
        </div>
      </TableCell>
    </TableRow>
          
  );
});

export function PendenciasTable({
  analise,
  colFilters,
  updateColFilter,
  pendenciasFiltradas,
  limite,
}: {
  analise: MlAnalise;
  colFilters: MlColFilters;
  updateColFilter: MlUpdateColFilter;
  limite: number;
  pendenciasFiltradas: MlPendencia[];
}) {
  return (
    <Table className="min-w-[920px]">
      <TableHeader>
        <TableRow>
          <TableHead>
            <ColumnFilterHeader
              title="Data"
              def={PENDENCIAS_DEFS.data}
              value={colFilters.pendencias.data}
              onChange={(v) => updateColFilter("pendencias", "data", v)}
            />
          </TableHead>
          <TableHead>
            <ColumnFilterHeader
              title="Fluxo MP"
              def={PENDENCIAS_DEFS.fluxo}
              value={colFilters.pendencias.fluxo}
              onChange={(v) => updateColFilter("pendencias", "fluxo", v)}
              uniqueValues={["Recebimento MP", "Pagamento MP"]}
            />
          </TableHead>
          <TableHead>
            <ColumnFilterHeader
              title="Tipo de operação"
              def={PENDENCIAS_DEFS.tipo_operacao}
              value={colFilters.pendencias.tipo_operacao}
              onChange={(v) => updateColFilter("pendencias", "tipo_operacao", v)}
              uniqueValues={obterValoresUnicos(analise.pendencias, PENDENCIAS_DEFS.tipo_operacao.accessor)}
              counts={contarValores(analise.pendencias, PENDENCIAS_DEFS.tipo_operacao.accessor)}
            />
          </TableHead>
          <TableHead>
            <ColumnFilterHeader
              title="Pagamento / venda"
              def={PENDENCIAS_DEFS.referencia}
              value={colFilters.pendencias.referencia}
              onChange={(v) => updateColFilter("pendencias", "referencia", v)}
            />
          </TableHead>
          <TableHead className="text-right">
            <ColumnFilterHeader
              title="Valor"
              align="right"
              def={PENDENCIAS_DEFS.valor}
              value={colFilters.pendencias.valor}
              onChange={(v) => updateColFilter("pendencias", "valor", v)}
            />
          </TableHead>
          <TableHead>
            <ColumnFilterHeader
              title="Motivo da pendência"
              def={PENDENCIAS_DEFS.motivo}
              value={colFilters.pendencias.motivo}
              onChange={(v) => updateColFilter("pendencias", "motivo", v)}
            />
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {pendenciasFiltradas.slice(0, limite).map((p) => <PendenciaRow key={p.indice} p={p} />)}
      </TableBody>
    </Table>
  );
}
