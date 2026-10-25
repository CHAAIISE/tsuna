import { chargeSignal } from "@/lib/signals/mpp";
import { reflectorRiskSignal } from "@/lib/signals/reflector-risk";

/** XLM risk signal from Reflector prices, paid per call with an MPP charge. */
export async function GET(request: Request) {
  return chargeSignal(request, "XLM risk signal from Reflector prices", async () => Response.json(await reflectorRiskSignal()));
}
