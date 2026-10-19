'use client';

import DimensoesView from '../../components/dimensoes-view';

export default function PadronizacaoDimensoesPage() {
  return <DimensoesView apiBaseUrl={process.env.NEXT_PUBLIC_API_BASE_URL ?? ''} />;
}
