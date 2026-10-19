import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "./components/theme-provider";
import { AuthProvider } from "@/lib/auth-context";
import { themeInitScript } from "@/lib/theme";
import { Toaster } from "@/components/ui/toast";

// Inter = fonte oficial da identidade Norvia. Baixada no build e servida pelo próprio painel
// (CSP `font-src 'self'`): nada de Google Fonts em runtime.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  icons: { icon: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/favicon.svg` },
  title: "NORVIA AUTOMAÇÕES | Central de controle",
  description:
    "Central de controle das NORVIA AUTOMAÇÕES: produtividade, aprovações e telemetria operacional.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" className="dark" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeInitScript }} /></head>
      <body className={`${inter.variable} ${geistMono.variable} antialiased`}>
        <Toaster>
          <AuthProvider>
            <ThemeProvider>{children}</ThemeProvider>
          </AuthProvider>
        </Toaster>
      </body>
    </html>
  );
}
