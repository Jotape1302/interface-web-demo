'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Maximize2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

import type { StockCountService } from '@/lib/stock-count-service';
import {
  
  
  type StockCountItem,
  
} from '@/lib/stock-count-contracts';


// Foto do registro baixada com o token da sessão (uma <img> com a URL do gateway recebia 401).
export function FotoContagem({
  service,
  item,
  tipo,
  titulo,
  onAbrir,
}: {
  service: StockCountService;
  item: StockCountItem;
  tipo: 'anotada' | 'original';
  titulo: string;
  onAbrir: () => void;
}) {
  const semOriginal = tipo === 'original' && !item.imagem_original;
  const [url, setUrl] = useState<string | null>(null);
  const [falhou, setFalhou] = useState(false);

  useEffect(() => {
    if (semOriginal) return;
    const controle = new AbortController();
    let criada: string | null = null;
    // oxlint-disable-next-line react/react-compiler -- setState síncrono no efeito é intencional (reset/sincronização ao mudar a entrada); refatorar exigiria reestruturar o componente
    setUrl(null);
    setFalhou(false);
    service
      .carregarImagem(item.id, tipo, controle.signal)
      .then((u) => {
        criada = u;
        setUrl(u);
      })
      .catch(() => {
        if (!controle.signal.aborted) setFalhou(true);
      });
    return () => {
      controle.abort();
      if (criada?.startsWith('blob:')) URL.revokeObjectURL(criada);
    };
  }, [service, item.id, tipo, semOriginal]);

  const borda = tipo === 'anotada' ? 'border-primary/30' : 'border-border';
  if (!url) {
    return (
      <div className={`flex aspect-[4/3] w-full items-center justify-center border ${borda} bg-muted p-3 text-center text-[11px] text-muted-foreground`}>
        {semOriginal
          ? 'Foto original não guardada (contagem anterior a 13/10/2026).'
          : falhou
            ? 'Não foi possível carregar a foto.'
            : 'Carregando foto…'}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`group relative aspect-[4/3] w-full cursor-zoom-in overflow-hidden border ${borda} bg-muted p-0 text-left`}
      onClick={onAbrir}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={titulo} className="h-full w-full object-cover transition " />
      <div className="absolute inset-0 flex items-center justify-center bg-primary/40 opacity-0 transition group-hover:opacity-100">
        <Maximize2 size={18} className="text-white" />
      </div>
    </button>
  );
}

export type FotoRef = { id: string; tipo: 'anotada' | 'original'; titulo: string };

// Ampliação com navegação entre todas as fotos da lista (← → no teclado ou botões; Esc fecha).
export function FotoLightbox({
  service,
  fotos,
  indice,
  onIndice,
  onFechar,
}: {
  service: StockCountService;
  fotos: FotoRef[];
  indice: number;
  onIndice: (i: number) => void;
  onFechar: () => void;
}) {
  const foto = fotos[indice];
  const [url, setUrl] = useState<string | null>(null);
  const [falhou, setFalhou] = useState(false);
  const temAnterior = indice > 0;
  const temProxima = indice < fotos.length - 1;
  const anterior = useCallback(() => temAnterior && onIndice(indice - 1), [temAnterior, indice, onIndice]);
  const proxima = useCallback(() => temProxima && onIndice(indice + 1), [temProxima, indice, onIndice]);

  // Depende só de id/tipo: `fotos` é recriado a cada recarga da lista e, com o objeto na
  // dependência, a foto aberta era baixada de novo (piscava).
  const fotoId = foto?.id;
  const fotoTipo = foto?.tipo;
  useEffect(() => {
    if (!fotoId || !fotoTipo) return;
    const controle = new AbortController();
    let criada: string | null = null;
    // oxlint-disable-next-line react/react-compiler -- setState síncrono no efeito é intencional (reset/sincronização ao mudar a entrada); refatorar exigiria reestruturar o componente
    setUrl(null);
    setFalhou(false);
    service
      .carregarImagem(fotoId, fotoTipo, controle.signal)
      .then((u) => {
        criada = u;
        setUrl(u);
      })
      .catch(() => {
        if (!controle.signal.aborted) setFalhou(true);
      });
    return () => {
      controle.abort();
      if (criada?.startsWith('blob:')) URL.revokeObjectURL(criada);
    };
  }, [service, fotoId, fotoTipo]);

  useEffect(() => {
    function tecla(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        anterior();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        proxima();
      } else if (e.key === 'Escape') {
        onFechar();
      }
    }
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [anterior, proxima, onFechar]);

  if (!foto) return null;
  const seta =
    'absolute top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-none border border-border bg-background/90 text-foreground shadow disabled:opacity-30';
  return (
    <dialog
      open
      aria-modal="true"
      aria-label={foto.titulo}
      className="fixed inset-0 z-50 m-0 flex h-full w-full max-h-none max-w-none items-center justify-center border-0 bg-transparent p-4"
    >
      <button
        type="button"
        className="fixed inset-0 cursor-default border-0 bg-black/80 backdrop-blur-sm"
        onClick={onFechar}
        aria-label="Fechar ampliação da foto"
      />
      <div className="relative z-10 max-h-[92vh] max-w-[92vw] overflow-hidden rounded-none border border-border bg-background p-2 shadow-2xl">
        <div className="mb-2 flex items-center justify-between gap-3 border-b border-border px-1 pb-2">
          <h3 className="truncate text-xs font-semibold text-foreground">{foto.titulo}</h3>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              {indice + 1} / {fotos.length}
            </span>
            <Button variant="ghost" size="sm" className="h-6 w-6 rounded-none p-0" onClick={onFechar} aria-label="Fechar">
              <X size={14} />
            </Button>
          </div>
        </div>
        <div className="relative flex min-h-[40vh] min-w-[50vw] max-h-[82vh] items-center justify-center overflow-auto">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={foto.titulo} className="max-h-[80vh] max-w-full object-contain" />
          ) : (
            <span className="text-xs text-muted-foreground">{falhou ? 'Não foi possível carregar a foto.' : 'Carregando foto…'}</span>
          )}
          <button type="button" className={`${seta} left-2`} onClick={anterior} disabled={!temAnterior} aria-label="Foto anterior (←)">
            <ChevronLeft size={20} />
          </button>
          <button type="button" className={`${seta} right-2`} onClick={proxima} disabled={!temProxima} aria-label="Próxima foto (→)">
            <ChevronRight size={20} />
          </button>
        </div>
      </div>
    </dialog>
  );
}

