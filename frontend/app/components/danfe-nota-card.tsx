"use client";

import { memo } from "react";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Building2,
  CalendarDays,
  CheckCircle2,
  CreditCard,
  History,
  Layers,
  Loader2,
  Pencil,
  Tag,
  SplitSquareHorizontal,
  XCircle,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { ConfirmLancamentoResponse, DanfeNotaStatus, DanfePendingReviewEntry } from "@/lib/contracts";
import { formatDateBR } from "@/lib/formatters";
import {
  MAX_PARCELAS,
  PAYMENT_METHOD_NFE_OPTIONS,
  PAYMENT_METHOD_OPTIONS,
  computeGroupPreview,
  dividirEmParcelas,
  formatChave,
  formatCurrency,
  resolveCompanyDisplayName,
} from "@/lib/danfe-review-helpers";

interface NotaCardProps {
  entry: DanfePendingReviewEntry;
  statusFilter: DanfeNotaStatus;
  isSelected: boolean;
  isConfirming: boolean;
  isArchiving: boolean;
  isRestoring: boolean;
  confirmingAll: boolean;
  categorySelection: Record<string, string>;
  paymentMethod: string;
  paymentMethodNfe: string;
  parcelas: number;
  categoryOptionsNode: React.ReactNode;
  categoryName: (id: string) => string;
  result?: ConfirmLancamentoResponse;
  onToggleSelected: (chave: string, checked: boolean) => void;
  onCategoryChange: (chave: string, itemId: string, categoriaId: string) => void;
  onPaymentMethodChange: (chave: string, formaPagamentoId: string) => void;
  onPaymentMethodNfeChange: (chave: string, code: string) => void;
  onParcelasChange: (chave: string, parcelas: number) => void;
  onArchive: (entry: DanfePendingReviewEntry) => void;
  onRestore: (entry: DanfePendingReviewEntry) => void;
  /** Sessão tem revisao_nfe:arquivar (arquivar/restaurar). */
  canArchive: boolean;
}

