"use client";

import { memo } from "react";

// Tabelas das abas da conciliação Inter × Tiny (reconciliation-view.tsx). Cada uma recebe as
// linhas já filtradas e o estado de filtros/seleção da tela; os estados vazios ficam na tela.

import { ArrowRight, Barcode } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatCnpjMask, formatDateBR, money } from "@/lib/formatters";
import { ColumnFilterHeader } from "./column-filter";
import {
  obterValoresUnicos,
  type ColumnFilterValue,
  type ColumnFiltersState,
} from "@/lib/column-filters";
import type {
  AlreadyPaidItem,
  InternalTransferItem,
  ReconciliationMatch,
  ReconciliationPreviewResponse,
  UnmatchedInterItem,
  UnmatchedTinyItem,
} from "@/lib/reconciliation-contracts";
import { MATCH_METHOD_META, formatConfidence } from "@/lib/reconciliation-helpers";
import {
  type TabId,
  TRANSFER_SITUACAO_META,
  MATCHES_DEFS,
  UNMATCHED_INTER_DEFS,
  UNMATCHED_TINY_DEFS,
  JA_BAIXADAS_DEFS,
  TRANSFERENCIAS_DEFS,
  SupplierCell,
} from "./reconciliation-view-parts";

/** Aba Casamentos: contas do Tiny que bateram com pagamentos do extrato (selecionáveis para baixa). */
const MatchRow = memo(function MatchRow({ m, isSelected, onToggle }: { m: ReconciliationMatch; isSelected: boolean; onToggle: (contaId: number) => void; }) {
  const hasDivergence = Math.abs(m.valor_pago - m.valor_tiny) > 0.05;
  const method = MATCH_METHOD_META[m.metodo_match];
  return (
    <TableRow
      data-state={isSelected ? "selected" : undefined}
      onClick={() => onToggle(m.conta_pagar_id)}
      className="cursor-pointer align-top"
    >
      <TableCell>
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggle(m.conta_pagar_id)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Selecionar ${m.fornecedor_nome}, documento ${m.numero_documento}`}
        />
      </TableCell>
      <TableCell>
        <Badge variant="outline">{m.empresa_nome}</Badge>
      </TableCell>
      <TableCell>
        <SupplierCell nome={m.fornecedor_nome} cnpj={m.fornecedor_cnpj} />
      </TableCell>
      <TableCell>
        <div className="font-medium">{m.numero_documento}</div>
        <code>#{m.conta_pagar_id}</code>
      </TableCell>
      <TableCell className="tabular-nums">
        <div>{formatDateBR(m.data_vencimento)}</div>
        <div className="text-xs text-emerald-700 dark:text-emerald-400">
          {formatDateBR(m.data_pagamento)}
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">{money(m.valor_tiny)}</TableCell>
      <TableCell className="text-right tabular-nums">
        <div className="font-semibold">{money(m.valor_pago)}</div>
        {hasDivergence && (m.juros > 0 || m.multa > 0 || m.desconto > 0) && (
          <div className="space-x-1.5 text-[11px]">
            {m.juros + m.multa > 0 && (
              <span className="text-amber-700 dark:text-amber-400">
                +{money(m.juros + m.multa)} {m.multa > 0 ? "juros/multa" : "juros"}
              </span>
            )}
            {m.desconto > 0 && (
              <span className="text-sky-700 dark:text-sky-400">−{money(m.desconto)} desc.</span>
            )}
          </div>
        )}
      </TableCell>
      <TableCell>
        <div className="max-w-60 space-y-1 whitespace-normal">
          <Badge variant={method?.tone ?? "secondary"}>
            {method?.label ?? m.metodo_match} · {formatConfidence(m.confianca)}
          </Badge>
          <p className="line-clamp-2 text-[11px] text-muted-foreground" title={m.motivo}>
            {m.motivo}
          </p>
        </div>
      </TableCell>
    </TableRow>
            
  );
});

export function MatchesTable({
  data, colFilters, updateColFilter, filteredMatches, selectedIds, toggleSelectOne, toggleSelectAll, allVisibleSelected, visibleSelectedCount,
}: {
  data: ReconciliationPreviewResponse;
  colFilters: Record<TabId, ColumnFiltersState>;
  updateColFilter: (tab: TabId, colId: string, val: ColumnFilterValue | undefined) => void;
  filteredMatches: ReconciliationMatch[];
  selectedIds: Set<number>;
  toggleSelectOne: (contaId: number) => void;
  toggleSelectAll: () => void;
  allVisibleSelected: boolean;
  visibleSelectedCount: number;
}) {
  return (
    <>
      <Table className="min-w-[980px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={allVisibleSelected}
                indeterminate={visibleSelectedCount > 0 && !allVisibleSelected}
                onCheckedChange={toggleSelectAll}
                aria-label={allVisibleSelected ? "Desmarcar todas" : "Selecionar todas"}
              />
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Empresa"
                def={MATCHES_DEFS.empresa}
                value={colFilters.matches.empresa}
                onChange={(v) => updateColFilter("matches", "empresa", v)}
                uniqueValues={obterValoresUnicos(data.matches ?? [], (m) => m.empresa_nome || m.empresa)}
              />
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Fornecedor"
                def={MATCHES_DEFS.fornecedor}
                value={colFilters.matches.fornecedor}
                onChange={(v) => updateColFilter("matches", "fornecedor", v)}
              />
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Documento"
                def={MATCHES_DEFS.documento}
                value={colFilters.matches.documento}
                onChange={(v) => updateColFilter("matches", "documento", v)}
              />
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Venc. / Pgto."
                def={MATCHES_DEFS.data_inter}
                value={colFilters.matches.data_inter}
                onChange={(v) => updateColFilter("matches", "data_inter", v)}
              />
            </TableHead>
            <TableHead className="text-right">
              <ColumnFilterHeader
                title="Valor Tiny"
                align="right"
                def={MATCHES_DEFS.valor_tiny}
                value={colFilters.matches.valor_tiny}
                onChange={(v) => updateColFilter("matches", "valor_tiny", v)}
              />
            </TableHead>
            <TableHead className="text-right">
              <ColumnFilterHeader
                title="Pago no Inter"
                align="right"
                def={MATCHES_DEFS.valor_inter}
                value={colFilters.matches.valor_inter}
                onChange={(v) => updateColFilter("matches", "valor_inter", v)}
              />
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Critério"
                def={MATCHES_DEFS.status}
                value={colFilters.matches.status}
                onChange={(v) => updateColFilter("matches", "status", v)}
                uniqueValues={obterValoresUnicos(data.matches ?? [], (m) => (m.metodo_match in MATCH_METHOD_META ? MATCH_METHOD_META[m.metodo_match].label : m.metodo_match))}
              />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredMatches.map((m) => <MatchRow key={m.id} m={m} isSelected={selectedIds.has(m.conta_pagar_id)} onToggle={toggleSelectOne} />)}
        </TableBody>
      </Table>
      <div className="table-footer">
        <span>
          Mostrando {filteredMatches.length} de {data.matches.length} casamento(s)
        </span>
        <span>Total casado: {money(filteredMatches.reduce((acc, m) => acc + m.valor_pago, 0))}</span>
      </div>
    </>
  );
}

/** Aba Só no Inter: pagamentos do extrato sem conta correspondente no Tiny. */
const UnmatchedInterRow = memo(function UnmatchedInterRow({ itx }: { itx: UnmatchedInterItem; }) {
  
  return (
    <TableRow className="align-top">
      <TableCell>
        <Badge variant="outline">{itx.empresa_nome}</Badge>
      </TableCell>
      <TableCell className="tabular-nums">{formatDateBR(itx.data_pagamento)}</TableCell>
      <TableCell>
        <SupplierCell
          nome={itx.nome_favorecido || itx.titulo || "Não informado"}
          cnpj={itx.cpf_cnpj_favorecido}
        />
      </TableCell>
      <TableCell>
        <p className="line-clamp-2 max-w-64 whitespace-normal text-xs" title={itx.descricao}>
          {itx.descricao || "—"}
        </p>
      </TableCell>
      <TableCell>
        <Badge variant="secondary">{itx.tipo_transacao}</Badge>
      </TableCell>
      <TableCell className="text-right font-semibold tabular-nums">{money(itx.valor_pago)}</TableCell>
      <TableCell>
        <code
          className="block max-w-56 truncate"
          title={itx.codigo_barras || itx.transacao_id}
        >
          {itx.codigo_barras ? (
            <span className="inline-flex items-center gap-1">
              <Barcode size={11} /> {itx.codigo_barras}
            </span>
          ) : (
            `ID ${itx.transacao_id}`
          )}
        </code>
      </TableCell>
    </TableRow>
          
  );
});

export function UnmatchedInterTable({
  data, colFilters, updateColFilter, filteredUnmatchedInter,
}: {
  data: ReconciliationPreviewResponse;
  colFilters: Record<TabId, ColumnFiltersState>;
  updateColFilter: (tab: TabId, colId: string, val: ColumnFilterValue | undefined) => void;
  filteredUnmatchedInter: UnmatchedInterItem[];
}) {
  return (
    <>
      <Table className="min-w-[900px]">
        <TableHeader>
          <TableRow>
            <TableHead>
              <ColumnFilterHeader
                title="Empresa"
                def={UNMATCHED_INTER_DEFS.empresa}
                value={colFilters.unmatched_inter.empresa}
                onChange={(v) => updateColFilter("unmatched_inter", "empresa", v)}
                uniqueValues={obterValoresUnicos(data.unmatched_inter ?? [], (i) => i.empresa_nome || i.empresa)}
              />
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Data pgto."
                def={UNMATCHED_INTER_DEFS.data}
                value={colFilters.unmatched_inter.data}
                onChange={(v) => updateColFilter("unmatched_inter", "data", v)}
              />
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Favorecido"
                def={UNMATCHED_INTER_DEFS.favorecido}
                value={colFilters.unmatched_inter.favorecido}
                onChange={(v) => updateColFilter("unmatched_inter", "favorecido", v)}
              />
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Descrição"
                def={UNMATCHED_INTER_DEFS.descricao}
                value={colFilters.unmatched_inter.descricao}
                onChange={(v) => updateColFilter("unmatched_inter", "descricao", v)}
              />
            </TableHead>
            <TableHead>Tipo</TableHead>
            <TableHead className="text-right">
              <ColumnFilterHeader
                title="Valor"
                align="right"
                def={UNMATCHED_INTER_DEFS.valor}
                value={colFilters.unmatched_inter.valor}
                onChange={(v) => updateColFilter("unmatched_inter", "valor", v)}
              />
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Código de barras / ID"
                def={UNMATCHED_INTER_DEFS.codigo}
                value={colFilters.unmatched_inter.codigo}
                onChange={(v) => updateColFilter("unmatched_inter", "codigo", v)}
              />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredUnmatchedInter.map((itx) => <UnmatchedInterRow key={itx.transacao_id} itx={itx} />)}
        </TableBody>
      </Table>
      <div className="table-footer">
        <span>
          Mostrando {filteredUnmatchedInter.length} de {data.unmatched_inter?.length ?? 0} débito(s)
        </span>
        <span>Total: {money(filteredUnmatchedInter.reduce((acc, itx) => acc + itx.valor_pago, 0))}</span>
      </div>
    </>
  );
}

/** Aba Só no Tiny: contas em aberto sem pagamento correspondente no extrato. */
const UnmatchedTinyRow = memo(function UnmatchedTinyRow({ c }: { c: UnmatchedTinyItem; }) {
  
  return (
    <TableRow className="align-top">
      <TableCell>
        <Badge variant="outline">{c.empresa_nome}</Badge>
      </TableCell>
      <TableCell className="tabular-nums">{formatDateBR(c.data_vencimento)}</TableCell>
      <TableCell>
        <SupplierCell nome={c.fornecedor_nome} cnpj={c.fornecedor_cnpj} />
      </TableCell>
      <TableCell>
        <div className="font-medium">{c.numero_documento}</div>
        <code>#{c.id}</code>
      </TableCell>
      <TableCell className="text-right font-semibold tabular-nums">{money(c.valor)}</TableCell>
      <TableCell>
        <p className="max-w-64 truncate text-xs text-muted-foreground" title={c.historico}>
          {c.historico || "—"}
        </p>
      </TableCell>
    </TableRow>
          
  );
});

export function UnmatchedTinyTable({
  data, colFilters, updateColFilter, filteredUnmatchedTiny,
}: {
  data: ReconciliationPreviewResponse;
  colFilters: Record<TabId, ColumnFiltersState>;
  updateColFilter: (tab: TabId, colId: string, val: ColumnFilterValue | undefined) => void;
  filteredUnmatchedTiny: UnmatchedTinyItem[];
}) {
  return (
    <>
      <Table className="min-w-[820px]">
        <TableHeader>
          <TableRow>
            <TableHead>
              <ColumnFilterHeader
                title="Empresa"
                def={UNMATCHED_TINY_DEFS.empresa}
                value={colFilters.unmatched_tiny.empresa}
                onChange={(v) => updateColFilter("unmatched_tiny", "empresa", v)}
                uniqueValues={obterValoresUnicos(data.unmatched_tiny ?? [], (c) => c.empresa_nome || c.empresa)}
              />
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Vencimento"
                def={UNMATCHED_TINY_DEFS.vencimento}
                value={colFilters.unmatched_tiny.vencimento}
                onChange={(v) => updateColFilter("unmatched_tiny", "vencimento", v)}
              />
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Fornecedor"
                def={UNMATCHED_TINY_DEFS.fornecedor}
                value={colFilters.unmatched_tiny.fornecedor}
                onChange={(v) => updateColFilter("unmatched_tiny", "fornecedor", v)}
              />
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Documento"
                def={UNMATCHED_TINY_DEFS.documento}
                value={colFilters.unmatched_tiny.documento}
                onChange={(v) => updateColFilter("unmatched_tiny", "documento", v)}
              />
            </TableHead>
            <TableHead className="text-right">
              <ColumnFilterHeader
                title="Valor em aberto"
                align="right"
                def={UNMATCHED_TINY_DEFS.valor}
                value={colFilters.unmatched_tiny.valor}
                onChange={(v) => updateColFilter("unmatched_tiny", "valor", v)}
              />
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Histórico"
                def={UNMATCHED_TINY_DEFS.historico}
                value={colFilters.unmatched_tiny.historico}
                onChange={(v) => updateColFilter("unmatched_tiny", "historico", v)}
              />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredUnmatchedTiny.map((c) => <UnmatchedTinyRow key={`${c.empresa}-${c.id}`} c={c} />)}
        </TableBody>
      </Table>
      <div className="table-footer">
        <span>
          Mostrando {filteredUnmatchedTiny.length} de {data.unmatched_tiny?.length ?? 0} conta(s)
        </span>
        <span>Total: {money(filteredUnmatchedTiny.reduce((acc, c) => acc + c.valor, 0))}</span>
      </div>
    </>
  );
}

/** Aba Já baixadas: pagamentos do extrato cuja conta já está paga no Tiny. */
const JaBaixadaRow = memo(function JaBaixadaRow({ p }: { p: AlreadyPaidItem; }) {
  const method = MATCH_METHOD_META[p.metodo_match];
  const diverge = Math.abs(p.valor_pago - p.valor_tiny) > 0.05;
  return (
    <TableRow className="align-top">
      <TableCell>
        <Badge variant="outline">{p.empresa_nome}</Badge>
      </TableCell>
      <TableCell className="tabular-nums">{formatDateBR(p.data_pagamento)}</TableCell>
      <TableCell>
        <SupplierCell nome={p.nome_favorecido || "Não informado"} cnpj={p.cpf_cnpj_favorecido} />
      </TableCell>
      <TableCell>
        <div className="min-w-40 max-w-64 whitespace-normal">
          <div className="font-medium text-foreground">
            Doc. {p.numero_documento || "—"} <code>#{p.conta_pagar_id}</code>
          </div>
          <div className="text-[11px] text-muted-foreground">{p.fornecedor_nome}</div>
        </div>
      </TableCell>
      <TableCell className="tabular-nums">{formatDateBR(p.data_vencimento)}</TableCell>
      <TableCell className="text-right tabular-nums">
        <div className="font-semibold">{money(p.valor_pago)}</div>
        <div
          className={cn(
            "text-[11px]",
            diverge ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
          )}
        >
          Tiny: {money(p.valor_tiny)}
        </div>
      </TableCell>
      <TableCell>
        <div className="max-w-60 space-y-1 whitespace-normal">
          <Badge variant="secondary">
            {method?.label ?? p.metodo_match} · {formatConfidence(p.confianca)}
          </Badge>
          <p className="line-clamp-2 text-[11px] text-muted-foreground" title={p.motivo}>
            {p.motivo}
          </p>
        </div>
      </TableCell>
    </TableRow>
            
  );
});

export function JaBaixadasTable({
  data, colFilters, updateColFilter, filteredJaBaixadas,
}: {
  data: ReconciliationPreviewResponse;
  colFilters: Record<TabId, ColumnFiltersState>;
  updateColFilter: (tab: TabId, colId: string, val: ColumnFilterValue | undefined) => void;
  filteredJaBaixadas: AlreadyPaidItem[];
}) {
  return (
    <>
      <p className="border-b border-border px-4 py-2 text-[11px] text-muted-foreground sm:px-5">
        Débitos do Banco Inter cuja conta correspondente já está paga no Tiny. Só para conferência:
        não há nada a baixar.
      </p>
      <Table className="min-w-[1040px]">
        <TableHeader>
          <TableRow>
            <TableHead>
              <ColumnFilterHeader
                title="Empresa"
                def={JA_BAIXADAS_DEFS.empresa}
                value={colFilters.ja_baixadas.empresa}
                onChange={(v) => updateColFilter("ja_baixadas", "empresa", v)}
                uniqueValues={obterValoresUnicos(data.ja_baixadas ?? [], (p) => p.empresa_nome || p.empresa)}
              />
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Data pgto."
                def={JA_BAIXADAS_DEFS.data_baixa}
                value={colFilters.ja_baixadas.data_baixa}
                onChange={(v) => updateColFilter("ja_baixadas", "data_baixa", v)}
              />
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Favorecido (Inter)"
                def={JA_BAIXADAS_DEFS.fornecedor}
                value={colFilters.ja_baixadas.fornecedor}
                onChange={(v) => updateColFilter("ja_baixadas", "fornecedor", v)}
              />
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Conta no Tiny"
                def={JA_BAIXADAS_DEFS.conta}
                value={colFilters.ja_baixadas.conta}
                onChange={(v) => updateColFilter("ja_baixadas", "conta", v)}
              />
            </TableHead>
            <TableHead>Vencimento</TableHead>
            <TableHead className="text-right">
              <ColumnFilterHeader
                title="Pago / Valor Tiny"
                align="right"
                def={JA_BAIXADAS_DEFS.valor}
                value={colFilters.ja_baixadas.valor}
                onChange={(v) => updateColFilter("ja_baixadas", "valor", v)}
              />
            </TableHead>
            <TableHead>Critério</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredJaBaixadas.map((p) => <JaBaixadaRow key={`${p.empresa}-${p.inter_transacao_id}-${p.conta_pagar_id}`} p={p} />)}
        </TableBody>
      </Table>
      <div className="table-footer">
        <span>
          Mostrando {filteredJaBaixadas.length} de {data.ja_baixadas?.length ?? 0} débito(s)
        </span>
        <span>Total: {money(filteredJaBaixadas.reduce((acc, p) => acc + p.valor_pago, 0))}</span>
      </div>
    </>
  );
}

/** Aba Transferências: débitos para outra empresa do grupo, conciliados com o Tiny. */
const TransferenciaRow = memo(function TransferenciaRow({ t, isSelected, onToggle }: { t: InternalTransferItem; isSelected: boolean; onToggle: (contaId: number) => void; }) {
  // Backend anterior não manda situação/conciliação: trata como "sem conta".
  const conta = t.conciliacao ?? t.conta_ja_baixada ?? null;
  const apta = t.situacao === "apta_baixa" && !!t.conciliacao;
  const situacao = TRANSFER_SITUACAO_META[t.situacao] ?? TRANSFER_SITUACAO_META.sem_conta;
  return (
    <TableRow
      data-state={isSelected ? "selected" : undefined}
      onClick={apta ? () => onToggle(t.conciliacao!.conta_pagar_id) : undefined}
      className={cn("align-top", apta && "cursor-pointer")}
    >
      <TableCell>
        {apta && (
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onToggle(t.conciliacao!.conta_pagar_id)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Selecionar transferência para ${t.empresa_destino_nome} de ${money(t.valor_pago)}`}
          />
        )}
      </TableCell>
      <TableCell>
        <div className="flex min-w-56 flex-wrap items-center gap-1.5">
          <Badge variant="outline">{t.empresa_nome}</Badge>
          <ArrowRight size={12} className="shrink-0 text-muted-foreground" aria-label="para" />
          <span className="font-medium text-foreground">{t.empresa_destino_nome}</span>
        </div>
        {t.cpf_cnpj_favorecido && (
          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            {formatCnpjMask(t.cpf_cnpj_favorecido)}
          </div>
        )}
      </TableCell>
      <TableCell className="tabular-nums">{formatDateBR(t.data_pagamento)}</TableCell>
      <TableCell className="text-right font-semibold tabular-nums">{money(t.valor_pago)}</TableCell>
      <TableCell>
        <div className="min-w-48 max-w-64 space-y-1 whitespace-normal">
          <Badge variant={situacao.tone}>{situacao.label}</Badge>
          {conta ? (
            <>
              <div className="text-xs font-medium text-foreground">
                Doc. {conta.numero_documento || "—"} <code>#{conta.conta_pagar_id}</code>
              </div>
              <div className="text-[11px] text-muted-foreground">
                Venc. {formatDateBR(conta.data_vencimento)} · Tiny {money(conta.valor_tiny)} ·{" "}
                {MATCH_METHOD_META[conta.metodo_match]?.label ?? conta.metodo_match}
              </div>
            </>
          ) : (
            <div className="text-[11px] text-muted-foreground">
              Lance a conta no Tiny para poder baixar.
            </div>
          )}
        </div>
      </TableCell>
      <TableCell>
        <p className="line-clamp-2 max-w-96 whitespace-normal text-xs" title={t.descricao || t.titulo}>
          {t.descricao || t.titulo || "—"}
        </p>
        <span className="text-[11px] text-muted-foreground">{t.tipo_transacao}</span>
      </TableCell>
    </TableRow>
            
  );
});

