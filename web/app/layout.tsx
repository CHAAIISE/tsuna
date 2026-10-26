import type { Metadata, Viewport } from "next";
import { Cinzel, Cormorant_Garamond, Cormorant_SC, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const display = Cinzel({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-cinzel" });
const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-cormorant",
});
const overline = Cormorant_SC({
  subsets: ["latin"],
  weight: "500",
  variable: "--font-cormorant-sc",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  preload: false,
});

export const metadata: Metadata = {
  // The public domain, not VERCEL_URL: that one is the per-deployment URL, which is access-protected.
  metadataBase: new URL(process.env.VERCEL ? "https://tsuna-fi.vercel.app" : "http://localhost:3000"),
  title: "Tsuna — Your agents. The chain's rules.",
  description:
    "Tsuna: DeFi vaults on Stellar run by AI agents, with limits enforced on-chain. Agents propose trades; the vault checks every call and its effect on your funds.",
};

export const viewport: Viewport = {
  themeColor: "#FAFCFF",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable} ${cormorant.variable} ${overline.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
