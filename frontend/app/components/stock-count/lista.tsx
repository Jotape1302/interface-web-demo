'use client';

import { memo, type Dispatch, type SetStateAction } from 'react';
import {
  Clock, 
  TriangleAlert, type LucideIcon,
} from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { StockCountService } from '@/lib/stock-count-service';
import {
  
  
  type StockCountItem,
  
} from '@/lib/stock-count-contracts';
import { ConferenciaContagem, TinyContagem, AcoesContagem } from './modais';
import { FotoContagem, type FotoRef } from './foto-viewer';
import { statusBadge, formatDataBR, skuDoItem, numeroContagem, NOME_COR, COR_BOLINHA, fmtUn } from './helpers';

export function Metrica({
  rotulo,
  valor,
  detalhe,
  icone: Icone,
  destaque,
}: {
  rotulo: string;
  valor: number;
  detalhe: string;
  icone: LucideIcon;
  destaque?: boolean;
}) {
  return (
    <div className={cn('metric-card', destaque && 'border-l-[3px] border-l-[var(--marca-ambar)]')}>
      <div className="metric-top">
        <span>{rotulo}</span>
        <span className="grid size-8 shrink-0 place-items-center border border-border bg-muted text-primary">
          <Icone size={17} />
        </span>
      </div>
      <div className="metric-value tabular-nums">{valor}</div>
      <div className="metric-detail text-xs">{detalhe}</div>
    </div>
  );
}

export function CartaoEsqueleto() {
  return (
    <div className="border border-border bg-card" aria-hidden="true">
      <Skeleton className="h-16 rounded-none" />
      <div className="grid grid-cols-2 gap-2.5 p-4">
        <Skeleton className="aspect-[4/3] rounded-none" />
        <Skeleton className="aspect-[4/3] rounded-none" />
      </div>
      <Skeleton className="mx-4 mb-4 h-14 rounded-none" />
    </div>
  );
}

export function Campo({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{rotulo}</span>
      <div className="mt-0.5 text-xs text-foreground">{children}</div>
    </div>
  );
}

