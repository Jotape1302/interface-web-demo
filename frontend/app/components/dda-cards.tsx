"use client";

import { memo } from "react";
import { ArrowRight, Ban, Barcode, Building2, CalendarDays, FileText, Link2, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { money } from "@/lib/formatters";
import { companyLabel } from "@/lib/reconciliation-helpers";
import type { DdaBoleto, DdaCategoria } from "@/lib/dda-contracts";
import { dataBR, documentoFormatado } from "@/lib/dda-helpers";

/** Cabeçalho comum: beneficiário, documento, empresa, vencimento, linha digitável e valor. */
function CabecalhoBoleto({ boleto: b }: { boleto: DdaBoleto }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="flex flex-wrap items-center gap-x-2 text-sm font-semibold text-foreground">
        {b.beneficiario_nome || "Beneficiário sem nome"}
        <span className="font-normal text-muted-foreground tabular-nums">· {documentoFormatado(b.beneficiario_cnpj)}</span>
        {b.documento && <span className="font-normal text-muted-foreground">· doc. {b.documento}</span>}
        {b.fraude && (
          <Badge variant="danger" title="A Polp marcou este boleto como possível fraude.">
            <ShieldAlert /> Possível fraude
          </Badge>
        )}
      </p>
      {b.linha_digitavel && (
        <p className="mt-0.5 flex items-center gap-1 break-all font-mono text-xs tabular-nums text-muted-foreground">
          <Barcode size={11} className="shrink-0" />
          {b.linha_digitavel}
        </p>
      )}
      <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
        <Building2 size={11} className="shrink-0" />
        Empresa: <span className="font-medium text-foreground">{companyLabel(b.empresa)}</span>
      </p>
      <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
        <CalendarDays size={11} className="shrink-0" />
        Vencimento: <span className="font-medium text-foreground tabular-nums">{dataBR(b.vencimento)}</span>
        {b.emissao && (
          <>
            <span className="mx-1">·</span>Emissão: <span className="font-medium text-foreground tabular-nums">{dataBR(b.emissao)}</span>
          </>
        )}
      </p>
    </div>
  );
}

function ValorBoleto({ boleto: b }: { boleto: DdaBoleto }) {
  return (
    <div className="shrink-0 text-right">
      <p className="text-xs text-muted-foreground">Valor do boleto</p>
      <p className="font-mono font-bold tabular-nums text-foreground">{money(Number(b.valor))}</p>
    </div>
  );
}

