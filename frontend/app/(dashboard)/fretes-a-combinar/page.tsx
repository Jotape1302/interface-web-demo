'use client';

import FretesView from '../../components/fretes-view';

export default function FretesACombinarPage() {
  return <FretesView apiBaseUrl={process.env.NEXT_PUBLIC_API_BASE_URL ?? ''} />;
}
