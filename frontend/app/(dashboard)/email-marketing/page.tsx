'use client';

import MarketingView from '@/app/components/marketing-view';
import { useAuth } from '@/lib/auth-context';

export default function EmailMarketingPage() {
  const { isDemoMode } = useAuth();
  const mode = isDemoMode || process.env.NEXT_PUBLIC_DATA_MODE === 'demo' ? 'demo' : 'live';

  return <MarketingView mode={mode} />;
}
