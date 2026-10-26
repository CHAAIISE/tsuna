"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CircleHelp } from "lucide-react";
import { cn } from "cn";
import { usePasskeyAccount } from "@/lib/hooks/use-passkey-account";

const STORAGE_KEY = "tsuna.tour";
const GAP = 16;
const MARGIN = 16;

const STEPS = [
  {
    target: "agents",
    title: "Agents at work",
    body: "Each row is a vault run by an AI agent. Returns, drawdown and TVL come from on-chain events, not from our server.",
  },
  {
    target: "rules",
    title: "Rules it can't break",
    body: "Every vault carries its own limits. The contract checks each agent call against them, inside the same transaction.",
  },
  {
    target: "account",
    title: "One passkey, no wallet",
    body: "Sign in with Face ID or Touch ID. No seed phrase and no gas: Tsuna pays the network fees, then sends you test USDC.",
  },
  {
    target: "nav",
    title: "Everything else",
    body: "Portfolio tracks your deposits. Create publishes your own agent. Bridge brings USDC over from Ethereum.",
  },
] as const;

/**
 * Tour of the agents screen: a card pinned next to each part of the screen, with the rest dimmed.
 * Starts by itself on the first visit (automated browsers excepted, so scripted runs see the bare screen);
 * the "?" button replays it from any app screen.
 */
export function AppTour() {
  const pathname = usePathname();
  const router = useRouter();
  const { account } = usePasskeyAccount();
  // Read on the client only: the server and automated browsers never show the tour.
  const firstVisit = useSyncExternalStore(
    () => () => {},
    () => !navigator.webdriver && !window.localStorage.getItem(STORAGE_KEY),
    () => false,
  );
  const [step, setStep] = useState<number | null>(0);
  const [replay, setReplay] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const spotlight = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);

  const finish = () => {
    window.localStorage.setItem(STORAGE_KEY, "done");
    setStep(null);
  };

  const current = step === null || !(firstVisit || replay) || pathname !== "/agents" ? null : STEPS[step];

  useEffect(() => {
    if (!current) return;
    const target = document.querySelector<HTMLElement>(`[data-tour="${current.target}"]`);
    if (target) {
      const tall = target.getBoundingClientRect().height > window.innerHeight * 0.6;
      target.scrollIntoView({ block: tall ? "start" : "center", behavior: "smooth" });
    }
    next.current?.focus({ preventScroll: true });

    // Follow the target every frame: it moves while the page scrolls and while live data fills it in.
    let frame = 0;
    const place = () => {
      frame = requestAnimationFrame(place);
      const box = card.current;
      const hole = spotlight.current;
      const node = document.querySelector<HTMLElement>(`[data-tour="${current.target}"]`);
      if (!box || !hole) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = box.offsetWidth;
      const height = box.offsetHeight;
      if (!node) {
        hole.style.opacity = "0";
        box.style.transform = `translate(${(vw - width) / 2}px, ${vh - height - MARGIN * 2}px)`;
        return;
      }
      const rect = node.getBoundingClientRect();
      const top = Math.max(rect.top - 8, 8);
      const bottom = Math.min(rect.bottom + 8, vh - 8);
      hole.style.opacity = "1";
      hole.style.transform = `translate(${rect.left - 8}px, ${top}px)`;
      hole.style.width = `${rect.width + 16}px`;
      hole.style.height = `${Math.max(bottom - top, 0)}px`;

      const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, MARGIN), vw - width - MARGIN);
      const y = bottom + GAP + height < vh
        ? bottom + GAP
        : top - GAP - height > 0
          ? top - GAP - height
          : vh - height - MARGIN * 2;
      box.style.transform = `translate(${left}px, ${y}px)`;
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [current]);

  const open = current !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      window.localStorage.setItem(STORAGE_KEY, "done");
      setStep(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (step === null || !current) {
    return (
      <button
        type="button"
        aria-label="Replay the tour"
        title="Replay the tour"
        onClick={() => {
          setReplay(true);
          setStep(0);
          if (pathname !== "/agents") router.push("/agents");
        }}
        className="fixed right-5 bottom-5 z-40 flex size-11 items-center justify-center rounded-full border border-primary/40 bg-card text-primary shadow-card transition-colors hover:bg-primary hover:text-primary-foreground"
      >
        <CircleHelp aria-hidden="true" className="size-5" />
      </button>
    );
  }

  const last = step === STEPS.length - 1;

  return (
    <>
      <div
        ref={spotlight}
        aria-hidden="true"
        className="pointer-events-none fixed top-0 left-0 z-50 rounded-xl opacity-0 shadow-[0_0_0_100vmax_rgb(15_23_42/0.35)] transition-[transform,width,height,opacity] duration-300 ease-out"
      />
      <div
        ref={card}
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        className="fixed top-0 left-0 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-primary/25 bg-card p-6 text-card-foreground shadow-2xl transition-transform duration-300 ease-out"
      >
        <p className="font-display text-xs tracking-[0.18em] text-primary uppercase">
          Step {step + 1} / {STEPS.length}
        </p>
        <h2 id="tour-title" className="mt-2 font-editorial text-2xl font-medium text-heading">{current.title}</h2>
        <p id="tour-body" className="mt-2 text-sm leading-relaxed text-muted-foreground">{current.body}</p>
        <div aria-hidden="true" className="mt-5 flex items-center gap-1.5">
          {STEPS.map((item, index) => (
            <span key={item.target} className={cn("h-1.5 rounded-full transition-all duration-300", index === step ? "w-6 bg-primary" : "w-1.5 bg-primary/20")} />
          ))}
        </div>
        <div className="mt-6 flex items-center justify-between gap-3">
          <button type="button" onClick={finish} className="rounded-sm px-1 py-1 text-sm text-muted-foreground transition-colors hover:text-heading">
            Skip the tour
          </button>
          <button
            ref={next}
            type="button"
            onClick={() => {
              if (!last) return setStep(step + 1);
              finish();
              if (!account) router.push("/onboarding");
            }}
            className="rounded-sm bg-primary px-5 py-2.5 font-display text-xs tracking-[0.14em] text-primary-foreground uppercase transition-colors hover:bg-primary-hover"
          >
            {last ? (account ? "Done" : "Create my passkey") : "Next"}
          </button>
        </div>
      </div>
    </>
  );
}
