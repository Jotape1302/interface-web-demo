'use client';

import DanfePanel from "../../components/danfe-panel";
import { useAuth } from "@/lib/auth-context";

export default function DanfeTinyPage() {
  const { token } = useAuth();
  // Login via "Modo Demonstração" (token 'mock-demo-token') força dados mock mesmo
  // que NEXT_PUBLIC_DATA_MODE=live esteja setada (ex.: dev local apontando pro backend real).
  const isDemo = token === 'mock-demo-token' || process.env.NEXT_PUBLIC_DATA_MODE === 'demo';
  return (
    <DanfePanel
      config={{
        mode: !isDemo && process.env.NEXT_PUBLIC_DATA_MODE === "live" ? "live" : "demo",
        apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? "",
      }}
    />
  );
}
