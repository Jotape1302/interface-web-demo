import { Activity, CheckCheck } from "lucide-react";

export function SourceError({ message }: { message?: string }) {
  return (
    <div role="alert" className="source-error">
      <Activity size={18} />
      <div>
        <strong>Fonte indisponível</strong>
        <p>{message || "Não foi possível obter os dados. Use Atualizar para tentar novamente."}</p>
      </div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty">
      <CheckCheck size={22} />
      <p>{children}</p>
    </div>
  );
}
