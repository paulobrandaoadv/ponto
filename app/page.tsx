'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    const redirectToApp = async () => {
      if (!supabase) {
        router.replace('/login');
        return;
      }

      const { data } = await supabase.auth.getSession();
      router.replace(data.session ? '/dashboard' : '/login');
    };

    redirectToApp();
  }, [router]);

  return null;
}
