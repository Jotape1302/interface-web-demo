import { hasPermission, type PermissionSession } from "./permissions";
import type {
  Account,
  DashboardResponse,
  Execution,
  DanfeStatusResponse,
  DanfeSefazStatus,
  DanfePendingReviewEntry,
  FinancialDashboardResponse,
  FinancialDashboardStatus,
} from "./contracts";
const names = [
  "Aurora Materiais",
  "Lume Tecnologia",
  "Vértice Serviços",
  "Arco Logística",
  "Norte Papelaria",
  "Brisa Comunicação",
  "Ponto Equipamentos",
  "Cais Consultoria",
  "Orla Suprimentos",
  "Nexo Sistemas",
  "Prisma Facilities",
  "Cedro Transportes",
];
const amounts = [
  "2450.00",
  "890.50",
  "5620.00",
  "1785.90",
  "346.20",
  "2300.00",
  "4199.90",
  "1500.00",
  "780.35",
  "3890.00",
  "1250.00",
  "2840.70",
];
export function makeDemoDashboard(generatedAt = new Date().toISOString()): DashboardResponse {
  const approvals: Account[] = names.map((name, index) => ({
    id: `demo-account-${index + 1}`,
    beneficiary: `${name} (fictício)`,
    cnpj: `00.000.000/00${String(index + 1).padStart(2, "0")}-00`,
    amount: amounts[index],
    dueDate: `2026-09-${String(8 + index).padStart(2, "0")}`,
    status: "AGUARDANDO_APROVACAO",
    transactionId: `DEMO-INT-${String(8401 + index)}`,
    errorLog: null,
    stoppedNode: null,
    updatedAt: "2026-09-08T12:30:00Z",
  }));
  const failureDetails = [
    [
      "Atlas Distribuição",
      "1250.00",
      "Validar código de barras",
      "Código de barras inválido: dígito verificador divergente. O documento recebido não passou pela validação local e não foi encaminhado ao banco.\nAção sugerida: conferir o documento original com o fornecedor antes de reprocessar.",
    ],
    [
      "Senda Serviços",
      "3480.00",
      "Consultar título no Inter",
      "O serviço bancário não respondeu dentro do limite de 30 segundos. Consulta encerrada sem confirmação de resultado.\nAção sugerida: verificar o estado da transação no banco antes de repetir a solicitação, evitando duplicidade.",
    ],
    [
      "Vila Escritórios",
      "628.90",
      "Enriquecer dados do favorecido",
      "Dados do favorecido incompletos: CNPJ ausente no registro de origem. O fluxo interrompeu a etapa de enriquecimento.\nAção sugerida: corrigir o cadastro no ERP e revisar a correspondência do documento.",
    ],
    [
      "Horizonte Digital",
      "2190.00",
      "Baixar conta no Tiny",
      "A atualização do título no ERP retornou conflito de estado. O registro local permanece em falha até conferência.\nAção sugerida: comparar o estado no ERP com o retorno bancário e reconciliar o registro.",
    ],
  ];
  const failures: Account[] = failureDetails.map(
    ([name, amount, stoppedNode, errorLog], index) => ({
      id: `demo-failure-${index + 1}`,
      beneficiary: `${name} (fictício)`,
      cnpj: `00.000.000/01${String(index + 1).padStart(2, "0")}-00`,
      amount,
      dueDate: "2026-09-10",
      status: "FALHA",
      transactionId: null,
      errorLog,
      stoppedNode,
      updatedAt: `2026-09-08T${String(12 - index).padStart(2, "0")}:20:00Z`,
    }),
  );
  // Histórico completo de 14 dias (01/09 a 14/09), exatamente alinhado com a Visão Geral
  // Inclui o dia 09/09/2026 com 4 execuções (2 sucessos e 2 erros), além de todos os outros dias
  const executionPresets = [
    // 14/09/2026 (Hoje)
    { status: "running" as const, startedAt: "2026-09-14T10:32:00Z", durationMs: null, stoppedNode: null },
    { status: "waiting" as const, startedAt: "2026-09-14T10:31:00Z", durationMs: null, stoppedNode: "Aguardar aprovação" },
    { status: "success" as const, startedAt: "2026-09-14T10:30:00Z", durationMs: 24000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-14T08:15:00Z", durationMs: 14000, stoppedNode: "Consultar título no Inter" },
    { status: "success" as const, startedAt: "2026-09-14T08:14:00Z", durationMs: 22000, stoppedNode: null },

    // 13/09/2026
    { status: "success" as const, startedAt: "2026-09-13T17:40:00Z", durationMs: 19000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-13T17:39:00Z", durationMs: 16000, stoppedNode: "Validar código de barras" },
    { status: "success" as const, startedAt: "2026-09-13T11:20:00Z", durationMs: 25000, stoppedNode: null },
    { status: "success" as const, startedAt: "2026-09-13T11:19:00Z", durationMs: 21000, stoppedNode: null },

    // 12/09/2026
    { status: "success" as const, startedAt: "2026-09-12T15:10:00Z", durationMs: 28000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-12T15:09:00Z", durationMs: 13000, stoppedNode: "Consultar título no Inter" },
    { status: "success" as const, startedAt: "2026-09-12T09:30:00Z", durationMs: 20000, stoppedNode: null },

    // 11/09/2026
    { status: "success" as const, startedAt: "2026-09-11T16:05:00Z", durationMs: 22000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-11T16:04:00Z", durationMs: 15000, stoppedNode: "Sincronização Tiny ERP" },
    { status: "success" as const, startedAt: "2026-09-11T10:12:00Z", durationMs: 26000, stoppedNode: null },

    // 10/09/2026
    { status: "success" as const, startedAt: "2026-09-10T16:58:00Z", durationMs: 19000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-10T16:57:00Z", durationMs: 15000, stoppedNode: "Consultar título no Inter" },
    { status: "success" as const, startedAt: "2026-09-10T16:56:00Z", durationMs: 28000, stoppedNode: null },
    { status: "success" as const, startedAt: "2026-09-10T16:55:00Z", durationMs: 21000, stoppedNode: null },

    // 09/09/2026 (Exatamente como destacado pelo usuário: 4 execuções no dia, 2 sucessos e 2 erros)
    { status: "success" as const, startedAt: "2026-09-09T15:45:00Z", durationMs: 24000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-09T15:44:00Z", durationMs: 14000, stoppedNode: "Consultar título no Inter" },
    { status: "success" as const, startedAt: "2026-09-09T11:20:00Z", durationMs: 31000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-09T11:19:00Z", durationMs: 12000, stoppedNode: "Validar código de barras" },

    // 08/09/2026
    { status: "error" as const, startedAt: "2026-09-08T09:02:00Z", durationMs: 12000, stoppedNode: "Validar código de barras" },
    { status: "success" as const, startedAt: "2026-09-08T09:01:00Z", durationMs: 31000, stoppedNode: null },
    { status: "success" as const, startedAt: "2026-09-08T09:00:00Z", durationMs: 25000, stoppedNode: null },
    { status: "success" as const, startedAt: "2026-09-08T14:30:00Z", durationMs: 20000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-08T14:29:00Z", durationMs: 15000, stoppedNode: "Consultar título no Inter" },

    // 07/09/2026
    { status: "success" as const, startedAt: "2026-09-07T16:20:00Z", durationMs: 26000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-07T16:19:00Z", durationMs: 14000, stoppedNode: "Validar código de barras" },
    { status: "success" as const, startedAt: "2026-09-07T10:05:00Z", durationMs: 23000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-07T10:04:00Z", durationMs: 17000, stoppedNode: "Consultar título no Inter" },

    // 06/09/2026
    { status: "success" as const, startedAt: "2026-09-06T14:15:00Z", durationMs: 21000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-06T14:14:00Z", durationMs: 13000, stoppedNode: "Consultar título no Inter" },
    { status: "error" as const, startedAt: "2026-09-06T10:10:00Z", durationMs: 18000, stoppedNode: "Validar código de barras" },

    // 05/09/2026
    { status: "success" as const, startedAt: "2026-09-05T17:30:00Z", durationMs: 29000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-05T17:29:00Z", durationMs: 15000, stoppedNode: "Consultar título no Inter" },
    { status: "success" as const, startedAt: "2026-09-05T11:40:00Z", durationMs: 24000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-05T11:39:00Z", durationMs: 16000, stoppedNode: "Validar código de barras" },

    // 04/09/2026
    { status: "success" as const, startedAt: "2026-09-04T16:50:00Z", durationMs: 25000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-04T16:49:00Z", durationMs: 14000, stoppedNode: "Consultar título no Inter" },
    { status: "success" as const, startedAt: "2026-09-04T14:10:00Z", durationMs: 22000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-04T14:09:00Z", durationMs: 18000, stoppedNode: "Validar código de barras" },
    { status: "success" as const, startedAt: "2026-09-04T09:20:00Z", durationMs: 27000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-04T09:19:00Z", durationMs: 15000, stoppedNode: "Consultar título no Inter" },

    // 03/09/2026
    { status: "success" as const, startedAt: "2026-09-03T15:30:00Z", durationMs: 23000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-03T15:29:00Z", durationMs: 16000, stoppedNode: "Validar código de barras" },
    { status: "success" as const, startedAt: "2026-09-03T10:15:00Z", durationMs: 26000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-03T10:14:00Z", durationMs: 14000, stoppedNode: "Consultar título no Inter" },

    // 02/09/2026
    { status: "success" as const, startedAt: "2026-09-02T16:40:00Z", durationMs: 24000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-02T16:39:00Z", durationMs: 15000, stoppedNode: "Consultar título no Inter" },
    { status: "error" as const, startedAt: "2026-09-02T11:00:00Z", durationMs: 19000, stoppedNode: "Validar código de barras" },

    // 01/09/2026
    { status: "success" as const, startedAt: "2026-09-01T17:10:00Z", durationMs: 28000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-01T17:09:00Z", durationMs: 14000, stoppedNode: "Consultar título no Inter" },
    { status: "success" as const, startedAt: "2026-09-01T10:30:00Z", durationMs: 22000, stoppedNode: null },
    { status: "error" as const, startedAt: "2026-09-01T10:29:00Z", durationMs: 13000, stoppedNode: "Validar código de barras" },
  ];

  const executions: Execution[] = executionPresets.map((item, index) => ({
    id: `DEMO-${2955 - index}`,
    startedAt: item.startedAt,
    stoppedAt: item.durationMs ? new Date(new Date(item.startedAt).getTime() + item.durationMs).toISOString() : null,
    durationMs: item.durationMs,
    status: item.status,
    stoppedNode: item.stoppedNode,
  }));
  return {
    mode: "demo",
    generatedAt,
    metrics: {
      totalQueue: 1280,
      paidCount: 1092,
      reconciledCount: 1184,
      hoursSaved: 91,
      estimatedSavings: 1001,
      automationRate: 92.5,
    },
    approvals,
    failures,
    executions,
    sources: { database: { status: "ok" }, n8n: { status: "ok" } },
  };
}

export function makeDemoDanfeStatus(): DanfeStatusResponse {
  return {
    status: "healthy",
    version: "1.0.0",
    nfe_provider: "sefaz_a1",
    ocr_enabled: true,
    tiny_configured: true,
    timestamp: new Date().toISOString(),
  };
}

// Fonte única das notas fiscais aguardando categorização na demonstração — usada pelo
// painel de revisão (NF-e & DANFE), pelo status da varredura SEFAZ e pela Visão Geral
// ("Ações Globais Pendentes"), para que a mesma contagem apareça em todos os lugares.
export function makeDemoDanfePendingReview(): DanfePendingReviewEntry[] {
  return [
    {
      chave: "35260912345678000199550010000492011837491823",
      filename: "NFE-49201-ARCELORMITTAL.pdf",
      staged_at: new Date().toISOString(),
      nfe_data: {
        chave: "35260912345678000199550010000492011837491823",
        numero_nota: "49201",
        data_emissao: new Date().toISOString().slice(0, 10),
        emitente_nome: "ArcelorMittal Brasil S.A.",
        emitente_cnpj: "12.345.678/0001-99",
        valor_total: 18450.0,
        duplicatas: [],
        destinatario_cnpj: "27184930000107",
        destinatario_nome: "NORVIA ACABAMENTOS LTDA (CAMPINAS)",
        meio_pagamento_nfe: "17",
      },
      itens: [
        {
          item_id: "1",
          descricao: "Chapa de aço laminada 2mm",
          valor_total: 12450.0,
          codigo: "AC-2MM",
          ncm: "72083690",
          quantidade: 30,
          valor_unitario: 415.0,
          categoria_sugerida_id: "480897321",
          categoria_sugerida_nome: "Compras",
        },
        {
          item_id: "2",
          descricao: "Detergente industrial concentrado 5L",
          valor_total: 3000.0,
          codigo: "LIMP-5L",
          ncm: "34022000",
          quantidade: 20,
          valor_unitario: 150.0,
          categoria_sugerida_id: "701885961",
          categoria_sugerida_nome: "Materiais de Limpeza",
        },
        {
          item_id: "3",
          descricao: "Resma de papel A4 sulfite",
          valor_total: 3000.0,
          codigo: "PAP-A4",
          ncm: "48025700",
          quantidade: 40,
          valor_unitario: 75.0,
          categoria_sugerida_id: "484437483",
          categoria_sugerida_nome: "Material de Escritório",
        },
      ],
    },
    {
      chave: "41260998765432000188550010000008521000000852",
      filename: "NFE-852-PARANA_DISTRIBUIDORA.xml",
      staged_at: new Date(Date.now() - 1 * 86400000).toISOString(),
      nfe_data: {
        chave: "41260998765432000188550010000008521000000852",
        numero_nota: "852",
        data_emissao: new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10),
        emitente_nome: "PARANÁ DISTRIBUIDORA DE MATERIAIS LTDA",
        emitente_cnpj: "98.765.432/0001-88",
        valor_total: 1250.0,
        duplicatas: [],
        destinatario_cnpj: "27184930000280",
        destinatario_nome: "NORVIA ACABAMENTOS LTDA (CURITIBA)",
        meio_pagamento_nfe: "15",
      },
      itens: [
        {
          item_id: "1",
          descricao: "Argamassa colante AC-III cinza 20kg",
          valor_total: 1250.0,
          codigo: "ARG-AC3",
          ncm: "38245000",
          quantidade: 50,
          valor_unitario: 25.0,
          categoria_sugerida_id: "480897321",
          categoria_sugerida_nome: "Compras",
        },
      ],
    },
    {
      chave: "35260753614072000195550010000010511029568368",
      filename: "NFE-1051-ACRILEX.xml",
      staged_at: new Date(Date.now() - 3 * 86400000).toISOString(),
      nfe_data: {
        chave: "35260753614072000195550010000010511029568368",
        numero_nota: "1051",
        data_emissao: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10),
        emitente_nome: "ACRILICOS EXEMPLO E SOLUCOES LTDA",
        emitente_cnpj: "53.614.072/0001-95",
        valor_total: 45.92,
        duplicatas: [],
        destinatario_cnpj: "43820617000166",
        destinatario_nome: "FABRILUX ACABAMENTOS LTDA",
        meio_pagamento_nfe: null,
      },
      itens: [
        {
          item_id: "1",
          descricao: "Display de parede simples moldado vertical A4",
          valor_total: 45.92,
          codigo: "DISP-A4",
          ncm: "39203000",
          quantidade: 1,
          valor_unitario: 45.92,
          categoria_sugerida_id: "480897321",
          categoria_sugerida_nome: "Compras",
        },
      ],
    },
  ];
}

export function makeDemoDanfeDashboard(generatedAt = new Date().toISOString()): DashboardResponse {
  const pending = makeDemoDanfePendingReview();
  const approvals: Account[] = pending.map((entry) => ({
    id: `danfe-pending-${entry.chave.slice(-8)}`,
    beneficiary: entry.nfe_data.emitente_nome,
    cnpj: entry.nfe_data.emitente_cnpj,
    amount: String(entry.nfe_data.valor_total),
    dueDate: entry.nfe_data.data_emissao,
    status: "AGUARDANDO_CATEGORIZACAO",
    transactionId: null,
    errorLog: null,
    stoppedNode: null,
    updatedAt: entry.staged_at,
  }));
  return {
    mode: "demo",
    generatedAt,
    metrics: {
      totalQueue: 340,
      paidCount: 318,
      reconciledCount: 310,
      hoursSaved: (318 * 3) / 60,
      estimatedSavings: Math.round(((318 * 3) / 60) * 11 * 100) / 100,
      automationRate: 93.5,
    },
    approvals,
    failures: [],
    executions: [
      {
        id: "DEMO-NFE-01",
        startedAt: new Date(Date.now() - 3600000).toISOString(),
        stoppedAt: new Date(Date.now() - 3590000).toISOString(),
        durationMs: 10000,
        status: "success",
        stoppedNode: null,
      },
    ],
    sources: { database: { status: "ok" }, n8n: { status: "ok" } },
  };
}

export function makeDemoSefazStatus(): DanfeSefazStatus {
  const now = Date.now();
  const next = new Date(now);
  next.setDate(next.getDate() + (next.getHours() >= 6 ? 1 : 0));
  next.setHours(6, 0, 0, 0);
  const pendingCount = makeDemoDanfePendingReview().length;
  return {
    last_scan_started_at: new Date(now - 3600 * 1000).toISOString(),
    last_scan_finished_at: new Date(now - 3590 * 1000).toISOString(),
    next_scan_at: next.toISOString(),
    total_novas_notas: pendingCount,
    pending_review_count: pendingCount,
    cnpjs: [
      { cnpj: "43820617000166", novas_notas: 1, duplicadas_ignoradas: 4, canceladas_ignoradas: 0, eventos_ignorados: 1, ult_nsu: "000000000000042", status: "ok", erro: null },
      { cnpj: "36592814000100", novas_notas: 0, duplicadas_ignoradas: 2, canceladas_ignoradas: 1, eventos_ignorados: 0, ult_nsu: "000000000000018", status: "ok", erro: null },
      { cnpj: "27184930000107", novas_notas: 1, duplicadas_ignoradas: 6, canceladas_ignoradas: 0, eventos_ignorados: 2, ult_nsu: "000000000000073", status: "ok", erro: null },
      { cnpj: "27184930000280", novas_notas: 1, duplicadas_ignoradas: 3, canceladas_ignoradas: 0, eventos_ignorados: 0, ult_nsu: "000000000000029", status: "ok", erro: null },
    ],
    cooldown_seconds_remaining: 0,
    certificados: [
      {
        arquivo: "fabrilux.pfx",
        cnpj: "43820617000166",
        titular: "FABRILUX ACABAMENTOS LTDA",
        valido_ate: new Date(Date.now() + 18 * 86400000).toISOString(),
        dias_restantes: 18,
        alerta: true,
        erro: null,
      },
    ],
  };
}

export function makeDemoDanfeHistory() {
  return [
    // Lote 1: Hoje, 14/09/2026 ~11:15
    {
      id: 101,
      processed_at: "2026-09-14T11:17:30Z",
      original_filename: "NFE-49201-ARCELORMITTAL.pdf",
      chave_acesso: "35260912345678000199550010000492011837491823",
      metodo_leitura: "sefaz_a1",
      numero_nota: "49201",
      emitente: { razao_social: "ArcelorMittal Brasil S.A.", cnpj: "12.345.678/0001-99" },
      valor_total: 18450.0,
      audit_status: "success",
      details: "Processado com sucesso e 3 parcelas cadastradas no Tiny ERP.",
      lancamentos_tiny: [
        { conta_id: 88401, nro_documento: "49201/1", valor: 6150.0, vencimento: "2026-10-14", situacao: "aberto" },
        { conta_id: 88402, nro_documento: "49201/2", valor: 6150.0, vencimento: "2026-11-14", situacao: "aberto" },
        { conta_id: 88403, nro_documento: "49201/3", valor: 6150.0, vencimento: "2026-12-14", situacao: "aberto" },
      ],
    },
    {
      id: 102,
      processed_at: "2026-09-14T11:16:15Z",
      original_filename: "NFE-88124-GERDAU.pdf",
      chave_acesso: "35260923456789000112550010000881241928471920",
      metodo_leitura: "sefaz_a1",
      numero_nota: "88124",
      emitente: { razao_social: "Gerdau Aços Longos S.A.", cnpj: "23.456.789/0001-12" },
      valor_total: 9320.5,
      audit_status: "success",
      details: "Processado com sucesso e 2 duplicatas integradas ao Tiny ERP.",
      lancamentos_tiny: [
        { conta_id: 88404, nro_documento: "88124/1", valor: 4660.25, vencimento: "2026-09-28", situacao: "aberto" },
        { conta_id: 88405, nro_documento: "88124/2", valor: 4660.25, vencimento: "2026-10-28", situacao: "aberto" },
      ],
    },
    {
      id: 103,
      processed_at: "2026-09-14T11:15:00Z",
      original_filename: "NFE-10452-SAINT-GOBAIN.pdf",
      chave_acesso: "35260934567890000123550010000104521092837461",
      metodo_leitura: "sefaz_a1",
      numero_nota: "10452",
      emitente: { razao_social: "Saint-Gobain Distribuição Brasil", cnpj: "34.567.890/0001-23" },
      valor_total: 3840.0,
      audit_status: "success",
      details: "Processado com sucesso via SEFAZ A1.",
      lancamentos_tiny: [
        { conta_id: 88406, nro_documento: "10452/1", valor: 3840.0, vencimento: "2026-09-30", situacao: "aberto" },
      ],
    },
    // Lote 2: Hoje, 14/09/2026 ~08:30
    {
      id: 104,
      processed_at: "2026-09-14T08:32:00Z",
      original_filename: "NFE-9104-VOTORANTIM.pdf",
      chave_acesso: "35260945678901000134550010000091041827364519",
      metodo_leitura: "sefaz_a1",
      numero_nota: "9104",
      emitente: { razao_social: "Votorantim Cimentos S.A.", cnpj: "45.678.901/0001-34" },
      valor_total: 14890.0,
      audit_status: "success",
      details: "Conciliado com sucesso no Tiny ERP.",
      lancamentos_tiny: [
        { conta_id: 88407, nro_documento: "9104/1", valor: 14890.0, vencimento: "2026-10-05", situacao: "aberto" },
      ],
    },
    {
      id: 105,
      processed_at: "2026-09-14T08:31:00Z",
      original_filename: "NFE-3302-TIGRE.pdf",
      chave_acesso: "35260956789012000145550010000033021982736450",
      metodo_leitura: "sefaz_a1",
      numero_nota: "3302",
      emitente: { razao_social: "Tigre Materiais e Conexões", cnpj: "56.789.012/0001-45" },
      valor_total: 5410.0,
      audit_status: "success",
      details: "Título gerado com sucesso.",
      lancamentos_tiny: [
        { conta_id: 88408, nro_documento: "3302/1", valor: 5410.0, vencimento: "2026-09-25", situacao: "aberto" },
      ],
    },
    {
      id: 106,
      processed_at: "2026-09-14T08:30:00Z",
      original_filename: "NFE-1192-SCAN-ERR.pdf",
      chave_acesso: "35260967890123000156550010000011920000000001",
      metodo_leitura: "ocr_local",
      numero_nota: "1192",
      emitente: { razao_social: "Transportadora Mercosul Ltda", cnpj: "67.890.123/0001-56" },
      valor_total: 2190.0,
      audit_status: "error",
      details: "Dígito verificador inválido na chave de acesso da NF-e.",
    },
    // Lote 3: Auditoria, 10/09/2026 ~16:40
    {
      id: 107,
      processed_at: "2026-09-10T16:43:00Z",
      original_filename: "NFE-7721-WEG.pdf",
      chave_acesso: "35260978901234000167550010000077211234567890",
      metodo_leitura: "sefaz_a1",
      numero_nota: "7721",
      emitente: { razao_social: "WEG Equipamentos Elétricos S.A.", cnpj: "78.901.234/0001-67" },
      valor_total: 27500.0,
      audit_status: "success",
      details: "Lançamento confirmado.",
    },
    {
      id: 108,
      processed_at: "2026-09-10T16:41:00Z",
      original_filename: "NFE-6619-SCHNEIDER.pdf",
      chave_acesso: "35260989012345000178550010000066191345678901",
      metodo_leitura: "sefaz_a1",
      numero_nota: "6619",
      emitente: { razao_social: "Schneider Electric Brasil Ltda", cnpj: "89.012.345/0001-78" },
      valor_total: 12300.0,
      audit_status: "success",
      details: "Lançamento confirmado.",
    },
    // Lote 4: 08/09/2026 ~14:10
    {
      id: 109,
      processed_at: "2026-09-08T14:12:00Z",
      original_filename: "NFE-3801-AMBEV.pdf",
      chave_acesso: "35260990123456000189550010000038011456789012",
      metodo_leitura: "sefaz_a1",
      numero_nota: "3801",
      emitente: { razao_social: "Ambev Distribuidora S.A.", cnpj: "90.123.456/0001-89" },
      valor_total: 31400.0,
      audit_status: "success",
      details: "Lançamento confirmado no Tiny.",
    },
    {
      id: 110,
      processed_at: "2026-09-08T14:10:00Z",
      original_filename: "NFE-3802-COCA-COLA.pdf",
      chave_acesso: "35260901234567000190550010000038021567890123",
      metodo_leitura: "sefaz_a1",
      numero_nota: "3802",
      emitente: { razao_social: "Coca-Cola FEMSA Brasil", cnpj: "01.234.567/0001-90" },
      valor_total: 22100.0,
      audit_status: "success",
      details: "Lançamento confirmado no Tiny.",
    },
    // Lote 5: 09/09/2026 ~15:20
    {
      id: 111,
      processed_at: "2026-09-09T15:22:00Z",
      original_filename: "NFE-9901-NESTLE.pdf",
      chave_acesso: "35260911223344000155550010000099011928374650",
      metodo_leitura: "sefaz_a1",
      numero_nota: "9901",
      emitente: { razao_social: "Nestlé Brasil Ltda", cnpj: "60.409.075/0001-52" },
      valor_total: 19800.0,
      audit_status: "success",
      details: "Processado com sucesso e 2 duplicatas integradas ao Tiny ERP.",
      lancamentos_tiny: [
        { conta_id: 88409, nro_documento: "9901/1", valor: 9900.0, vencimento: "2026-10-09", situacao: "aberto" },
        { conta_id: 88410, nro_documento: "9901/2", valor: 9900.0, vencimento: "2026-11-09", situacao: "aberto" },
      ],
    },
    {
      id: 112,
      processed_at: "2026-09-09T15:20:00Z",
      original_filename: "NFE-9902-UNILEVER.pdf",
      chave_acesso: "35260922334455000166550010000099021827364519",
      metodo_leitura: "ocr_local",
      numero_nota: "9902",
      emitente: { razao_social: "Unilever Brasil Industrial Ltda", cnpj: "61.068.276/0001-04" },
      valor_total: 8450.0,
      audit_status: "error",
      details: "Chave SEFAZ retornou rejeição 215: Falha no schema XML da NF-e.",
    },
    // Lote 6: 05/09/2026 ~10:00
    {
      id: 113,
      processed_at: "2026-09-05T10:02:00Z",
      original_filename: "NFE-5501-DELL.pdf",
      chave_acesso: "35260933445566000177550010000055011726354418",
      metodo_leitura: "sefaz_a1",
      numero_nota: "5501",
      emitente: { razao_social: "Dell Computadores do Brasil Ltda", cnpj: "72.381.189/0001-10" },
      valor_total: 42100.0,
      audit_status: "success",
      details: "Processado com sucesso.",
    },
    // Lote 7: 01/09/2026 ~09:30
    {
      id: 114,
      processed_at: "2026-09-01T09:30:00Z",
      original_filename: "NFE-1001-POSITIVO.pdf",
      chave_acesso: "35260944556677000188550010000010011625344317",
      metodo_leitura: "sefaz_a1",
      numero_nota: "1001",
      emitente: { razao_social: "Positivo Tecnologia S.A.", cnpj: "81.243.735/0001-48" },
      valor_total: 11200.0,
      audit_status: "success",
      details: "Conciliado no Tiny ERP.",
    },
  ];
}

// Notificações fictícias pro sino do topo — conteúdo varia pelas permissões da sessão
// (mesma regra de destinatário do gateway: notifyPermission).
export function makeDemoNotifications(session: PermissionSession | null | undefined) {
  const now = Date.now();
  const can = (key: string) => hasPermission(session, key);
  const items: Array<{
    id: number;
    destinatario_id: number;
    tipo: string;
    titulo: string;
    mensagem: string;
    link: string | null;
    lida: boolean;
    criado_em: string;
  }> = [];
  const add = (item: Omit<(typeof items)[number], "destinatario_id">) => items.push({ ...item, destinatario_id: 1 });

  if (can("usuarios:aprovar_cadastro")) {
    add({
      id: 1,
      tipo: "cadastro_pendente",
      titulo: "Novo cadastro aguardando aprovação",
      mensagem: "Mariana Castro solicitou acesso à plataforma.",
      link: "/admin/usuarios?tab=pending",
      lida: false,
      criado_em: new Date(now - 20 * 60000).toISOString(),
    });
  }
  if (can("usuarios:revisar_alteracao")) {
    add({
      id: 2,
      tipo: "alteracao_pendente",
      titulo: "Solicitação de alteração de cadastro",
      mensagem: 'Fernanda Financeiro solicitou novo e-mail: "fernanda.financeiro@norvia.example".',
      link: "/admin/usuarios?tab=pending",
      lida: false,
      criado_em: new Date(now - 2 * 3600000).toISOString(),
    });
  }
  if (can("revisao_nfe:ver")) {
    add({
      id: 3,
      tipo: "certificado_vencendo",
      titulo: "Certificado A1 perto do vencimento",
      mensagem: "O certificado A1 de Norvia Curitiba vence em 15 dia(s). Renove para a varredura não parar.",
      link: "/danfe-tiny",
      lida: true,
      criado_em: new Date(now - 26 * 3600000).toISOString(),
    });
  }
  if (can("contagem_estoque:ver")) {
    add({
      id: 10,
      tipo: "contagem_estoque",
      titulo: "Contagem de Estoque finalizada",
      mensagem: "Lote de fotos da prateleira A3 processado com sucesso pelo bot Telegram.",
      link: "/contagem-estoque",
      lida: false,
      criado_em: new Date(now - 45 * 60000).toISOString(),
    });
  }
  if (can("dimensoes:ver")) {
    add({
      id: 20,
      tipo: "dimensoes_pendentes",
      titulo: "Anúncios com dimensões pendentes",
      mensagem: "8 anúncios do Mercado Livre precisam de padronização de dimensões.",
      link: "/padronizacao-dimensoes",
      lida: false,
      criado_em: new Date(now - 30 * 60000).toISOString(),
    });
  }
  if (can("fretes:ver")) {
    add({
      id: 21,
      tipo: "fretes_revertido",
      titulo: "Frete a combinar alterado pelo ML",
      mensagem: "Anúncio MLB1234 teve o frete modificado na plataforma externa.",
      link: "/fretes-a-combinar",
      lida: true,
      criado_em: new Date(now - 3 * 3600000).toISOString(),
    });
  }
  // Avisos pessoais: chegam a qualquer logado.
  add({
    id: 5,
    tipo: "alteracao_aprovada",
    titulo: "Alteração de cadastro aprovada",
    mensagem: 'Seu novo nome de usuário é "joao.pedro".',
    link: null,
    lida: items.length > 0,
    criado_em: new Date(now - 3 * 3600000).toISOString(),
  });
  add({
    id: 6,
    tipo: "alteracao_rejeitada",
    titulo: "Alteração de cadastro recusada",
    mensagem: "Sua solicitação de troca de e-mail foi recusada pelo administrador.",
    link: null,
    lida: true,
    criado_em: new Date(now - 30 * 3600000).toISOString(),
  });
  return items;
}

// Chat direto entre usuários — fixtures fictícias, sem persistência real (o envio em modo
// demo só ecoa a mensagem localmente).
export function makeDemoChatContacts() {
  return [
    { id: 2, nome: "Maria Teste", username: "maria", foto_perfil: null, setor: "Financeiro", role: "user" },
    { id: 3, nome: "Camila Duarte", username: "camila_d", foto_perfil: null, setor: "Contabilidade", role: "user" },
    { id: 4, nome: "Lucas Ribeiro", username: "lucas_r", foto_perfil: null, setor: "Suprimentos", role: "user" },
  ];
}

export function makeDemoChatConversations() {
  const now = Date.now();
  return [
    { outroUsuarioId: 2, ultimaMensagem: "Bom dia! Já consegui revisar as notas de ontem.", enviadoEm: new Date(now - 25 * 60000).toISOString(), naoLidas: 1 },
    { outroUsuarioId: 3, ultimaMensagem: "Combinado, aguardo o retorno então.", enviadoEm: new Date(now - 3 * 3600000).toISOString(), naoLidas: 0 },
  ];
}

export function makeDemoChatMessages(otherUserId: number) {
  const now = Date.now();
  if (otherUserId === 2) {
    return [
      { id: 1, remetente_id: 2, destinatario_id: 1, conteudo: "Bom dia! Tudo certo por aí?", enviado_em: new Date(now - 40 * 60000).toISOString(), lida: true },
      { id: 2, remetente_id: 1, destinatario_id: 2, conteudo: "Bom dia, Maria! Tudo certo sim, e por aí?", enviado_em: new Date(now - 38 * 60000).toISOString(), lida: true },
      { id: 3, remetente_id: 2, destinatario_id: 1, conteudo: "Bom dia! Já consegui revisar as notas de ontem.", enviado_em: new Date(now - 25 * 60000).toISOString(), lida: false },
    ];
  }
  if (otherUserId === 3) {
    return [
      { id: 4, remetente_id: 1, destinatario_id: 3, conteudo: "Camila, pode revisar o lote de contas a pagar dessa semana?", enviado_em: new Date(now - 4 * 3600000).toISOString(), lida: true },
      { id: 5, remetente_id: 3, destinatario_id: 1, conteudo: "Combinado, aguardo o retorno então.", enviado_em: new Date(now - 3 * 3600000).toISOString(), lida: true },
    ];
  }
  return [];
}

// Contadores operacionais ao vivo mostrados no sino (filas que já existem em outras telas),
// filtrados pelas permissões da sessão.
export function makeDemoOperationalPanel(session: PermissionSession | null | undefined) {
  const can = (key: string) => hasPermission(session, key);
  const isAdmin = session?.role === "admin";
  const items: Array<{ label: string; count: number; href: string }> = [];
  if (can("usuarios:ver")) items.push({ label: "3 cadastros ou alterações pendentes", count: 3, href: "/admin/usuarios?tab=pending" });
  if (can("revisao_nfe:ver")) items.push({ label: "24 notas pendentes de revisão", count: 24, href: "/danfe-tiny" });
  if (!isAdmin && can("contas_pagar:ver")) items.push({ label: "5 pagamentos pendentes de baixa", count: 5, href: "/contas-a-pagar" });
  if (!isAdmin && can("contagem_estoque:ver")) items.push({ label: "Contagem de Estoque recente", count: 1, href: "/contagem-estoque" });
  if (!isAdmin && can("dimensoes:ver")) items.push({ label: "8 anúncios para padronizar", count: 8, href: "/padronizacao-dimensoes" });
  return items;
}

// ==========================================
// Dashboard Financeiro (demonstração)
// ==========================================

const DEMO_FINANCIAL_COMPANIES = [
  { account_id: "fabrilux", label: "Fabrilux" },
  { account_id: "revesta", label: "Revesta" },
  { account_id: "norvia_campinas", label: "Norvia Campinas" },
  { account_id: "norvia_curitiba", label: "Norvia Curitiba" },
];

const DEMO_MONTH_NAMES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

export function makeDemoFinancialDashboardStatus(): FinancialDashboardStatus {
  const now = Date.now();
  const next = new Date(now);
  next.setDate(next.getDate() + (next.getHours() >= 4 ? 1 : 0));
  next.setHours(4, 0, 0, 0);
  return {
    last_sync_started_at: new Date(now - 3 * 3600 * 1000).toISOString(),
    last_sync_finished_at: new Date(now - 3 * 3600 * 1000 + 210000).toISOString(),
    next_sync_at: next.toISOString(),
    companies: DEMO_FINANCIAL_COMPANIES.map((c) => ({
      account_id: c.account_id,
      cnpj: "00000000000000",
      ok: true,
      erro: null,
      caixa_lancamentos: 340,
      contas_pagar_abertas: 18,
      contas_receber_abertas: 9,
    })),
    is_running: false,
    cooldown_seconds_remaining: 0,
  };
}

export function makeDemoFinancialDashboard(
  dateFrom?: string,
  dateTo?: string,
  company?: string,
): FinancialDashboardResponse {
  const now = new Date();
  const to = dateTo ? new Date(`${dateTo}T00:00:00`) : now;
  const from = dateFrom
    ? new Date(`${dateFrom}T00:00:00`)
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const lengthDays = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000) + 1);
  const prevTo = new Date(from.getTime() - 86400000);
  const prevFrom = new Date(prevTo.getTime() - (lengthDays - 1) * 86400000);
  const isoDate = (d: Date) => d.toISOString().slice(0, 10);

  const porEmpresaBase = [
    { account_id: "fabrilux", label: "Fabrilux", receita: 74200, despesa: 58100 },
    { account_id: "revesta", label: "Revesta", receita: 51300, despesa: 41900 },
    { account_id: "norvia_campinas", label: "Norvia Campinas", receita: 39800, despesa: 33200 },
    { account_id: "norvia_curitiba", label: "Norvia Curitiba", receita: 21500, despesa: 18900 },
  ];
  // Ao filtrar por empresa, escala os valores globais pela participação (%) dessa
  // empresa no total, para que a UI reflita visivelmente o filtro em demonstração
  // (o backend real filtra por empresa de verdade — ver build_dashboard_response).
  const empresaSelecionada = company ? porEmpresaBase.find((e) => e.account_id === company) : undefined;
  const totalReceitaEmpresas = porEmpresaBase.reduce((acc, e) => acc + e.receita, 0);
  const totalDespesaEmpresas = porEmpresaBase.reduce((acc, e) => acc + e.despesa, 0);
  const receitaFraction = empresaSelecionada ? empresaSelecionada.receita / totalReceitaEmpresas : 1;
  const despesaFraction = empresaSelecionada ? empresaSelecionada.despesa / totalDespesaEmpresas : 1;

  // Os valores-base de despesas/receitas por categoria representam "um mês" (~30
  // dias) — escalar por essa fração faz o filtro de período (HistoryFilter) mudar
  // visivelmente os totais em demonstração, igual ao comportamento real do backend
  // (que soma só o que caiu dentro de date_from/date_to). Aging de contas a pagar/
  // receber usa só a fração de empresa (companyOnly*) — é sempre "foto de agora",
  // independente do período, igual à API real.
  const periodFactor = Math.max(0.15, Math.min(13, lengthDays / 30));
  const periodDespesaFraction = despesaFraction * periodFactor;
  const periodReceitaFraction = receitaFraction * periodFactor;

  const fluxo_caixa_mensal = [];
  for (let i = 12; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const seasonal = 1 + 0.12 * Math.sin(i / 2);
    const receita = Math.round((185000 * seasonal + i * 900) * receitaFraction);
    const despesa = Math.round((142000 * seasonal + (12 - i) * 600) * despesaFraction);
    fluxo_caixa_mensal.push({
      mes: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: `${DEMO_MONTH_NAMES[d.getMonth()]}/${String(d.getFullYear()).slice(2)}`,
      receita,
      despesa,
      saldo: receita - despesa,
    });
  }

  // Série diária do período (só para períodos curtos, igual ao backend real).
  const fluxo_caixa_diario =
    lengthDays <= 92
      ? Array.from({ length: lengthDays }, (_, i) => {
          const d = new Date(from.getTime() + i * 86400000);
          const weekday = d.getDay();
          const util = weekday === 0 ? 0.15 : weekday === 6 ? 0.5 : 1;
          const receita = Math.round(6200 * util * (1 + 0.2 * Math.sin(i)) * receitaFraction);
          const despesa = Math.round(4800 * util * (1 + 0.25 * Math.cos(i / 2)) * despesaFraction);
          return {
            dia: isoDate(d),
            label: `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`,
            receita,
            despesa,
            saldo: receita - despesa,
          };
        })
      : null;

  const demoFaixas = (fraction: number, base: number[]) =>
    [
      ["vencido_90_mais", "Vencido há +90 dias"],
      ["vencido_61_90", "Vencido 61–90 dias"],
      ["vencido_31_60", "Vencido 31–60 dias"],
      ["vencido_1_30", "Vencido 1–30 dias"],
      ["a_vencer_0_30", "A vencer em 0–30 dias"],
      ["a_vencer_31_60", "A vencer em 31–60 dias"],
      ["a_vencer_61_90", "A vencer em 61–90 dias"],
      ["a_vencer_90_mais", "A vencer em +90 dias"],
    ].map(([faixa, label], i) => ({
      faixa,
      label,
      valor: Math.round(base[i] * fraction),
      qtd: base[i] ? Math.max(1, Math.round((base[i] / 4000) * fraction)) : 0,
    }));

  let acumulado = 0;
  const projecaoSemanal = Array.from({ length: 13 }, (_, i) => {
    const d = new Date(now.getTime() + i * 7 * 86400000);
    const a_receber = Math.round((9800 + 1500 * Math.sin(i)) * receitaFraction);
    const a_pagar = Math.round((11200 + 2100 * Math.cos(i / 1.5)) * despesaFraction);
    acumulado += a_receber - a_pagar;
    return {
      inicio: isoDate(d),
      label: `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`,
      a_receber,
      a_pagar,
      saldo_acumulado: acumulado,
    };
  });
  const horizonte = (semanas: number, dias: number) => {
    const slice = projecaoSemanal.slice(0, semanas);
    const a_receber = slice.reduce((acc, w) => acc + w.a_receber, 0);
    const a_pagar = slice.reduce((acc, w) => acc + w.a_pagar, 0);
    return { dias, a_receber, a_pagar, saldo: a_receber - a_pagar };
  };

  const despesasRaw: Array<[string, string, string, number]> = [
    ["480897321", "Compras", "3.Custos", 48200],
    ["483351497", "Salários", "4.Despesas Operacionais", 39500],
    ["484437383", "Aluguel", "4.Despesas Operacionais", 18000],
    ["484441546", "Comissões", "4.Despesas Operacionais", 11200],
    ["484436608", "Impostos", "2.Deduções", 9800],
    ["484437478", "Energia Elétrica", "4.Despesas Operacionais", 4300],
    ["484437541", "Propaganda/ Publicidade", "4.Despesas Operacionais", 3900],
    ["488380104", "Software", "4.Despesas Operacionais", 3200],
    ["484437787", "Combustível", "4.Despesas Operacionais", 2100],
    ["484437483", "Material de Escritório", "4.Despesas Operacionais", 950],
  ].map(([id, nome, grupo, valor]) => [id, nome, grupo, Math.round(Number(valor) * periodDespesaFraction)]) as Array<
    [string, string, string, number]
  >;
  const despesaTotal = despesasRaw.reduce((acc, [, , , v]) => acc + v, 0);
  const despesas_por_categoria = despesasRaw.map(([categoria_id, categoria_nome, grupo, valor], idx) => {
    const valor_anterior = Math.round(valor * (0.85 + (idx % 3) * 0.08));
    return {
      categoria_id,
      categoria_nome,
      grupo,
      valor,
      valor_anterior,
      variacao_pct: Math.round(((valor - valor_anterior) / valor_anterior) * 1000) / 10,
      percentual_do_total: Math.round((valor / despesaTotal) * 1000) / 10,
    };
  });

  const receitasRaw: Array<[string, string, string, number]> = [
    ["484450322", "Vendas Loja", "1.Receitas", 128500],
    ["484450325", "Vendas Online", "1.Receitas", 56300],
    ["484438533", "Receita de Aplicações", "5.Receitas Financeiras", 2100],
  ].map(([id, nome, grupo, valor]) => [id, nome, grupo, Math.round(Number(valor) * periodReceitaFraction)]) as Array<
    [string, string, string, number]
  >;
  const receitaTotal = receitasRaw.reduce((acc, [, , , v]) => acc + v, 0);
  const receitas_por_categoria = receitasRaw.map(([categoria_id, categoria_nome, grupo, valor]) => ({
    categoria_id,
    categoria_nome,
    grupo,
    valor,
    valor_anterior: Math.round(valor * 0.94),
    variacao_pct: 6.4,
    percentual_do_total: Math.round((valor / receitaTotal) * 1000) / 10,
  }));

  const despesaAnterior = despesas_por_categoria.reduce((acc, d) => acc + d.valor_anterior, 0);
  const receitaAnterior = receitas_por_categoria.reduce((acc, d) => acc + d.valor_anterior, 0);
  const resultadoLiquido = receitaTotal - despesaTotal;
  const resultadoAnterior = receitaAnterior - despesaAnterior;
  const faturamentoBruto = receitas_por_categoria
    .filter((r) => r.grupo === "1.Receitas")
    .reduce((acc, r) => acc + r.valor, 0);
  const faturamentoBrutoAnterior = receitas_por_categoria
    .filter((r) => r.grupo === "1.Receitas")
    .reduce((acc, r) => acc + r.valor_anterior, 0);

  return {
    generated_at: new Date(now.getTime() - 3 * 3600000 + 210000).toISOString(),
    period: {
      from: isoDate(from),
      to: isoDate(to),
      previous_from: isoDate(prevFrom),
      previous_to: isoDate(prevTo),
    },
    companies_available: DEMO_FINANCIAL_COMPANIES,
    company_selected: company ?? null,
    summary: {
      receita_total: receitaTotal,
      receita_total_anterior: receitaAnterior,
      receita_variacao_pct: receitaAnterior ? Math.round(((receitaTotal - receitaAnterior) / receitaAnterior) * 1000) / 10 : null,
      faturamento_bruto: faturamentoBruto,
      faturamento_bruto_anterior: faturamentoBrutoAnterior,
      faturamento_bruto_variacao_pct: faturamentoBrutoAnterior
        ? Math.round(((faturamentoBruto - faturamentoBrutoAnterior) / faturamentoBrutoAnterior) * 1000) / 10
        : null,
      despesa_total: despesaTotal,
      despesa_total_anterior: despesaAnterior,
      despesa_variacao_pct: despesaAnterior ? Math.round(((despesaTotal - despesaAnterior) / despesaAnterior) * 1000) / 10 : null,
      resultado_liquido: resultadoLiquido,
      resultado_liquido_anterior: resultadoAnterior,
      resultado_liquido_variacao_pct: resultadoAnterior
        ? Math.round(((resultadoLiquido - resultadoAnterior) / Math.abs(resultadoAnterior)) * 1000) / 10
        : null,
      margem_liquida_pct: receitaTotal ? Math.round((resultadoLiquido / receitaTotal) * 1000) / 10 : null,
      margem_liquida_pct_anterior: receitaAnterior ? Math.round((resultadoAnterior / receitaAnterior) * 1000) / 10 : null,
    },
    dados_desatualizados: [],
    fluxo_caixa_mensal,
    fluxo_caixa_diario,
    projecao_caixa: { horizontes: [horizonte(5, 30), horizonte(9, 60), horizonte(13, 90)], semanal: projecaoSemanal },
    despesas_por_categoria,
    receitas_por_categoria,
    concentracao_despesas_top3_pct:
      Math.round(despesas_por_categoria.slice(0, 3).reduce((acc, d) => acc + d.percentual_do_total, 0) * 10) / 10,
    categoria_maior_alta: { categoria_nome: "Comissões", variacao_pct: 22.4 },
    contas_a_pagar: {
      vencido_valor: Math.round(8420 * despesaFraction),
      vencido_qtd: empresaSelecionada ? Math.max(1, Math.round(4 * despesaFraction)) : 4,
      proximos_7_dias_valor: Math.round(15600 * despesaFraction),
      proximos_7_dias_qtd: empresaSelecionada ? Math.max(1, Math.round(6 * despesaFraction)) : 6,
      proximos_30_dias_valor: Math.round(61200 * despesaFraction),
      proximos_30_dias_qtd: empresaSelecionada ? Math.max(1, Math.round(18 * despesaFraction)) : 18,
      top: [
        { nome: "Distribuidora Alfa Ltda", valor: Math.round(12400 * despesaFraction), qtd: 3 },
        { nome: "Fornecedor Beta S.A.", valor: Math.round(9800 * despesaFraction), qtd: 2 },
        { nome: "Transportadora Gama", valor: Math.round(7100 * despesaFraction), qtd: 4 },
        { nome: "Gráfica Delta", valor: Math.round(5200 * despesaFraction), qtd: 1 },
        { nome: "Escritório Contábil Épsilon", valor: Math.round(3600 * despesaFraction), qtd: 1 },
      ],
      faixas: demoFaixas(despesaFraction, [0, 900, 1800, 5720, 61200, 24800, 9100, 3400]),
    },
    contas_a_receber: {
      vencido_valor: Math.round(4100 * receitaFraction),
      vencido_qtd: empresaSelecionada ? Math.max(1, Math.round(2 * receitaFraction)) : 2,
      proximos_7_dias_valor: Math.round(9200 * receitaFraction),
      proximos_7_dias_qtd: empresaSelecionada ? Math.max(1, Math.round(5 * receitaFraction)) : 5,
      proximos_30_dias_valor: Math.round(38500 * receitaFraction),
      proximos_30_dias_qtd: empresaSelecionada ? Math.max(1, Math.round(14 * receitaFraction)) : 14,
      top: [
        { nome: "Cliente Corporativo Zeta", valor: Math.round(6200 * receitaFraction), qtd: 1 },
        { nome: "Cliente Varejo Theta", valor: Math.round(2900 * receitaFraction), qtd: 3 },
      ],
      taxa_inadimplencia_pct: 9.6,
      faixas: demoFaixas(receitaFraction, [600, 0, 700, 2800, 38500, 16100, 4200, 0]),
    },
    forma_pagamento: [
      { marcador: "Outros / Pix / Boleto", valor: Math.round(despesaTotal * 0.52), percentual: 52 },
      { marcador: "Cartão Clara", valor: Math.round(despesaTotal * 0.24), percentual: 24 },
      { marcador: "Caixa Visa Norvia", valor: Math.round(despesaTotal * 0.13), percentual: 13 },
      { marcador: "Caixa Elo", valor: Math.round(despesaTotal * 0.11), percentual: 11 },
    ],
    por_empresa: company
      ? null
      : porEmpresaBase.map((e, i) => ({
          ...e,
          resultado_liquido: e.receita - e.despesa,
          margem_liquida_pct: Math.round(((e.receita - e.despesa) / e.receita) * 1000) / 10,
          a_pagar_vencido: [3100, 2400, 1900, 1020][i],
          a_receber_vencido: [1800, 1300, 700, 300][i],
        })),
  };
}
