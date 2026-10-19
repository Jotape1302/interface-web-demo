import type { DanfeCertificateStatus, DanfeSefazStatus } from "./contracts.js";

/** Marcos (dias restantes) em que os admins são notificados; negativo = já venceu. */
const MILESTONES = [30, 15, 7, 1, 0] as const;

function milestoneFor(dias: number): number | null {
  // Menor marco ainda >= dias restantes: 20 dias → marco 30; 5 dias → marco 7; vencido → 0.
  let found: number | null = null;
  for (const m of MILESTONES) if (dias <= m) found = m;
  return found;
}

function describe(cert: DanfeCertificateStatus): string {
  const quem = cert.titular ?? cert.arquivo;
  const dias = cert.dias_restantes ?? 0;
  if (dias < 0) return `O certificado A1 de ${quem} venceu. A varredura SEFAZ desse CNPJ para até a renovação.`;
  if (dias === 0) return `O certificado A1 de ${quem} vence hoje. Renove para a varredura SEFAZ não parar.`;
  return `O certificado A1 de ${quem} vence em ${dias} dia(s). Renove para a varredura SEFAZ não parar.`;
}

/**
 * Verifica a validade dos certificados A1 (via status da SEFAZ do motor fiscal) e notifica
 * os admins uma vez por marco (30/15/7/1 dias e vencido). `sent` guarda o que já foi
 * enviado — em memória: um restart pode repetir o aviso do marco atual uma vez.
 */
export async function checkCertificateAlerts(
  readStatus: () => Promise<DanfeSefazStatus>,
  notifyAdmins: (data: { tipo: string; titulo: string; mensagem?: string; link?: string }) => Promise<void>,
  sent: Set<string>,
): Promise<number> {
  const status = await readStatus();
  let notified = 0;
  for (const cert of status.certificados ?? []) {
    if (!cert.alerta || cert.dias_restantes === null || !cert.valido_ate) continue;
    const milestone = milestoneFor(cert.dias_restantes);
    if (milestone === null) continue;
    const key = `${cert.arquivo}:${cert.valido_ate}:${milestone}`;
    if (sent.has(key)) continue;
    await notifyAdmins({
      tipo: "certificado_vencendo",
      titulo: cert.dias_restantes < 0 ? "Certificado A1 vencido" : "Certificado A1 perto do vencimento",
      mensagem: describe(cert),
      link: "/danfe-tiny",
    });
    sent.add(key);
    notified++;
  }
  return notified;
}
