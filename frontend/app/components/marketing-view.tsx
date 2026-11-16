'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileCode,
  Image as ImageIcon,
  Mail,
  RefreshCw,
  Search,
  Share2,
  ShoppingBag,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth-context';
import { useDataPolling } from '@/lib/use-data-polling';
import type {
  AmbienteImagem,
  ExecucaoMarketing,
  MarketingStatus,
  ProdutoCatalogoNorvia,
  ProdutoEditorial,
  RascunhoEdicao,
} from '@/lib/marketing-contracts';
import {
  createMarketingService,
  extrairIdsAmbienteDaPrevia,
  prefixarImagensDaPrevia,
  substituirAmbientesPorDataUrls,
} from '@/lib/marketing-service';

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const POLL_GERACAO_MS = 3000;

export default function MarketingView({ mode }: { mode: 'demo' | 'live' }) {
  const { apiBaseUrl, token } = useAuth();
  const service = useMemo(() => createMarketingService(apiBaseUrl, mode, token), [apiBaseUrl, mode, token]);
  const [status, setStatus] = useState<MarketingStatus | null>(null);
  const [rascunhos, setRascunhos] = useState<RascunhoEdicao[]>([]);
  const [produtosEditoriais, setProdutosEditoriais] = useState<ProdutoEditorial[]>([]);
  const [catalogo, setCatalogo] = useState<ProdutoCatalogoNorvia[]>([]);
  const [execucoes, setExecucoes] = useState<ExecucaoMarketing[]>([]);
  const [ambientes, setAmbientes] = useState<AmbienteImagem[]>([]);
  const [gerandoAmbientes, setGerandoAmbientes] = useState(false);
  const [filtroSlugAmbiente, setFiltroSlugAmbiente] = useState<string>('todos');
  const [edicaoAtivaId, setEdicaoAtivaId] = useState<string>('');
  const [filtroBuscaCatalogo, setFiltroBuscaCatalogo] = useState<string>('');
  const [copiadoRd, setCopiadoRd] = useState(false);
  const [copiadoInsta, setCopiadoInsta] = useState(false);
  const [copiadoLegenda, setCopiadoLegenda] = useState(false);
  const [baixandoZip, setBaixandoZip] = useState(false);
  const [slideBlobUrls, setSlideBlobUrls] = useState<Record<number, string>>({});
  const [abaAtiva, setAbaAtiva] = useState<string>('rascunhos');
  const [ambienteBlobUrls, setAmbienteBlobUrls] = useState<Record<string, string>>({});
  const ambienteBlobsRef = useRef<Record<string, string>>({});
  const [ambienteDataUrls, setAmbienteDataUrls] = useState<Record<string, string>>({});
  const ambienteDataRef = useRef<Record<string, string>>({});
  const [ambienteFalhas, setAmbienteFalhas] = useState<Record<string, boolean>>({});
  const ambienteFalhasRef = useRef<Set<string>>(new Set());
  const [carregandoSlides, setCarregandoSlides] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);
  const [erroCarga, setErroCarga] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const gerando = Boolean(status?.geracao?.em_andamento);
  const gerandoImagens = Boolean(status?.geracao_imagens?.em_andamento) || gerandoAmbientes;

  const carregarDados = useCallback(async () => {
    try {
      const [st, rasc, prods, cat, execs, ambs] = await Promise.all([
        service.status(),
        service.rascunhos(),
        service.produtos(),
        service.catalogo(),
        service.execucoes(),
        service.listarAmbientes(),
      ]);
      setStatus(st);
      setRascunhos(rasc);
      setProdutosEditoriais(prods);
      setCatalogo(cat.produtos || []);
      setExecucoes(execs);
      setAmbientes(ambs);
      setErroCarga(null);
      if (rasc.length > 0) setEdicaoAtivaId((curr) => (rasc.some((r) => r.id === curr) ? curr : rasc[0]!.id));
    } catch (e) {
      setErroCarga(e instanceof Error ? e.message : 'Falha ao carregar a automação de e-mail marketing.');
    }
  }, [service]);

  useEffect(() => {
    // oxlint-disable-next-line react/react-compiler -- setState síncrono no efeito é intencional (reset/sincronização ao mudar a entrada); refatorar exigiria reestruturar o componente
    void carregarDados();
  }, [carregarDados]);

  // Geração em andamento (roda na automação): acompanha até terminar e mostra o resultado.
  useDataPolling(
    async () => {
      const st = await service.status();
      setStatus(st);
      if (st.geracao.em_andamento) return;
      await carregarDados();
      setFeedbackMsg(
        st.geracao.ultimo_erro
          ? { tipo: 'erro', texto: `A geração falhou: ${st.geracao.ultimo_erro}` }
          : { tipo: 'ok', texto: 'Edições de segunda e quinta geradas.' },
      );
    },
    { intervalMs: POLL_GERACAO_MS, enabled: gerando, pauseOnHidden: true, refetchOnVisible: true },
  );

  // Geração de imagens de ambiente em andamento: acompanha até terminar.
  useDataPolling(
    async () => {
      const st = await service.status();
      setStatus(st);
      if (st.geracao_imagens?.em_andamento) return;
      await carregarDados();
      setFeedbackMsg(
        st.geracao_imagens?.ultimo_erro
          ? { tipo: 'erro', texto: `Falha ao gerar imagens: ${st.geracao_imagens.ultimo_erro}` }
          : { tipo: 'ok', texto: 'Novas opções de ambiente geradas.' },
      );
    },
    { intervalMs: POLL_GERACAO_MS, enabled: Boolean(status?.geracao_imagens?.em_andamento), pauseOnHidden: true, refetchOnVisible: true },
  );

  const rascunhoAtivo = rascunhos.find((r) => r.id === edicaoAtivaId) || rascunhos[0];

  useEffect(() => {
    if (!rascunhoAtivo || mode === 'demo') {
      // oxlint-disable-next-line react/react-compiler -- reset sincrono no efeito
      setSlideBlobUrls({});
      return;
    }

    let ativo = true;
    const urlsCriadas: string[] = [];
    const totalSlides = rascunhoAtivo.carrossel_slides || rascunhoAtivo.copy?.carrossel?.length || 0;

    if (totalSlides === 0) {
      // oxlint-disable-next-line react/react-compiler -- reset sincrono no efeito
      setSlideBlobUrls({});
      return;
    }

    setCarregandoSlides(true);

    const carregarTodos = async () => {
      const mapaUrls: Record<number, string> = {};
      for (let n = 1; n <= totalSlides; n++) {
        try {
          const blob = await service.carrosselSlideBlob(rascunhoAtivo.id, n);
          if (!ativo) return;
          const url = URL.createObjectURL(blob);
          urlsCriadas.push(url);
          mapaUrls[n] = url;
        } catch {
          // Slide individual não encontrado ou sem imagem gerada
        }
      }
      if (ativo) {
        setSlideBlobUrls(mapaUrls);
        setCarregandoSlides(false);
      }
    };

    void carregarTodos();

    return () => {
      ativo = false;
      urlsCriadas.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [rascunhoAtivo, mode, service]);

  const handleGerarLote = () => {
    startTransition(async () => {
      try {
        setFeedbackMsg(null);
        const mensagem = await service.gerarLote();
        setFeedbackMsg({ tipo: 'ok', texto: mensagem });
        const st = await service.status();
        setStatus(st);
        if (!st.geracao.em_andamento) await carregarDados();
      } catch (err: unknown) {
        setFeedbackMsg({ tipo: 'erro', texto: err instanceof Error ? err.message : 'Falha ao iniciar a geração.' });
      }
    });
  };

  const handleAprovar = (id: string) => {
    startTransition(async () => {
      try {
        const atualizado = await service.aprovar(id);
        setRascunhos((prev) => prev.map((r) => (r.id === id ? atualizado : r)));
        setFeedbackMsg({ tipo: 'ok', texto: `Edição de ${atualizado.dia_semana} aprovada.` });
        setExecucoes(await service.execucoes());
      } catch (err: unknown) {
        setFeedbackMsg({ tipo: 'erro', texto: err instanceof Error ? err.message : 'Falha ao aprovar a edição.' });
      }
    });
  };

  const handleTrocarProduto = (id: string, slug: string) => {
    startTransition(async () => {
      try {
        setFeedbackMsg(null);
        const mensagem = await service.trocarProduto(id, slug);
        setFeedbackMsg({ tipo: 'ok', texto: mensagem });
        const st = await service.status();
        setStatus(st);
        if (!st.geracao.em_andamento) await carregarDados();
      } catch (err: unknown) {
        setFeedbackMsg({ tipo: 'erro', texto: err instanceof Error ? err.message : 'Falha ao trocar o produto.' });
      }
    });
  };

  const copiarParaRdStation = () => {
    if (!rascunhoAtivo) return;
    const htmlExportavel = rascunhoAtivo.html_email_rd_station || rascunhoAtivo.html_email_preview;
    void navigator.clipboard.writeText(htmlExportavel);
    setCopiadoRd(true);
    setTimeout(() => setCopiadoRd(false), 2500);
  };

  const copiarKitInstagram = () => {
    if (!rascunhoAtivo?.copy) return;
    const slides = rascunhoAtivo.copy.carrossel
      ? rascunhoAtivo.copy.carrossel.map((s, i) => `Slide ${i + 1} (${s.tipo.toUpperCase()}): ${s.titulo}\n${s.texto}`).join('\n\n')
      : (rascunhoAtivo.copy.slides_instagram || []).join('\n\n');
    const textoCompleto = `=== CARROSSEL INSTAGRAM (NORVIA) ===\n\n${slides}\n\n=== LEGENDA PARA POSTAGEM ===\n\n${rascunhoAtivo.copy.legenda_instagram || ''}`;
    void navigator.clipboard.writeText(textoCompleto);
    setCopiadoInsta(true);
    setTimeout(() => setCopiadoInsta(false), 2500);
  };

  const copiarLegendaInstagram = () => {
    if (!rascunhoAtivo?.copy?.legenda_instagram) return;
    void navigator.clipboard.writeText(rascunhoAtivo.copy.legenda_instagram);
    setCopiadoLegenda(true);
    setTimeout(() => setCopiadoLegenda(false), 2500);
  };

  const baixarZipCarrossel = async () => {
    if (!rascunhoAtivo) return;
    try {
      setBaixandoZip(true);
      const blob = await service.carrosselZipBlob(rascunhoAtivo.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `carrossel-${rascunhoAtivo.id}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setFeedbackMsg({ tipo: 'erro', texto: err instanceof Error ? err.message : 'Falha ao baixar o arquivo ZIP do carrossel.' });
    } finally {
      setBaixandoZip(false);
    }
  };

  const baixarSlideIndividual = (n: number) => {
    const blobUrl = slideBlobUrls[n];
    if (!blobUrl || !rascunhoAtivo) return;
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `slide-${String(n).padStart(2, '0')}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const slugsAprovados = useMemo(() => {
    return new Set(ambientes.filter((a) => a.status === 'aprovada').map((a) => a.produto_slug));
  }, [ambientes]);

  useEffect(() => {
    if (mode === 'demo') return;
    let cancelado = false;
    const idsPrevia =
      abaAtiva === 'rascunhos' ? extrairIdsAmbienteDaPrevia(rascunhoAtivo?.html_email_preview || '') : [];
    const idsPreviaSet = new Set(idsPrevia);
    const idsGaleria =
      abaAtiva === 'ambientes'
        ? ambientes
            .filter(
              (a) =>
                a.status !== 'recusada' &&
                (filtroSlugAmbiente === 'todos' || a.produto_slug === filtroSlugAmbiente),
            )
            .flatMap((a) => [a.id, `${a.id}_4x5`])
        : [];
    const idsNecessarios = Array.from(new Set([...idsGaleria, ...idsPrevia]));
    const faltantes = idsNecessarios.filter(
      (id) =>
        !ambienteFalhasRef.current.has(id) &&
        (!ambienteBlobsRef.current[id] || (idsPreviaSet.has(id) && !ambienteDataRef.current[id])),
    );
    if (faltantes.length === 0) return;

    const blobParaDataUrl = (blob: Blob): Promise<string> =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => reject(reader.error || new Error('Falha ao ler imagem'));
        reader.readAsDataURL(blob);
      });

    void Promise.all(
      faltantes.map(async (id) => {
        try {
          const blob = await service.ambienteImagemBlob(id);
          const blobUrl = ambienteBlobsRef.current[id] ? undefined : URL.createObjectURL(blob);
          const dataUrl = idsPreviaSet.has(id) && !ambienteDataRef.current[id] ? await blobParaDataUrl(blob) : undefined;
          return { id, blobUrl, dataUrl, falhou: false as const };
        } catch {
          return { id, blobUrl: undefined, dataUrl: undefined, falhou: true as const };
        }
      }),
    ).then((resultados) => {
      if (cancelado) {
        resultados.forEach((item) => {
          if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
        });
        return;
      }
      let alterouBlob = false;
      let alterouData = false;
      let alterouFalha = false;
      for (const item of resultados) {
        if (item.falhou) {
          if (!ambienteFalhasRef.current.has(item.id)) {
            ambienteFalhasRef.current.add(item.id);
            alterouFalha = true;
          }
          continue;
        }
        if (item.blobUrl) {
          if (!ambienteBlobsRef.current[item.id]) {
            ambienteBlobsRef.current[item.id] = item.blobUrl;
            alterouBlob = true;
          } else {
            URL.revokeObjectURL(item.blobUrl);
          }
        }
        if (item.dataUrl && !ambienteDataRef.current[item.id]) {
          ambienteDataRef.current[item.id] = item.dataUrl;
          alterouData = true;
        }
      }
      if (alterouBlob) setAmbienteBlobUrls({ ...ambienteBlobsRef.current });
      if (alterouData) setAmbienteDataUrls({ ...ambienteDataRef.current });
      if (alterouFalha) {
        const mapa: Record<string, boolean> = {};
        ambienteFalhasRef.current.forEach((fid) => {
          mapa[fid] = true;
        });
        setAmbienteFalhas(mapa);
      }
    });

    return () => {
      cancelado = true;
    };
  }, [abaAtiva, ambientes, filtroSlugAmbiente, mode, rascunhoAtivo?.html_email_preview, service]);

  useEffect(() => {
    const blobs = ambienteBlobsRef.current;
    return () => {
      Object.values(blobs).forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const layoutAntigo = Boolean(rascunhoAtivo && (!rascunhoAtivo.copy?.cards || rascunhoAtivo.copy.cards.length !== 3));
  const imagemRecusadaNoRascunho = useMemo(() => {
    if (!rascunhoAtivo?.imagens || ambientes.length === 0) return false;
    const ids = [
      rascunhoAtivo.imagens.hero,
      ...(rascunhoAtivo.imagens.cards || []),
      rascunhoAtivo.imagens.carrossel,
    ].filter(Boolean);
    const mapaStatus = new Map(ambientes.map((a) => [a.id, a.status]));
    return ids.some((id) => {
      const st = mapaStatus.get(id);
      return st !== undefined && st !== 'aprovada';
    });
  }, [ambientes, rascunhoAtivo]);

  const handleAprovarAmbiente = (id: string) => {
    startTransition(async () => {
      try {
        await service.aprovarAmbiente(id);
        await carregarDados();
        setFeedbackMsg({ tipo: 'ok', texto: 'Imagem de ambiente aprovada e liberada para o RD Station.' });
      } catch (err: unknown) {
        setFeedbackMsg({ tipo: 'erro', texto: err instanceof Error ? err.message : 'Falha ao aprovar ambiente.' });
      }
    });
  };

  const handleRecusarAmbiente = (id: string) => {
    startTransition(async () => {
      try {
        await service.recusarAmbiente(id);
        await carregarDados();
        setFeedbackMsg({ tipo: 'ok', texto: 'Imagem de ambiente recusada.' });
      } catch (err: unknown) {
        setFeedbackMsg({ tipo: 'erro', texto: err instanceof Error ? err.message : 'Falha ao recusar ambiente.' });
      }
    });
  };

  const handleGerarAmbientes = (slug: string) => {
    startTransition(async () => {
      setGerandoAmbientes(true);
      try {
        const msg = await service.gerarAmbientes(slug, 4);
        setFeedbackMsg({ tipo: 'ok', texto: msg });
        const st = await service.status();
        setStatus(st);
        await carregarDados();
      } catch (err: unknown) {
        setFeedbackMsg({ tipo: 'erro', texto: err instanceof Error ? err.message : 'Falha ao solicitar geração de opções.' });
      } finally {
        setGerandoAmbientes(false);
      }
    });
  };

  const catalogoFiltrado = catalogo.filter((p) => {
    if (!filtroBuscaCatalogo) return true;
    const q = filtroBuscaCatalogo.toLowerCase();
    return (
      p.nome.toLowerCase().includes(q) ||
      (p.referencia && p.referencia.toLowerCase().includes(q)) ||
      (p.categoria_oficial && p.categoria_oficial.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">E-mail Marketing</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Toda sexta são geradas as edições de segunda e quinta da semana seguinte, ligando uma pauta de arquitetura a um produto da marca Norvia. Depois de aprovada, a edição é copiada para o RD Station e o kit para o Instagram — nada é enviado daqui.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={carregarDados}
            disabled={isPending}
            className="rounded-none text-xs border-border"
          >
            <RefreshCw size={13} className={`mr-1.5 ${isPending ? 'animate-spin' : ''}`} />
            Atualizar
          </Button>

          <Button
            variant="cta"
            size="sm"
            onClick={handleGerarLote}
            disabled={isPending || gerando}
            className="rounded-none text-xs font-semibold"
          >
            <RefreshCw size={13} className={`mr-1.5 ${gerando ? 'animate-spin' : ''}`} />
            {gerando ? 'Gerando edições…' : 'Gerar edições da semana'}
          </Button>
        </div>
      </div>

      {erroCarga && (
        <div role="alert" className="rounded-none border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-700 dark:text-rose-300">
          {erroCarga}
        </div>
      )}

      {feedbackMsg && (
        <div
          role={feedbackMsg.tipo === 'erro' ? 'alert' : 'status'}
          className={`p-3 text-xs flex items-center justify-between border rounded-none ${
            feedbackMsg.tipo === 'ok'
              ? 'bg-emerald-500/5 border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
              : 'bg-rose-500/5 border-rose-500/30 text-rose-700 dark:text-rose-300'
          }`}
        >
          <div className="flex items-center gap-2">
            {feedbackMsg.tipo === 'ok' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
            <span>{feedbackMsg.texto}</span>
          </div>
          <button onClick={() => setFeedbackMsg(null)} className="text-xs underline opacity-80 hover:opacity-100">
            Fechar
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="rounded-none border border-border bg-card p-3">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">Edições da semana</span>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-xl font-bold font-mono text-foreground">{rascunhos.length}</span>
            <span className="text-xs text-muted-foreground">segunda e quinta</span>
          </div>
        </div>

        <div className="rounded-none border border-border bg-card p-3">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">Aprovadas / pendentes</span>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-xl font-bold font-mono text-emerald-700 dark:text-emerald-400">
              {rascunhos.filter((r) => r.status === 'aprovado').length}
            </span>
            <span className="text-xs text-muted-foreground">/</span>
            <span className="text-xl font-bold font-mono text-amber-700 dark:text-amber-400">
              {rascunhos.filter((r) => r.status === 'pendente_aprovacao').length}
            </span>
          </div>
        </div>

        <div className="rounded-none border border-border bg-card p-3">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">Banco de Ambientes</span>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-xl font-bold font-mono text-foreground">{ambientes.filter((a) => a.status === 'aprovada').length}</span>
            <span className="text-xs text-muted-foreground">aprovadas</span>
          </div>
          <span className="text-[10px] text-muted-foreground mt-0.5 block">
            {status?.imagens_geradas_hoje ?? 0}/{status?.imagens_limite_dia ?? 20} geradas hoje ({status?.provedor_imagem ?? 'gemini'})
          </span>
        </div>

        <div className="rounded-none border border-border bg-card p-3">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">Produtos da marca</span>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-xl font-bold font-mono text-foreground">{status?.total_produtos_marca_propria ?? '—'}</span>
            <span className="text-xs text-muted-foreground">de {status?.total_produtos_catalogo ?? '—'} no site</span>
          </div>
        </div>

        <div className="rounded-none border border-border bg-card p-3">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">Próxima geração</span>
          <div className="mt-1 text-xs font-semibold text-foreground truncate">
            {status ? (status.proxima_geracao_sexta ?? 'Automática desligada') : '—'}
          </div>
          <span className="text-[10px] text-muted-foreground mt-0.5 block">
            {status && status.ia_configurada.length === 0 ? 'Sem IA configurada: texto-base do catálogo' : status?.ia_configurada.join(', ')}
          </span>
        </div>
      </div>

      {/* Tabs Principais */}
      <Tabs value={abaAtiva} onValueChange={setAbaAtiva} className="w-full">
        <TabsList className="rounded-none bg-muted/60 p-1 border border-border">
          <TabsTrigger value="rascunhos" className="rounded-none text-xs font-medium">
            <Mail size={14} className="mr-1.5" />
            Edições da Semana ({rascunhos.length})
          </TabsTrigger>
          <TabsTrigger value="ambientes" className="rounded-none text-xs font-medium">
            <ImageIcon size={14} className="mr-1.5" />
            Banco de Ambientes ({ambientes.length})
          </TabsTrigger>
          <TabsTrigger value="catalogo" className="rounded-none text-xs font-medium">
            <ShoppingBag size={14} className="mr-1.5" />
            Catálogo Norvia ({catalogo.length})
          </TabsTrigger>
          <TabsTrigger value="execucoes" className="rounded-none text-xs font-medium">
            <Clock size={14} className="mr-1.5" />
            Histórico de Execuções ({execucoes.length})
          </TabsTrigger>
        </TabsList>

        {/* TAB 1: RASCUNHOS DA SEMANA (SEG E QUI) */}
        <TabsContent value="rascunhos" className="space-y-4 mt-4">
          {rascunhos.length === 0 ? (
            <div className="rounded-none border border-dashed border-border p-8 text-center bg-card">
              <Mail className="mx-auto h-8 w-8 text-muted-foreground/60 mb-2" />
              <p className="text-sm font-semibold text-foreground">Nenhum rascunho gerado no momento</p>
              <p className="text-xs text-muted-foreground mt-1 mb-4">
                Clique no botão abaixo para disparar a rotina de curadoria editorial de arquitetura.
              </p>
              <Button variant="cta" size="sm" onClick={handleGerarLote} className="rounded-none text-xs font-semibold">
                Gerar Lote Semanal Agora
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Coluna Esquerda: Seletor de Edição e Detalhes da Pauta */}
              <div className="lg:col-span-5 space-y-4">
                {/* Abas Segunda vs Quinta */}
                <div className="grid grid-cols-2 gap-2">
                  {rascunhos.map((r) => {
                    const isAtivo = r.id === rascunhoAtivo?.id;
                    return (
                      <button
                        key={r.id}
                        onClick={() => setEdicaoAtivaId(r.id)}
                        className={`p-3 text-left border rounded-none transition-all ${
                          isAtivo
                            ? 'border-amber-500 bg-amber-500/5 shadow-sm'
                            : 'border-border bg-card hover:bg-muted/40'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-bold text-foreground">{r.dia_semana}</span>
                          {r.status === 'aprovado' ? (
                            <Badge className="rounded-none bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30 text-[10px] py-0 px-1.5">
                              Aprovado
                            </Badge>
                          ) : (
                            <Badge className="rounded-none bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/30 text-[10px] py-0 px-1.5">
                              Pendente
                            </Badge>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground line-clamp-1 font-mono">
                          {r.produto_nome.split(' - ')[0]}
                        </p>
                      </button>
                    );
                  })}
                </div>

                {rascunhoAtivo && (
                  <div className="rounded-none border border-border bg-card p-4 space-y-4">
                    {/* Ações de Aprovação e Exportação */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-border">
                      <div>
                        <span className="text-xs font-semibold text-foreground block">
                          Edição #{rascunhoAtivo.edicao_numero} • {rascunhoAtivo.dia_semana} ({rascunhoAtivo.data_prevista})
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {rascunhoAtivo.status === 'aprovado'
                            ? `Aprovada por ${rascunhoAtivo.aprovado_por ?? '—'}`
                            : 'Aguardando aprovação'}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        {rascunhoAtivo.status !== 'aprovado' && (
                          <Button
                            variant="cta"
                            size="sm"
                            onClick={() => handleAprovar(rascunhoAtivo.id)}
                            disabled={isPending}
                            className="rounded-none text-xs font-semibold"
                          >
                            <CheckCircle2 size={13} className="mr-1.5" />
                            Aprovar Edição
                          </Button>
                        )}

                        <Button
                          variant="outline"
                          size="sm"
                          onClick={copiarParaRdStation}
                          disabled={imagemRecusadaNoRascunho || layoutAntigo}
                          className="rounded-none text-xs border-border"
                        >
                          {copiadoRd ? <Check size={13} className="mr-1.5 text-emerald-700 dark:text-emerald-400" /> : <Copy size={13} className="mr-1.5" />}
                          {copiadoRd ? 'Copiado!' : 'Copiar HTML (RD)'}
                        </Button>

                        <Button
                          variant="outline"
                          size="sm"
                          onClick={copiarKitInstagram}
                          className="rounded-none text-xs border-border"
                        >
                          {copiadoInsta ? <Check size={13} className="mr-1.5 text-emerald-700 dark:text-emerald-400" /> : <Share2 size={13} className="mr-1.5" />}
                          {copiadoInsta ? 'Copiado!' : 'Copiar kit Instagram'}
                        </Button>

                      </div>
                    </div>

                    {layoutAntigo && (
                      <div className="border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                        Rascunho no layout antigo: gere de novo para atualizar para o padrão Arch Journal.
                      </div>
                    )}

                    {imagemRecusadaNoRascunho && (
                      <div className="border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                        Imagem recusada: troque o produto ou gere de novo antes de copiar para o RD Station.
                      </div>
                    )}

                    {/* Dados Editoriais */}
                    <div className="space-y-3 text-xs">
                      {rascunhoAtivo.copy?.selo_pauta && (
                        <div>
                          <Badge variant="outline" className="rounded-none text-[10px] font-mono uppercase border-amber-500/40 text-amber-600 dark:text-amber-400">
                            {rascunhoAtivo.copy.selo_pauta}
                          </Badge>
                        </div>
                      )}

                      <div>
                        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block">
                          Assunto Principal (RD Station)
                        </span>
                        <p className="font-semibold text-foreground mt-0.5">{rascunhoAtivo.copy?.assunto}</p>
                        {rascunhoAtivo.copy?.assunto_alt && (
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            <span className="font-mono text-muted-foreground">Teste A/B:</span> {rascunhoAtivo.copy.assunto_alt}
                          </p>
                        )}
                      </div>

                      <div>
                        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block">
                          Preheader (Preview)
                        </span>
                        <p className="text-muted-foreground mt-0.5">{rascunhoAtivo.copy?.preheader}</p>
                      </div>

                      {rascunhoAtivo.copy?.titulo_principal && (
                        <div>
                          <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block">
                            Manchete Principal
                          </span>
                          <p className="font-bold text-foreground text-sm mt-0.5">{rascunhoAtivo.copy.titulo_principal}</p>
                        </div>
                      )}

                      {rascunhoAtivo.copy?.texto_hero && (
                        <div>
                          <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block">
                            Texto Hero
                          </span>
                          <p className="text-foreground mt-0.5 leading-relaxed">{rascunhoAtivo.copy.texto_hero}</p>
                          {rascunhoAtivo.copy.destaque_hero && (
                            <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                              <strong>Destaque em negrito:</strong> &ldquo;{rascunhoAtivo.copy.destaque_hero}&rdquo;
                            </p>
                          )}
                        </div>
                      )}

                      <div>
                        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block">
                          {rascunhoAtivo.pauta === 'guia_tecnico' || !rascunhoAtivo.artigo_titulo
                            ? 'Edição Técnica Norvia'
                            : 'Pauta de Arquitetura de Referência'}
                        </span>
                        {rascunhoAtivo.pauta === 'guia_tecnico' || !rascunhoAtivo.artigo_titulo ? (
                          <p className="text-muted-foreground mt-0.5 italic">
                            Sem matéria da semana ligada ao produto — edição técnica
                          </p>
                        ) : (
                          <p className="text-foreground mt-0.5">
                            <span className="font-medium text-foreground">{rascunhoAtivo.artigo_fonte}:</span> {rascunhoAtivo.artigo_titulo}
                            {rascunhoAtivo.artigo_url && (
                              <a
                                href={rascunhoAtivo.artigo_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center ml-1.5 text-amber-600 dark:text-amber-400 hover:underline"
                                title="Abrir matéria original"
                              >
                                <ExternalLink size={11} className="inline" />
                              </a>
                            )}
                          </p>
                        )}
                      </div>

                      {rascunhoAtivo.copy?.cards && rascunhoAtivo.copy.cards.length > 0 && (
                        <div className="border border-border p-2.5 bg-muted/20 space-y-2">
                          <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block">
                            Caderno de Especificação ({rascunhoAtivo.copy.cards.length} cards)
                          </span>
                          <div className="space-y-1.5">
                            {rascunhoAtivo.copy.cards.map((c, i) => (
                              <div key={i} className="border border-border bg-card p-2 text-[11px] space-y-0.5">
                                <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground">
                                  <span>CARD #{i + 1} — {c.pasta_tema}</span>
                                  <span className="text-amber-600 dark:text-amber-400 font-semibold">{c.produto_slug}</span>
                                </div>
                                <p className="font-medium text-foreground">&ldquo;{c.frase}&rdquo;</p>
                                <Badge variant="outline" className="rounded-none text-[9px] py-0 px-1 border-border">
                                  {c.etiqueta_tecnica}
                                </Badge>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Troca de Produto Norvia */}
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <label htmlFor="select-produto-norvia" className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                            Produto Norvia em Destaque
                          </label>
                          {gerando && (
                            <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium animate-pulse">
                              Refazendo a edição…
                            </span>
                          )}
                        </div>

                        <select
                          id="select-produto-norvia"
                          value={rascunhoAtivo.produto_slug}
                          onChange={(e) => handleTrocarProduto(rascunhoAtivo.id, e.target.value)}
                          disabled={isPending || gerando || rascunhoAtivo.status === 'aprovado'}
                          className="w-full bg-background border border-border text-foreground text-xs p-2 rounded-none focus:outline-none focus:ring-1 focus:ring-amber-500 font-medium disabled:opacity-50"
                        >
                          {produtosEditoriais.map((prod) => {
                            const elegivel = slugsAprovados.has(prod.slug);
                            return (
                              <option key={prod.slug} value={prod.slug} disabled={!elegivel}>
                                {prod.nome_curto} (Ref. {prod.referencia}){!elegivel ? ' — (sem imagem aprovada)' : ''}
                              </option>
                            );
                          })}
                        </select>
                        <p className="text-[11px] text-muted-foreground mt-1">
                          {rascunhoAtivo.copy?.chamada_produto_texto}
                        </p>
                      </div>

                      {/* Painel Carrossel Instagram */}
                      <div className="border border-border p-3 bg-muted/20 space-y-3 rounded-none">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
                          <div className="flex items-center gap-1.5 text-foreground font-semibold text-xs">
                            <Share2 size={13} />
                            <span>
                              Carrossel Instagram ({rascunhoAtivo.carrossel_slides || rascunhoAtivo.copy?.carrossel?.length || rascunhoAtivo.copy?.slides_instagram?.length || 0} slides)
                            </span>
                          </div>

                          <div className="flex items-center gap-1.5">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={copiarLegendaInstagram}
                              className="rounded-none text-[11px] h-7 px-2 border-border"
                              disabled={!rascunhoAtivo.copy?.legenda_instagram}
                            >
                              {copiadoLegenda ? <Check size={12} className="mr-1 text-emerald-700 dark:text-emerald-400" /> : <Copy size={12} className="mr-1" />}
                              {copiadoLegenda ? 'Copiada!' : 'Copiar legenda'}
                            </Button>

                            {mode !== 'demo' && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={baixarZipCarrossel}
                                disabled={baixandoZip || Boolean(rascunhoAtivo.carrossel_erro)}
                                className="rounded-none text-[11px] h-7 px-2 border-border"
                              >
                                <Download size={12} className={`mr-1 ${baixandoZip ? 'animate-spin' : ''}`} />
                                {baixandoZip ? 'Baixando…' : 'Baixar todos (.zip)'}
                              </Button>
                            )}
                          </div>
                        </div>

                        {rascunhoAtivo.carrossel_erro && (
                          <div className="text-[11px] text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 p-2">
                            Aviso: Imagens do carrossel indisponíveis ({rascunhoAtivo.carrossel_erro}).
                          </div>
                        )}

                        {carregandoSlides && (
                          <p className="text-[11px] text-muted-foreground animate-pulse">Carregando miniaturas do carrossel…</p>
                        )}

                        {/* Grid de slides */}
                        {rascunhoAtivo.copy?.carrossel && rascunhoAtivo.copy.carrossel.length > 0 ? (
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {rascunhoAtivo.copy.carrossel.map((slide, idx) => {
                              const slideNum = idx + 1;
                              const imgUrl = slideBlobUrls[slideNum];
                              return (
                                <div
                                  key={slideNum}
                                  className="border border-border bg-card p-2 flex flex-col justify-between text-[11px] space-y-1.5"
                                >
                                  <div className="flex items-center justify-between">
                                    <span className="font-mono font-bold text-[10px] text-muted-foreground">
                                      {slideNum}/{rascunhoAtivo.copy.carrossel!.length}
                                    </span>
                                    <Badge variant="outline" className="text-[9px] uppercase px-1 py-0 rounded-none border-border">
                                      {slide.tipo}
                                    </Badge>
                                  </div>

                                  {imgUrl ? (
                                    <div className="aspect-[4/5] bg-neutral-900 border border-border/40 overflow-hidden relative group">
                                      {/* oxlint-disable-next-line next/no-img-element -- blob: URL autenticado gerado em memória */}
                                      <img
                                        src={imgUrl}
                                        alt={`Slide ${slideNum}: ${slide.titulo}`}
                                        className="w-full h-full object-cover"
                                      />
                                      <button
                                        onClick={() => baixarSlideIndividual(slideNum)}
                                        title="Baixar slide individual"
                                        className="absolute bottom-1 right-1 bg-black/75 hover:bg-black text-white p-1 opacity-0 group-hover:opacity-100 transition-opacity rounded-none"
                                      >
                                        <Download size={11} />
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="bg-muted/40 p-2 space-y-1 min-h-[90px] flex flex-col justify-center">
                                      <p className="font-bold text-foreground text-[10px] line-clamp-2">{slide.titulo}</p>
                                      <p className="text-muted-foreground text-[10px] line-clamp-3">{slide.texto}</p>
                                    </div>
                                  )}

                                  {imgUrl && (
                                    <button
                                      onClick={() => baixarSlideIndividual(slideNum)}
                                      className="w-full text-center text-[10px] py-0.5 border border-border hover:bg-muted text-muted-foreground hover:text-foreground flex items-center justify-center gap-1"
                                    >
                                      <Download size={10} />
                                      Baixar JPEG
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          /* Fallback para rascunhos antigos com slides_instagram */
                          <ul className="space-y-1 text-[11px] text-muted-foreground list-disc pl-4">
                            {(rascunhoAtivo.copy?.slides_instagram || []).map((s, i) => (
                              <li key={i}>{s}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Prévia do e-mail (iframe sem scripts) */}
              <div className="lg:col-span-7 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileCode size={14} className="text-muted-foreground" />
                    <span className="text-xs font-bold text-foreground">Prévia do e-mail</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground">O HTML copiado para o RD usa as imagens do site</span>
                </div>

                <div className="rounded-none border border-border bg-neutral-900 overflow-hidden shadow-inner flex justify-center p-2">
                  <iframe
                    title="Prévia do E-mail Marketing Norvia"
                    srcDoc={substituirAmbientesPorDataUrls(
                      prefixarImagensDaPrevia(
                        rascunhoAtivo?.html_email_preview || '<p style="padding:20px;font-family:sans-serif;">Prévia indisponível.</p>',
                        BASE_PATH,
                      ),
                      ambienteDataUrls,
                    )}
                    className="w-full max-w-[620px] h-[780px] bg-white border-0"
                    sandbox=""
                  />
                </div>
              </div>
            </div>
          )}
        </TabsContent>

        {/* TAB 2: BANCO DE AMBIENTES */}
        <TabsContent value="ambientes" className="space-y-4 mt-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-card border border-border p-3 rounded-none">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Filtrar por linha:</span>
              <select
                value={filtroSlugAmbiente}
                onChange={(e) => setFiltroSlugAmbiente(e.target.value)}
                className="bg-background border border-border text-foreground text-xs p-1.5 rounded-none font-medium"
              >
                <option value="todos">Todas as linhas editoriais ({produtosEditoriais.length})</option>
                {produtosEditoriais.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.nome_curto} ({ambientes.filter((a) => a.produto_slug === p.slug).length} imagens)
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>
                Cota do dia: <strong className="text-foreground">{status?.imagens_geradas_hoje ?? 0}</strong> de{' '}
                <strong className="text-foreground">{status?.imagens_limite_dia ?? 20}</strong> geradas
              </span>
              <span>•</span>
              <span>Provedor: <strong className="text-foreground">{status?.provedor_imagem ?? 'gemini'}</strong></span>
            </div>
          </div>

          <div className="space-y-6">
            {produtosEditoriais
              .filter((p) => filtroSlugAmbiente === 'todos' || p.slug === filtroSlugAmbiente)
              .map((prod) => {
                const fotosLinha = ambientes.filter((a) => a.produto_slug === prod.slug);
                const aprovadasLinha = fotosLinha.filter((a) => a.status === 'aprovada');
                const candidatasLinha = fotosLinha.filter((a) => a.status === 'candidata');

                return (
                  <div key={prod.slug} className="border border-border bg-card p-4 space-y-4 rounded-none">
                    {/* Header da Linha */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-3">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 bg-white border border-border flex items-center justify-center p-1 shrink-0 overflow-hidden">
                          {/* oxlint-disable-next-line next/no-img-element -- render 3D de referência */}
                          <img
                            src={
                              prod.render_3d
                                ? `${BASE_PATH}/marketing/produtos/${prod.render_3d}`
                                : prod.imagem_preview || `${BASE_PATH}/marketing/produtos/${prod.slug}.png`
                            }
                            alt={`Render 3D ${prod.nome_curto}`}
                            className="w-full h-full object-contain"
                            onError={(e) => {
                              (e.target as HTMLElement).style.display = 'none';
                            }}
                          />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-bold text-sm text-foreground">{prod.nome_curto}</h3>
                            <span className="text-[10px] font-mono text-muted-foreground font-bold">REF: {prod.referencia}</span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">{prod.resumo_card}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <Badge
                              variant="outline"
                              className={`rounded-none text-[10px] px-1.5 py-0 ${
                                aprovadasLinha.length > 0
                                  ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400'
                                  : 'border-amber-500/40 text-amber-600 dark:text-amber-400'
                              }`}
                            >
                              {aprovadasLinha.length > 0 ? `${aprovadasLinha.length} aprovada(s) (elegível)` : 'Sem imagem aprovada'}
                            </Badge>
                            {candidatasLinha.length > 0 && (
                              <Badge variant="outline" className="rounded-none text-[10px] px-1.5 py-0 border-amber-500/40 text-amber-600 dark:text-amber-400">
                                {candidatasLinha.length} candidata(s) aguardando
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleGerarAmbientes(prod.slug)}
                          disabled={isPending || gerandoImagens}
                          className="rounded-none text-xs border-border"
                        >
                          <Sparkles size={13} className="mr-1.5 text-amber-500" />
                          {gerandoImagens ? 'Gerando opções...' : 'Gerar 4 opções com IA'}
                        </Button>
                      </div>
                    </div>

                    {/* Galeria de Fotos da Linha */}
                    {fotosLinha.length === 0 ? (
                      <div className="p-6 text-center border border-dashed border-border text-muted-foreground text-xs">
                        Nenhuma imagem cadastrada para esta linha. Clique em &ldquo;Gerar 4 opções com IA&rdquo; para criar candidatos.
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                        {fotosLinha.map((foto) => (
                          <div
                            key={foto.id}
                            className={`border bg-background p-2 flex flex-col justify-between text-xs space-y-2 rounded-none ${
                              foto.status === 'aprovada'
                                ? 'border-emerald-600/40'
                                : foto.status === 'candidata'
                                ? 'border-amber-500/40'
                                : 'border-border opacity-60'
                            }`}
                          >
                            <div className="flex items-center justify-between text-[10px]">
                              <Badge
                                variant="outline"
                                className={`rounded-none text-[9px] uppercase px-1 py-0 ${
                                  foto.status === 'aprovada'
                                    ? 'border-emerald-600 text-emerald-700 dark:text-emerald-400'
                                    : foto.status === 'candidata'
                                    ? 'border-amber-500 text-amber-600 dark:text-amber-400'
                                    : 'border-border text-muted-foreground'
                                }`}
                              >
                                {foto.status}
                              </Badge>
                              <span className="font-mono text-muted-foreground text-[10px]">
                                {Math.round(foto.tamanho_bytes / 1024)} KB
                              </span>
                            </div>

                            <div className="grid grid-cols-2 gap-1.5">
                              <div className="aspect-[3/2] bg-neutral-900 border border-border/40 overflow-hidden relative flex items-center justify-center">
                                {ambienteBlobUrls[foto.id] ? (
                                  /* oxlint-disable-next-line next/no-img-element -- preview da imagem de ambiente 3:2 via blob */
                                  <img
                                    src={ambienteBlobUrls[foto.id]}
                                    alt={foto.descricao || foto.id}
                                    className="w-full h-full object-cover"
                                  />
                                ) : foto.status === 'recusada' ? (
                                  <span className="text-[10px] font-mono text-muted-foreground">Recusada</span>
                                ) : ambienteFalhas[foto.id] ? (
                                  <span className="text-[10px] font-mono text-muted-foreground">Indisponível</span>
                                ) : (
                                  <span className="text-[10px] font-mono text-muted-foreground">Carregando...</span>
                                )}
                                <span className="absolute bottom-0.5 left-0.5 bg-black/70 text-white text-[9px] font-mono px-1">3:2</span>
                              </div>
                              <div className="aspect-[4/5] bg-neutral-900 border border-border/40 overflow-hidden relative flex items-center justify-center">
                                {ambienteBlobUrls[`${foto.id}_4x5`] ? (
                                  /* oxlint-disable-next-line next/no-img-element -- preview da imagem de ambiente 4:5 via blob */
                                  <img
                                    src={ambienteBlobUrls[`${foto.id}_4x5`]}
                                    alt={`${foto.descricao || foto.id} (4:5)`}
                                    className="w-full h-full object-cover"
                                  />
                                ) : foto.status === 'recusada' ? (
                                  <span className="text-[10px] font-mono text-muted-foreground">Recusada</span>
                                ) : ambienteFalhas[`${foto.id}_4x5`] ? (
                                  <span className="text-[10px] font-mono text-muted-foreground">Indisponível</span>
                                ) : (
                                  <span className="text-[10px] font-mono text-muted-foreground">4:5...</span>
                                )}
                                <span className="absolute bottom-0.5 left-0.5 bg-black/70 text-white text-[9px] font-mono px-1">
                                  {foto.formato_4x5 === 'recorte' ? '4:5 recorte' : '4:5 IA'}
                                </span>
                              </div>
                            </div>

                            <div className="space-y-1 text-[11px]">
                              <p className="text-foreground line-clamp-2" title={foto.prompt || foto.descricao}>
                                {foto.descricao || foto.prompt}
                              </p>
                              <div className="text-[10px] text-muted-foreground flex items-center justify-between font-mono">
                                <span>{foto.provedor}</span>
                                <span>{foto.largura}x{foto.altura}</span>
                              </div>
                              {foto.status === 'aprovada' && (
                                <p className="text-[10px] text-emerald-700 dark:text-emerald-400">
                                  Aprovada por {foto.aprovada_por ?? 'sistema'}
                                </p>
                              )}
                              {foto.status === 'recusada' && (
                                <p className="text-[10px] text-muted-foreground">
                                  Recusada por {foto.recusada_por ?? 'usuário'}
                                </p>
                              )}
                            </div>

                            {foto.status === 'candidata' && (
                              <div className="flex items-center gap-1.5 pt-1 border-t border-border">
                                <Button
                                  variant="cta"
                                  size="sm"
                                  onClick={() => handleAprovarAmbiente(foto.id)}
                                  disabled={isPending}
                                  className="rounded-none text-[11px] h-7 flex-1 font-semibold"
                                >
                                  <Check size={11} className="mr-1" />
                                  Aprovar
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleRecusarAmbiente(foto.id)}
                                  disabled={isPending}
                                  className="rounded-none text-[11px] h-7 px-2 border-border text-muted-foreground hover:text-foreground"
                                >
                                  <XCircle size={11} className="mr-1" />
                                  Recusar
                                </Button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </TabsContent>

        {/* Catálogo: só produtos da marca Norvia (sem revenda) */}
        <TabsContent value="catalogo" className="space-y-4 mt-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-card border border-border p-3 rounded-none">
            <div className="relative flex-1 max-w-md">
              <Search size={14} className="absolute left-2.5 top-2.5 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Filtrar por nome, SKU (ex: NRVRPI02) ou categoria..."
                value={filtroBuscaCatalogo}
                onChange={(e) => setFiltroBuscaCatalogo(e.target.value)}
                className="pl-8 text-xs rounded-none bg-background border-border h-8"
              />
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Exibindo: <strong className="text-foreground">{catalogoFiltrado.length}</strong> produtos marca própria</span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {catalogoFiltrado.slice(0, 36).map((prod, idx) => (
              <div key={idx} className="rounded-none border border-border bg-card p-3 space-y-2 flex flex-col justify-between">
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[10px] font-mono text-muted-foreground font-bold uppercase tracking-wider">
                      REF: {prod.referencia || 'NORVIA'}
                    </span>
                    <Badge variant="outline" className="rounded-none text-[9px] py-0 px-1 border-border text-muted-foreground">
                      {prod.marca || 'Norvia'}
                    </Badge>
                  </div>

                  <h3 className="text-xs font-bold text-foreground mt-1 line-clamp-2">
                    {prod.nome}
                  </h3>

                  <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2">
                    {prod.descricao_completa_site || 'Acabamento técnico para arquitetura de interiores fabricado em alumínio resistente.'}
                  </p>
                </div>

                <div className="pt-2 border-t border-border/60 flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground">
                    {prod.preco_por ? `R$ ${prod.preco_por.toFixed(2)}` : 'Consulte no site'}
                  </span>

                  <a
                    href={prod.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-foreground hover:underline"
                  >
                    <span>Ver no site</span>
                    <ExternalLink size={11} />
                  </a>
                </div>
              </div>
            ))}
          </div>
        </TabsContent>

        {/* Histórico: gerações, aprovações e trocas de produto */}
        <TabsContent value="execucoes" className="space-y-4 mt-4">
          <div className="rounded-none border border-border bg-card overflow-hidden">
            <div className="p-3 border-b border-border flex items-center justify-between bg-muted/30">
              <span className="text-xs font-bold text-foreground">Log Operacional de Execuções e Auditoria</span>
              <span className="text-[10px] text-muted-foreground font-mono">Últimas 50 operações registradas</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/40 text-muted-foreground font-semibold border-b border-border">
                  <tr>
                    <th className="p-2.5">Horário</th>
                    <th className="p-2.5">Tipo de Execução</th>
                    <th className="p-2.5">Status</th>
                    <th className="p-2.5">Detalhes da Operação</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {execucoes.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="p-4 text-center text-muted-foreground">
                        Nenhuma execução registrada até o momento.
                      </td>
                    </tr>
                  ) : (
                    execucoes.map((exec) => (
                      <tr key={exec.id} className="hover:bg-muted/20">
                        <td className="p-2.5 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                          {new Date(exec.timestamp).toLocaleString('pt-BR')}
                        </td>
                        <td className="p-2.5 font-semibold text-foreground">
                          {exec.tipo}
                        </td>
                        <td className="p-2.5">
                          {exec.sucesso ? (
                            <Badge className="rounded-none bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30 text-[10px] py-0 px-1.5">
                              Sucesso
                            </Badge>
                          ) : (
                            <Badge className="rounded-none bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/30 text-[10px] py-0 px-1.5">
                              Falha
                            </Badge>
                          )}
                        </td>
                        <td className="p-2.5 text-[11px] font-mono text-muted-foreground max-w-md truncate">
                          {JSON.stringify(exec.detalhes)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