export function TransferenciasTable({
  data, colFilters, updateColFilter, filteredTransferencias, selectedIds, toggleSelectOne,
}: {
  data: ReconciliationPreviewResponse;
  colFilters: Record<TabId, ColumnFiltersState>;
  updateColFilter: (tab: TabId, colId: string, val: ColumnFilterValue | undefined) => void;
  filteredTransferencias: InternalTransferItem[];
  selectedIds: Set<number>;
  toggleSelectOne: (contaId: number) => void;
}) {
  return (
    <>
      <p className="border-b border-border px-4 py-2 text-[11px] text-muted-foreground sm:px-5">
        Débitos para outra empresa do grupo (mesma raiz de CNPJ), conciliados com o Tiny. As que casaram
        com uma conta em aberto podem ser baixadas aqui; as sem conta precisam ser lançadas no Tiny antes.
      </p>
      <Table className="min-w-[1100px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <span className="sr-only">Selecionar</span>
            </TableHead>
            <TableHead>
              <div className="flex items-center gap-2">
                <ColumnFilterHeader
                  title="Origem"
                  def={TRANSFERENCIAS_DEFS.empresa_origem}
                  value={colFilters.transferencias.empresa_origem}
                  onChange={(v) => updateColFilter("transferencias", "empresa_origem", v)}
                  uniqueValues={obterValoresUnicos(data.transferencias_internas ?? [], (t) => t.empresa_nome || t.empresa)}
                />
                <span className="text-muted-foreground" aria-hidden="true">→</span>
                <ColumnFilterHeader
                  title="Destino"
                  def={TRANSFERENCIAS_DEFS.empresa_destino}
                  value={colFilters.transferencias.empresa_destino}
                  onChange={(v) => updateColFilter("transferencias", "empresa_destino", v)}
                  uniqueValues={obterValoresUnicos(data.transferencias_internas ?? [], (t) => t.empresa_destino_nome)}
                />
              </div>
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Data"
                def={TRANSFERENCIAS_DEFS.data}
                value={colFilters.transferencias.data}
                onChange={(v) => updateColFilter("transferencias", "data", v)}
              />
            </TableHead>
            <TableHead className="text-right">
              <ColumnFilterHeader
                title="Valor"
                align="right"
                def={TRANSFERENCIAS_DEFS.valor}
                value={colFilters.transferencias.valor}
                onChange={(v) => updateColFilter("transferencias", "valor", v)}
              />
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Situação"
                def={TRANSFERENCIAS_DEFS.situacao}
                value={colFilters.transferencias.situacao}
                onChange={(v) => updateColFilter("transferencias", "situacao", v)}
                uniqueValues={obterValoresUnicos(data.transferencias_internas ?? [], (t) => (t.situacao in TRANSFER_SITUACAO_META ? TRANSFER_SITUACAO_META[t.situacao].label : t.situacao))}
              />
            </TableHead>
            <TableHead>
              <ColumnFilterHeader
                title="Descrição"
                def={TRANSFERENCIAS_DEFS.descricao}
                value={colFilters.transferencias.descricao}
                onChange={(v) => updateColFilter("transferencias", "descricao", v)}
              />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredTransferencias.map((t) => <TransferenciaRow key={`${t.empresa}-${t.transacao_id}`} t={t} isSelected={!!t.conciliacao && t.situacao === "apta_baixa" && selectedIds.has(t.conciliacao.conta_pagar_id)} onToggle={toggleSelectOne} />)}
        </TableBody>
      </Table>
      <div className="table-footer">
        <span>
          Mostrando {filteredTransferencias.length} de {data.transferencias_internas?.length ?? 0}{" "}
          transferência(s)
        </span>
        <span>Total: {money(filteredTransferencias.reduce((acc, t) => acc + t.valor_pago, 0))}</span>
      </div>
    </>
  );
}
