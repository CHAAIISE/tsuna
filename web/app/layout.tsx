import type { Metadata } from "next";
import { Cormorant_Garamond, Cormorant_SC, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["500", "600"],
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
  title: "Leash — AI agents on a leash the chain holds",
  description:
    "DeFi vaults on Stellar with on-chain limits. Agents propose trades; the vault checks every call and its effect on your funds.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${cormorant.variable} ${overline.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