export const ContagemCard = memo(function ContagemCard({
  item,
  service,
  porFardoPadrao,
  podeConferir,
  podeInformarSku,
  podeExcluir,
  setItens,
  onAbrirFoto,
}: {
  item: StockCountItem;
  service: StockCountService;
  porFardoPadrao: number;
  podeConferir: boolean;
  podeInformarSku: boolean;
  podeExcluir: boolean;
  setItens: Dispatch<SetStateAction<StockCountItem[]>>;
  onAbrirFoto: (id: string, tipo: FotoRef['tipo']) => void;
}) {
  const pendente = item.status === 'aguardando_confirmacao';
  const produto = item.codigo || item.sku_manual?.sku;
  const barras = (item.codigos_barras || []).join(', ');
  return (

      <article
        key={item.id}
        className={cn(
          'flex flex-col overflow-hidden border bg-card',
          pendente ? 'border-amber-500/50 border-l-[3px] border-l-[var(--marca-ambar)]' : 'border-border',
        )}
      >
        {/* Identificação */}
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Produto</p>
            {produto ? (
              <h2 className="truncate font-mono text-base font-bold text-foreground" title={produto}>
                {produto}
                {!item.codigo && <span className="ml-1.5 font-sans text-[10px] font-normal text-muted-foreground">(informado no painel)</span>}
              </h2>
            ) : (
              <h2 className="text-base font-bold text-amber-700 dark:text-amber-300">Sem SKU</h2>
            )}
            <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
              <span className="font-mono" title={`Registro ${item.id}`}>#{numeroContagem(item)}</span>
              <span className="flex items-center gap-1">
                <Clock size={11} />
                {formatDataBR(item.criado_em)}
              </span>
              <span>{item.telegram_user}</span>
            </p>
          </div>
          {statusBadge(item.status)}
        </header>

        <div className="space-y-3 p-4">
          {/* Fotos lado a lado */}
          <div className="grid grid-cols-2 gap-2.5">
            <div className="space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Foto original</span>
              <FotoContagem
                service={service}
                item={item}
                tipo="original"
                titulo={`Foto Original — ${item.codigo || item.id}`}
                onAbrir={() => onAbrirFoto(item.id, 'original')}
              />
            </div>
            <div className="space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Foto da contagem</span>
              <FotoContagem
                service={service}
                item={item}
                tipo="anotada"
                titulo={`Contagem do Bot (${item.quantidade_detectada} un) — ${item.codigo || item.id}`}
                onAbrir={() => onAbrirFoto(item.id, 'anotada')}
              />
            </div>
          </div>

          {/* Quantidade em destaque e identificadores */}
          <div className="grid grid-cols-[auto_1fr] gap-4 border border-border bg-muted/40 p-3">
            <div>
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {item.quantidade_final !== null ? 'Fardos conferidos' : 'Fardos detectados'}
              </span>
              <span className="text-3xl font-bold leading-none tabular-nums text-foreground">
                {item.quantidade_final ?? item.quantidade_detectada}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  {(item.quantidade_final ?? item.quantidade_detectada) === 1 ? 'fardo' : 'fardos'}
                </span>
              </span>
              {item.cor && item.unidades_por_fardo && (
                <span className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                  <span className={`h-2 w-2 ${COR_BOLINHA[item.cor]}`} aria-hidden />
                  prendedor {NOME_COR[item.cor]} · {item.unidades_por_fardo} un/fardo
                </span>
              )}
              {item.conferencia && (
                <span className="mt-1 block text-[11px] tabular-nums text-foreground">
                  = {fmtUn(item.conferencia.unidades_total)} un ({item.conferencia.unidades_por_fardo}/fardo
                  {item.conferencia.unidades_soltas ? ` + ${item.conferencia.unidades_soltas} soltas` : ''})
                </span>
              )}
              {item.quantidade_final !== null && item.quantidade_final !== item.quantidade_detectada && (
                <span className="mt-1 block text-[11px] text-muted-foreground">bot detectou {item.quantidade_detectada}</span>
              )}
            </div>
            <div className="grid min-w-0 content-center gap-2 sm:grid-cols-2">
              <Campo rotulo="SKU (legenda)">
                <span className="block truncate font-mono" title={item.sku_legenda || '—'}>
                  {item.sku_legenda || '—'}
                </span>
              </Campo>
              <Campo rotulo="Código de barras">
                <span className="block truncate font-mono" title={barras || '—'}>
                  {barras || '—'}
                </span>
              </Campo>
            </div>
          </div>

          {item.alertas && item.alertas.length > 0 && (
            <div className="flex items-start gap-1.5 border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-800 dark:text-amber-200">
              <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div>
                {item.alertas.map((a, i) => (
                  <p key={i}>{a}</p>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Rodapé de ações */}
        <footer className="mt-auto space-y-2.5 border-t border-border bg-muted/40 px-4 py-3 [&>div]:border-t-0 [&>div]:pt-0 [&>div+div]:border-t [&>div+div]:pt-2.5">
          <ConferenciaContagem
            key={`${item.id}-${item.status}-${item.quantidade_final ?? ''}-${item.conferencia?.unidades_total ?? ''}-${skuDoItem(item)}`}
            item={item}
            service={service}
            podeConferir={podeConferir}
            porFardoPadrao={porFardoPadrao}
            onConferida={(conf, tiny) =>
              setItens((lista) =>
                lista.map((i) =>
                  i.id === item.id
                    ? {
                        ...i,
                        conferencia: conf,
                        tiny: tiny ?? i.tiny ?? null,
                        status: conf.status,
                        quantidade_final: conf.quantidade_final,
                        concluido_em: conf.conferida_em,
                      }
                    : i,
                ),
              )
            }
          />
          <TinyContagem
            item={item}
            service={service}
            podeConferir={podeConferir}
            onTiny={(tiny) => setItens((lista) => lista.map((i) => (i.id === item.id ? { ...i, tiny } : i)))}
          />
          <AcoesContagem
            item={item}
            service={service}
            podeInformarSku={podeInformarSku}
            podeExcluir={podeExcluir}
            onSku={(manual, tiny) =>
              setItens((lista) =>
                lista.map((i) => (i.id === item.id ? { ...i, sku_manual: manual, tiny: tiny ?? i.tiny ?? null } : i)),
              )
            }
            onExcluida={() => {
              setItens((lista) => lista.filter((i) => i.id !== item.id));
            }}
          />
        </footer>
      </article>
    
  );
});
