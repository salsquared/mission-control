import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { QueryProvider } from "@/components/providers/QueryProvider";
import { ToastHost } from "@/components/ui/ToastHost";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Mission Control",
  description: "Advanced dashboard for monitoring and autonomous systems control.",
  manifest: "/manifest.json",
};

// viewportFit: 'cover' lets the layout reach env(safe-area-inset-*) on notched
// iPhones. Without width=device-width the page renders at 980px-default zoomed
// out on iOS Safari — making the mobile shell (Track D / MD-3) unusable.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased custom-scrollbar`}
        suppressHydrationWarning
      >
        {/* In dev mode, unregister any previously-cached service worker to prevent cross-device reload issues */}
        {process.env.NODE_ENV !== 'production' && (
          <script dangerouslySetInnerHTML={{ __html: `
            if ('serviceWorker' in navigator) {
              navigator.serviceWorker.getRegistrations().then(function(registrations) {
                registrations.forEach(function(registration) {
                  registration.unregister();
                  console.log('[SW] Unregistered service worker in dev mode');
                });
              });
            }
          `}} />
        )}
        {/* No NextAuthProvider. It existed only to serve `useSession`, which has
            no callers — identity comes from `useAccount()` / `/api/account`,
            resolved at the origin from the Cloudflare-Access-verified header.
            Worse than merely unused: it polled `/api/auth/session` every 5
            minutes, and on prod that path sits behind its own owner-only Access
            application which answers a cross-origin 302 that `fetch` cannot
            follow — so it logged a `CLIENT_FETCH_ERROR` on a timer forever. */}
        <QueryProvider>
          <ThemeProvider>
            {children}
            <ToastHost />
          </ThemeProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