/** Boleto sem conta no Tiny: categoria + histórico por boleto, criação em lote pelos selecionados. */
export const SemContaCard = memo(function SemContaCard({
  boleto: b,
  selecionado,
  categoria,
  historico,
  categorias,
  erroCategorias,
  bloqueado,
  erro,
  onSelecionar,
  onCategoria,
  onHistorico,
  onLigar,
  onDescartar,
}: {
  boleto: DdaBoleto;
  selecionado: boolean;
  categoria: string;
  historico: string;
  categorias: DdaCategoria[] | null;
  erroCategorias: string | null;
  bloqueado: boolean;
  erro?: string;
  onSelecionar: (id: string, marcado: boolean) => void;
  onCategoria: (id: string, categoriaId: string) => void;
  onHistorico: (id: string, texto: string) => void;
  onLigar: (b: DdaBoleto) => void;
  onDescartar: (b: DdaBoleto) => void;
}) {
  const incerta = Boolean(b.conta_criada_incerta);
  return (
    <Card className={`space-y-3 border-l-[3px] bg-card p-4 ${erro ? "border-l-[var(--status-error-fg)]" : "border-l-amber-500"}`}>
      <div className="flex flex-col justify-between gap-3 border-b border-border/40 pb-3 md:flex-row md:items-start">
        <div className="flex min-w-0 items-start gap-3">
          <Checkbox
            checked={selecionado}
            onCheckedChange={(marcado) => onSelecionar(b.id, marcado)}
            disabled={bloqueado || incerta}
            aria-label={`Selecionar o boleto de ${b.beneficiario_nome} para criar a conta no Tiny`}
            className="mt-1 shrink-0"
          />
          <CabecalhoBoleto boleto={b} />
        </div>
        <div className="flex items-start gap-3 self-end md:self-start">
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" disabled={bloqueado} onClick={() => onLigar(b)} className="gap-1" title="Ligar a uma conta que já existe no Tiny">
              <Link2 size={13} /> Ligar
            </Button>
            <Button size="sm" variant="ghost" disabled={bloqueado} onClick={() => onDescartar(b)} aria-label="Descartar boleto" title="Descartar">
              <Ban size={13} />
            </Button>
          </div>
          <ValorBoleto boleto={b} />
        </div>
      </div>

      {incerta ? (
        <p role="alert" className="text-xs text-destructive">
          A criação anterior ficou sem confirmação do Tiny. Confira as contas desse fornecedor no Tiny e, se a conta existir, use “Ligar”.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <div className="space-y-1">
            <label htmlFor={`dda-cat-${b.id}`} className="text-xs font-medium text-muted-foreground">
              Categoria (Tiny ERP)
            </label>
            {erroCategorias ? (
              <p role="alert" className="text-xs text-destructive">{erroCategorias}</p>
            ) : (
              <NativeSelect
                id={`dda-cat-${b.id}`}
                value={categoria}
                onChange={(e) => onCategoria(b.id, e.target.value)}
                disabled={bloqueado || !categorias}
                className="w-full"
              >
                <NativeSelectOption value="">{categorias ? "Escolha a categoria" : "Carregando categorias…"}</NativeSelectOption>
                {(categorias ?? []).map((c) => (
                  <NativeSelectOption key={c.id} value={c.id}>
                    {c.grupo ? `${c.grupo} → ${c.nome}` : c.nome}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </div>
          <div className="space-y-1">
            <label htmlFor={`dda-hist-${b.id}`} className="text-xs font-medium text-muted-foreground">
              Histórico
            </label>
            <Input id={`dda-hist-${b.id}`} value={historico} maxLength={500} disabled={bloqueado} onChange={(e) => onHistorico(b.id, e.target.value)} />
          </div>
        </div>
      )}
      {erro && (
        <p role="alert" className="text-xs text-destructive">
          {erro}
        </p>
      )}
    </Card>
  );
});

/** Boleto casado automaticamente: mostra boleto × conta do Tiny para a conferência antes do Inter. */
export const ConferirCard = memo(function ConferirCard({
  boleto: b,
  selecionado,
  bloqueado,
  onSelecionar,
  onDescartar,
}: {
  boleto: DdaBoleto;
  selecionado: boolean;
  bloqueado: boolean;
  onSelecionar: (id: string, marcado: boolean) => void;
  onDescartar: (b: DdaBoleto) => void;
}) {
  const c = b.conta;
  return (
    <Card className="space-y-3 border-l-[3px] border-l-sky-600 bg-card p-4">
      <div className="flex flex-col justify-between gap-3 border-b border-border/40 pb-3 md:flex-row md:items-start">
        <div className="flex min-w-0 items-start gap-3">
          <Checkbox
            checked={selecionado}
            onCheckedChange={(marcado) => onSelecionar(b.id, marcado)}
            disabled={bloqueado}
            aria-label={`Selecionar o boleto de ${b.beneficiario_nome} para validar o agendamento`}
            className="mt-1 shrink-0"
          />
          <CabecalhoBoleto boleto={b} />
        </div>
        <div className="flex items-start gap-3 self-end md:self-start">
          <Button size="sm" variant="ghost" disabled={bloqueado} onClick={() => onDescartar(b)} aria-label="Descartar boleto" title="Descartar">
            <Ban size={13} />
          </Button>
          <ValorBoleto boleto={b} />
        </div>
      </div>
      <div className="flex items-start gap-2 border border-border/60 bg-muted/30 p-3 text-xs">
        <FileText size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">
            Conta a pagar no Tiny <span className="tabular-nums">#{b.conta_id}</span>
            {c?.numero_documento && <span className="font-normal text-muted-foreground"> · doc. {c.numero_documento}</span>}
          </p>
          <p className="mt-0.5 text-muted-foreground">{c?.historico || "sem histórico"}</p>
          {c && (
            <p className="mt-0.5 flex flex-wrap items-center gap-1 text-muted-foreground">
              {c.fornecedor && <span className="text-foreground">{c.fornecedor}</span>}
              <ArrowRight size={11} aria-hidden="true" />
              venc. <span className="tabular-nums text-foreground">{dataBR(c.vencimento)}</span>
              · <span className="tabular-nums text-foreground">{money(Number(c.valor))}</span>
            </p>
          )}
        </div>
      </div>
    </Card>
  );
});
