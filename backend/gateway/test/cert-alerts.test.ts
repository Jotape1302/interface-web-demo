import test from "node:test";
import assert from "node:assert/strict";
import { checkCertificateAlerts } from "../src/cert-alerts.js";
import type { DanfeCertificateStatus, DanfeSefazStatus } from "../src/contracts.js";

function statusWith(certificados: Partial<DanfeCertificateStatus>[]): () => Promise<DanfeSefazStatus> {
  return async () => ({
    last_scan_started_at: null,
    last_scan_finished_at: null,
    next_scan_at: "",
    total_novas_notas: 0,
    pending_review_count: 0,
    cnpjs: [],
    cooldown_seconds_remaining: 0,
    certificados: certificados.map((c) => ({
      arquivo: "fabrilux.pfx",
      cnpj: "43820617000166",
      titular: "FABRILUX",
      valido_ate: "2026-10-05T00:00:00+00:00",
      dias_restantes: 12,
      alerta: true,
      erro: null,
      ...c,
    })),
  });
}

test("notifica uma vez por marco e de novo ao cruzar o próximo", async () => {
  const sent = new Set<string>();
  const msgs: string[] = [];
  const notify = async (d: { mensagem?: string }) => {
    msgs.push(d.mensagem ?? "");
  };

  assert.equal(await checkCertificateAlerts(statusWith([{ dias_restantes: 12 }]), notify, sent), 1);
  assert.equal(await checkCertificateAlerts(statusWith([{ dias_restantes: 10 }]), notify, sent), 0);
  assert.equal(await checkCertificateAlerts(statusWith([{ dias_restantes: 6 }]), notify, sent), 1);
  assert.equal(await checkCertificateAlerts(statusWith([{ dias_restantes: -1 }]), notify, sent), 1);
  assert.match(msgs[0] ?? "", /vence em 12 dia/);
  assert.match(msgs[2] ?? "", /venceu/);
});

test("ignora certificados sem alerta ou ilegíveis", async () => {
  const sent = new Set<string>();
  const notify = async () => {
    throw new Error("não deveria notificar");
  };
  await checkCertificateAlerts(
    statusWith([{ alerta: false, dias_restantes: 200 }, { alerta: false, dias_restantes: null, valido_ate: null, erro: "senha" }]),
    notify,
    sent,
  );
});
