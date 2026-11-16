'use client';

import {
  AlertTriangle, CheckCircle2, Clock, ExternalLink, Info, Pencil, PackageSearch, RefreshCw, TriangleAlert, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { stockCount } from '@/lib/automations';
import { UNIDADES_POR_FARDO_PADRAO } from '@/lib/stock-count-contracts';
import { ColumnFilterBar, ColumnFilterHeader } from './column-filter';
import { filtrosAtivosCount } from '@/lib/column-filters';
import { ContagemCard, CartaoEsqueleto, Metrica } from './stock-count/lista';
import { FotoLightbox } from './stock-count/foto-viewer';
import { useStockCount } from './stock-count/use-stock-count';
import { ABAS_STATUS, BOT_USERNAME, PHOTO_TIPS, POR_PAGINA, STEPS, STOCK_COUNT_DEFS, skuDoItem } from './stock-count/helpers';
import { ReportarErro } from '@/components/reportar-erro';

interface StockCountProps {
  apiBaseUrl?: string;
}

export default function StockCount({ apiBaseUrl }: StockCountProps) {
  const {
    service, itens, setItens, configurado, loading, erro, colFilters, updateColFilter, clearFilters, filteredItens,
    contagemAbas, abaAtiva, totalPaginas, paginaAtual, setPagina, visiveis, resumo, porFardoPorSku, lightboxIdx,
    setLightboxIdx, fotos, abrirFoto, recarregar, handleExportCsv, mostrarInstrucoes, setMostrarInstrucoes,
    podeInformarSku, podeExcluir, podeConferir,
  } = useStockCount(apiBaseUrl);

  return (
    <div className="space-y-5">
      {/* Cabeçalho */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Logística</p>
          <h1 className="flex items-center gap-2 text-xl font-bold text-foreground">
            <PackageSearch size={22} className="text-primary" />
            {stockCount.title}
          </h1>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Conferência das prateleiras fotografadas pelo bot: confirme ou corrija a quantidade de cada contagem.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-none text-xs"
            aria-expanded={mostrarInstrucoes}
            onClick={() => setMostrarInstrucoes(!mostrarInstrucoes)}
          >
            <Info size={14} className="mr-1.5" />
            {mostrarInstrucoes ? 'Ocultar instruções' : 'Instruções do bot'}
          </Button>
          {BOT_USERNAME && (
            <a
              href={`https://t.me/${BOT_USERNAME}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-none bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:bg-[var(--brand-primary-hover)]"
            >
              <ExternalLink size={13} />@{BOT_USERNAME}
            </a>
          )}
        </div>
      </div>

      {/* Painel recolhível de Instruções */}
      {mostrarInstrucoes && (
        <div className="space-y-4 border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Como usar o bot</h2>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 rounded-none p-0"
              onClick={() => setMostrarInstrucoes(false)}
              aria-label="Fechar instruções"
            >
              <X size={14} />
            </Button>
          </div>
          <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex flex-col gap-2 rounded-none border border-border bg-background p-3.5">
                <span className="flex items-center gap-2 text-xs font-semibold text-foreground">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-none bg-[var(--marca-ambar-suave)] text-[11px] font-bold text-[var(--accent-text)]">
                    {i + 1}
                  </span>
                  {step.title}
                </span>
                <p className="text-[11px] leading-relaxed text-muted-foreground">{step.text}</p>
              </li>
            ))}
          </ol>
          <div className="grid gap-3 pt-1 lg:grid-cols-2">
            <div className="rounded-none border border-border bg-background p-3">
              <h3 className="mb-1 text-xs font-semibold text-foreground">Dicas para foto nítida</h3>
              <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
                {PHOTO_TIPS.map((tip) => (
                  <li key={tip}>{tip}</li>
                ))}
              </ul>
            </div>
            <div className="flex gap-2.5 rounded-none border border-amber-500/30 bg-amber-500/5 p-3">
              <TriangleAlert size={16} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" />
              <div>
                <h3 className="mb-0.5 text-xs font-semibold text-foreground">Validação visual no estoque</h3>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Confira sempre se a quantidade numerada na imagem anotada corresponde ao lote real da prateleira antes de registrar.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Alerta de diretório não configurado */}
      {!configurado && (
        <div className="flex items-start gap-3 border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-900 dark:text-amber-200">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-1">
            <p className="font-semibold">Diretório de contagens não configurado</p>
            <p className="text-muted-foreground">
              A variável de ambiente <code className="bg-background/80 px-1 py-0.5 font-mono text-[11px]">CONTAGEM_REGISTRO_DIR</code> não está definida no Gateway.
              Monte a pasta de dados do bot do Telegram para habilitar a galeria em tempo real.
            </p>
          </div>
        </div>
      )}

      {/* Métricas: calculadas sobre a página carregada */}
      <section aria-label="Resumo das contagens">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Metrica
            rotulo="Aguardando conferência"
            valor={resumo.aguardando}
            detalhe="no filtro atual"
            icone={Clock}
            destaque={resumo.aguardando > 0}
          />
          <Metrica rotulo="Confirmadas" valor={resumo.confirmadas} detalhe="no filtro atual" icone={CheckCircle2} />
          <Metrica rotulo="Corrigidas" valor={resumo.corrigidas} detalhe="no filtro atual" icone={Pencil} />
          <Metrica
            rotulo="Sem SKU"
            valor={resumo.semSku}
            detalhe="no filtro atual, sem produto identificado"
            icone={TriangleAlert}
            destaque={resumo.semSku > 0}
          />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Contagens exibidas: {visiveis.length} de {filteredItens.length} ({itens.length} no total).
        </p>
      </section>

      <ColumnFilterBar
        totalCount={itens.length}
        filteredCount={filteredItens.length}
        activeFiltersCount={filtrosAtivosCount(colFilters, STOCK_COUNT_DEFS)}
        onClearAll={clearFilters}
        onExportCsv={filteredItens.length > 0 ? handleExportCsv : undefined}
        itemLabel="contagens"
      />

      <div role="tablist" aria-label="Filtrar por status" className="flex flex-wrap border border-b-0 border-border bg-muted/40">
        {ABAS_STATUS.map((aba) => {
          const ativa = abaAtiva === aba.situacao;
          const n = aba.situacao ? (contagemAbas.porSituacao[aba.situacao] ?? 0) : contagemAbas.total;
          return (
            <button
              key={aba.rotulo}
              type="button"
              role="tab"
              aria-selected={ativa}
              onClick={() => updateColFilter('situacao', aba.situacao ? [aba.situacao] : undefined)}
              className={cn(
                'border-b-2 px-4 py-2.5 text-xs font-semibold outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-ring',
                ativa
                  ? 'border-[var(--marca-ambar)] bg-card text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {aba.rotulo} <span className="font-mono tabular-nums text-muted-foreground">· {n}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2 border border-border bg-muted/20 px-3 py-2 text-xs">
        <span className="text-muted-foreground font-medium mr-1">Filtros:</span>
        <ColumnFilterHeader
          def={STOCK_COUNT_DEFS.sku}
          value={colFilters.sku}
          onChange={(v) => updateColFilter('sku', v)}
        />
        <ColumnFilterHeader
          def={STOCK_COUNT_DEFS.situacao}
          value={colFilters.situacao}
          onChange={(v) => updateColFilter('situacao', v)}
        />
        <ColumnFilterHeader
          def={STOCK_COUNT_DEFS.data}
          value={colFilters.data}
          onChange={(v) => updateColFilter('data', v)}
        />
        <ColumnFilterHeader
          def={STOCK_COUNT_DEFS.quantidade}
          value={colFilters.quantidade}
          onChange={(v) => updateColFilter('quantidade', v)}
        />
        <ColumnFilterHeader
          def={STOCK_COUNT_DEFS.usuario_origem}
          value={colFilters.usuario_origem}
          onChange={(v) => updateColFilter('usuario_origem', v)}
        />
        <div className="ml-auto">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={recarregar}
            disabled={loading}
            className="h-7 text-xs"
            aria-label="Recarregar contagens"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>

      {erro && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-800 dark:text-rose-200">
          <span>{erro}</span>
          <span className="flex items-center gap-2">
            <ReportarErro automationId="stock-count" executionId="painel" errorMessage={erro} />
            <Button type="button" variant="outline" size="sm" className="h-7 rounded-none text-xs" onClick={recarregar}>
              Tentar novamente
            </Button>
          </span>
        </div>
      )}

      {/* Lista de contagens */}
      <div className="space-y-4">
        {loading && itens.length === 0 ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2" aria-busy="true" aria-label="Carregando contagens">
            {[0, 1, 2, 3].map((i) => (
              <CartaoEsqueleto key={i} />
            ))}
          </div>
        ) : filteredItens.length === 0 ? (
          <div className="flex flex-col items-center justify-center border border-border bg-card py-16 text-center text-xs text-muted-foreground">
            <PackageSearch size={32} className="mb-2 text-muted-foreground" />
            <p className="font-semibold text-foreground">Nenhuma contagem encontrada</p>
            <p className="mt-1 max-w-sm">
              {filtrosAtivosCount(colFilters, STOCK_COUNT_DEFS) > 0
                ? 'Nenhum resultado corresponde aos filtros aplicados.'
                : 'As fotos enviadas para o bot do Telegram aparecerão listadas aqui.'}
            </p>
            {filtrosAtivosCount(colFilters, STOCK_COUNT_DEFS) > 0 && (
              <Button variant="outline" size="sm" onClick={clearFilters} className="mt-3 cursor-pointer">
                Limpar filtros
              </Button>
            )}
          </div>
        ) : (
          <div className={cn('grid grid-cols-1 gap-4 xl:grid-cols-2', loading && 'opacity-60')} aria-busy={loading}>
            {visiveis.map((item) => (
              <ContagemCard
                key={item.id}
                item={item}
                service={service}
                porFardoPadrao={porFardoPorSku.get(skuDoItem(item)) ?? UNIDADES_POR_FARDO_PADRAO}
                podeConferir={podeConferir}
                podeInformarSku={podeInformarSku}
                podeExcluir={podeExcluir}
                setItens={setItens}
                onAbrirFoto={abrirFoto}
              />
            ))}
          </div>
        )}

        {/* Paginação */}
        {filteredItens.length > POR_PAGINA && (
          <div className="flex items-center justify-between border border-border bg-card p-3 text-xs">
            <span className="text-muted-foreground">
              Página {paginaAtual} de {totalPaginas}
            </span>
            <div className="flex gap-1.5">
              <Button variant="outline" size="sm" className="rounded-none text-xs" disabled={paginaAtual <= 1 || loading} onClick={() => setPagina((p) => Math.max(1, p - 1))}>
                Anterior
              </Button>
              <Button variant="outline" size="sm" className="rounded-none text-xs" disabled={paginaAtual * POR_PAGINA >= filteredItens.length || loading} onClick={() => setPagina((p) => p + 1)}>
                Próxima
              </Button>
            </div>
          </div>
        )}
      </div>

      {lightboxIdx !== null && (
        <FotoLightbox
          service={service}
          fotos={fotos}
          indice={Math.min(lightboxIdx, Math.max(0, fotos.length - 1))}
          onIndice={setLightboxIdx}
          onFechar={() => setLightboxIdx(null)}
        />
      )}
    </div>
  );
}

