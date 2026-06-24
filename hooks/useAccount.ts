import { useQuery } from '@tanstack/react-query';
import { api, queryKeys } from '@/lib/api-client';

// Cloudflare-Access auth (docs/cloudflare-access-auth.html, P2.2).
//
// The edge-trusted replacement for next-auth's `useSession` in the four
// components that previously gated on it. Once a request reaches the origin the
// owner is always present (the edge is the gate), so this never produces a
// "signed out" state to wall behind — it surfaces the owner identity plus
// `googleConnected`, which the views use only for a NON-blocking
// "Connect Gmail / Calendar" affordance.
//
// On the 0-users fresh-machine state `/api/account` 401s; react-query reports
// `isError` and `user` is undefined, so callers naturally show the connect path
// rather than a populated-but-broken view.
export function useAccount() {
    const { data, isLoading, isError } = useQuery({
        queryKey: queryKeys.account,
        queryFn: () => api.account.get(),
        // The owner is process-stable and connection state flips only on a
        // manual connect/disconnect, so don't churn this on window focus.
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
        // A 401 (fresh machine) shouldn't retry-storm; one connect fixes it.
        retry: false,
    });

    return {
        user: data?.user,
        googleConnected: data?.googleConnected ?? false,
        isLoading,
        isError,
    };
}
