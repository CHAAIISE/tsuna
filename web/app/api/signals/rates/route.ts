import { withX402 } from "@x402/next";
import { NextResponse } from "next/server";
import { blendRatesSignal } from "@/lib/signals/blend-rates";
import { ratesRoute, x402Server } from "@/lib/signals/x402";

/** Blend pool rates, paid per call over x402; settlement happens only after a successful response. */
export const GET = withX402(async () => NextResponse.json(await blendRatesSignal()), ratesRoute(), x402Server);