function NotaCardImpl({
  entry,
  statusFilter,
  isSelected,
  isConfirming,
  isArchiving,
  isRestoring,
  confirmingAll,
  categorySelection,
  paymentMethod,
  paymentMethodNfe,
  parcelas,
  categoryOptionsNode,
  categoryName,
  result,
  onToggleSelected,
  onCategoryChange,
  onPaymentMethodChange,
  onPaymentMethodNfeChange,
  onParcelasChange,
  onArchive,
  onRestore,
  canArchive,
}: NotaCardProps) {
  const isReadOnly = statusFilter !== "pending";
  const groupPreview = isReadOnly
    ? []
    : computeGroupPreview(entry.itens, categorySelection, categoryName, entry.nfe_data.valor_total);
  const cardStatusClasses =
    statusFilter === "pending"
      ? "bg-card border-l-[3px] border-l-amber-500"
      : statusFilter === "confirmed"
        ? "bg-card border-l-[3px] border-l-emerald-600"
        : "bg-card";

  return (
    <Card className={`p-4 space-y-3 ${cardStatusClasses}`}>
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 pb-2 border-b border-border/40">
        <div className="flex items-start gap-3">
          {!isReadOnly && (
            <Checkbox
              checked={isSelected}
              onCheckedChange={(checked) => onToggleSelected(entry.chave, checked)}
              disabled={confirmingAll || isConfirming}
              aria-label={`Selecionar nota ${entry.nfe_data.numero_nota} para envio ao Tiny`}
              className="mt-1 shrink-0"
            />
          )}
          <div>
            <p className="font-semibold text-sm text-foreground flex items-center gap-2">
              {entry.nfe_data.emitente_nome}{" "}
              <span className="text-muted-foreground font-normal">· NF-e nº {entry.nfe_data.numero_nota}</span>
              {isConfirming && (
                <span className="inline-flex items-center gap-1 text-[10px] font-normal text-[var(--brand-primary)]">
                  <Loader2 className="animate-spin" size={11} />
                  Enviando ao Tiny...
                </span>
              )}
            </p>
            <p className="break-all text-xs font-mono tabular-nums text-muted-foreground">{formatChave(entry.chave)}</p>
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
              <Building2 size={11} className="shrink-0" />
              Empresa:{" "}
              <span className="font-medium text-foreground">
                {resolveCompanyDisplayName(entry.nfe_data.destinatario_cnpj, entry.nfe_data.destinatario_nome)}
              </span>
            </p>
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
              <CalendarDays size={11} className="shrink-0" />
              Emissão: <span className="font-medium text-foreground">{formatDateBR(entry.nfe_data.data_emissao)}</span>
            </p>
            {!isReadOnly ? (
              <>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <CreditCard size={11} className="text-muted-foreground shrink-0" />
                  <span className="text-xs text-muted-foreground">Forma de pagamento:</span>
                  <NativeSelect
                    size="sm"
                    aria-label={`Forma de pagamento para a nota ${entry.nfe_data.numero_nota}`}
                    value={paymentMethod}
                    onChange={(e) => onPaymentMethodChange(entry.chave, e.target.value)}
                    disabled={confirmingAll || isConfirming}
                    className="h-6 text-xs w-auto"
                  >
                    {PAYMENT_METHOD_OPTIONS.map((opt) => (
                      <NativeSelectOption key={opt.id} value={opt.id}>
                        {opt.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  <CreditCard size={11} className="text-muted-foreground shrink-0" />
                  <span className="text-xs text-muted-foreground">Meio de pagamento da NFe:</span>
                  <NativeSelect
                    size="sm"
                    aria-label={`Meio de pagamento da NFe para a nota ${entry.nfe_data.numero_nota}`}
                    value={paymentMethodNfe}
                    onChange={(e) => onPaymentMethodNfeChange(entry.chave, e.target.value)}
                    disabled={confirmingAll || isConfirming}
                    className="h-6 text-xs w-auto"
                  >
                    <NativeSelectOption value="">Não informado</NativeSelectOption>
                    {PAYMENT_METHOD_NFE_OPTIONS.map((opt) => (
                      <NativeSelectOption key={opt.code} value={opt.code}>
                        {opt.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  <SplitSquareHorizontal size={11} className="text-muted-foreground shrink-0" />
                  <span className="text-xs text-muted-foreground">Parcelas:</span>
                  <NativeSelect
                    size="sm"
                    aria-label={`Quantidade de parcelas da nota ${entry.nfe_data.numero_nota}`}
                    value={String(parcelas)}
                    onChange={(e) => onParcelasChange(entry.chave, Number(e.target.value))}
                    disabled={confirmingAll || isConfirming}
                    className="h-6 text-xs w-auto"
                  >
                    {Array.from({ length: MAX_PARCELAS }, (_, i) => i + 1).map((n) => (
                      <NativeSelectOption key={n} value={String(n)}>
                        {n === 1 ? "1x (à vista)" : `${n}x`}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              </>
            ) : (
              entry.nfe_data.meio_pagamento_nfe && (
                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1.5">
                  <CreditCard size={11} className="shrink-0" />
                  Meio de pagamento da NFe:{" "}
                  <span className="font-medium text-foreground">
                    {PAYMENT_METHOD_NFE_OPTIONS.find((opt) => opt.code === entry.nfe_data.meio_pagamento_nfe)?.label ??
                      entry.nfe_data.meio_pagamento_nfe}
                  </span>
                </p>
              )
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {statusFilter === "pending" && canArchive && (
            <button
              type="button"
              onClick={() => onArchive(entry)}
              disabled={confirmingAll || isConfirming || isArchiving}
              aria-label={`Arquivar nota ${entry.nfe_data.numero_nota}`}
              title="Arquivar nota"
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isArchiving ? <Loader2 className="animate-spin" size={15} /> : <Archive size={15} />}
            </button>
          )}
          {statusFilter === "archived" && canArchive && (
            <button
              type="button"
              onClick={() => onRestore(entry)}
              disabled={isRestoring}
              aria-label={`Restaurar nota ${entry.nfe_data.numero_nota} para revisão pendente`}
              title="Restaurar para revisão pendente"
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRestoring ? <Loader2 className="animate-spin" size={15} /> : <ArchiveRestore size={15} />}
            </button>
          )}
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Valor Total da Nota</p>
            <p className="font-bold text-foreground font-mono tabular-nums">
              {formatCurrency(entry.nfe_data.valor_total)}
            </p>
          </div>
        </div>
      </div>

      {!isReadOnly && (
        <div className="overflow-x-auto rounded-md border border-border/50">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left bg-muted/40">
                <th className="font-semibold uppercase tracking-wide text-[10px] text-muted-foreground py-2 pl-3 pr-2">
                  Item
                </th>
                <th className="font-semibold uppercase tracking-wide text-[10px] text-muted-foreground py-2 pr-2">
                  NCM
                </th>
                <th className="font-semibold uppercase tracking-wide text-[10px] text-muted-foreground py-2 pr-2 text-right">
                  Valor
                </th>
                <th className="font-semibold uppercase tracking-wide text-[10px] text-muted-foreground py-2 pr-3">
                  Categoria (Tiny ERP)
                </th>
              </tr>
            </thead>
            <tbody>
              {entry.itens.map((item) => {
                const selected = categorySelection[item.item_id] || item.categoria_sugerida_id;
                const isManual = selected !== item.categoria_sugerida_id;
                return (
                  <tr key={item.item_id} className="border-t border-border/30">
                    <td className="py-2 pl-3 pr-2 text-foreground max-w-[260px] truncate" title={item.descricao}>
                      {item.descricao}
                    </td>
                    <td className="py-2 pr-2 text-muted-foreground font-mono tabular-nums">{item.ncm || "—"}</td>
                    <td className="py-2 pr-2 text-right font-mono tabular-nums text-foreground">
                      {formatCurrency(item.valor_total)}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-1.5">
                        <span
                          title={
                            isManual
                              ? "Categoria ajustada manualmente"
                              : item.categoria_sugerida_origem === "historico"
                                ? "Sugerido pelo histórico: mesma categoria usada nas notas anteriores deste fornecedor"
                                : "Sugerido automaticamente pela descrição/NCM"
                          }
                          className={isManual ? "text-[var(--brand-primary)] shrink-0" : "text-muted-foreground shrink-0"}
                        >
                          {isManual ? (
                            <Pencil size={12} />
                          ) : item.categoria_sugerida_origem === "historico" ? (
                            <History size={12} />
                          ) : (
                            <Tag size={12} />
                          )}
                        </span>
                        <NativeSelect
                          size="sm"
                          aria-label={`Categoria Tiny ERP para o item ${item.descricao}`}
                          value={selected}
                          onChange={(e) => onCategoryChange(entry.chave, item.item_id, e.target.value)}
                          disabled={confirmingAll}
                          className="w-full max-w-xs"
                        >
                          {categoryOptionsNode}
                        </NativeSelect>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {groupPreview.length > 0 && (
        <div className="rounded-md border border-border/50 bg-muted/20 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5 mb-2">
            <Layers size={12} />
            {groupPreview.length * parcelas === 1
              ? "1 lançamento será gerado no Tiny"
              : `${groupPreview.length * parcelas} lançamentos serão gerados no Tiny`}
          </p>
          <div className="space-y-1">
            {groupPreview.map((g) => (
              <div key={g.categoriaId} className="flex items-center justify-between text-xs">
                <span className="text-foreground">
                  {g.categoriaNome}{" "}
                  <span className="text-muted-foreground">
                    ({g.itemIds.length} {g.itemIds.length === 1 ? "item" : "itens"})
                  </span>
                </span>
                <span className="font-mono tabular-nums font-medium text-foreground">
                  {parcelas > 1 && (
                    <span className="mr-2 font-normal text-muted-foreground">
                      {(() => {
                        const valores = dividirEmParcelas(g.valorTotal, parcelas);
                        const primeira = valores[0];
                        const ultima = valores[valores.length - 1];
                        return ultima === primeira
                          ? `${parcelas}x ${formatCurrency(primeira)}`
                          : `${parcelas - 1}x ${formatCurrency(primeira)} + 1x ${formatCurrency(ultima)}`;
                      })()}
                    </span>
                  )}
                  {formatCurrency(g.valorTotal)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {result && result.status !== "success" && (
        <div className="space-y-1.5">
          {result.grupos.map((g, i) => (
            <div
              key={i}
              className={`flex items-center justify-between text-xs p-2 rounded ${
                g.status === "success"
                  ? "bg-[var(--status-success-bg)] text-[var(--status-success-fg)]"
                  : "bg-[var(--status-error-bg)] text-[var(--status-error-fg)]"
              }`}
            >
              <span className="flex items-center gap-1.5">
                {g.status === "success" ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                {g.categoria_nome || "Lançamento"}
                {(g.total_parcelas ?? 1) > 1 && ` · parcela ${g.parcela}/${g.total_parcelas}`}
                {g.status === "success" && g.tiny_result && ` · Doc ${g.tiny_result.nro_documento}`}
              </span>
              {g.status === "error" && <span>{g.error_message}</span>}
            </div>
          ))}
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <AlertTriangle size={12} />
            Falha parcial: reenviar é seguro, os lançamentos já feitos não são duplicados.
          </p>
        </div>
      )}
    </Card>
  );
}

export const NotaCard = memo(NotaCardImpl);
