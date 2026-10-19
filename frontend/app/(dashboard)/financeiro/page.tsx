'use client';

import Overview from "../../components/overview";
import { useAuth } from "@/lib/auth-context";

export default function FinanceiroOverviewPage() {
  const { token } = useAuth();
  // Login via "Modo Demonstração" (token 'mock-demo-token') força dados mock mesmo
  // que NEXT_PUBLIC_DATA_MODE=live esteja setada (ex.: dev local apontando pro backend real).
  const isDemo = token === 'mock-demo-token' || process.env.NEXT_PUBLIC_DATA_MODE === 'demo';
  return (
    <Overview
      config={{
        mode: !isDemo && process.env.NEXT_PUBLIC_DATA_MODE === "live" ? "live" : "demo",
        apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? "",
      }}
    />
  );
}
