import { SectionIntro } from "./section";

const keys = [
  {
    key: "Agent session keys",
    demo: "Held by the agent runtime on the Tsuna server. They can only call execute: the vault checks every call against its rules and its outcome.",
    production: "Same. The key is the agent's, and it stays powerless outside the rules whoever holds it.",
  },
  {
    key: "Vault creator",
    demo: "Create publishes with one demo creator key, signed server-side. The creator sets the rules (behind a 10-minute timelock), can pause and can rotate the agent key. It can never withdraw depositors' shares.",
    production: "The creator's own passkey or wallet signs the factory call, exactly as depositors already sign their deposits.",
  },
  {
    key: "Factory admins (2 of 2)",
    demo: "Both admin keys sit on the same server, so the demo shows the flow (two signatures, public 10-minute timelock) rather than real separation.",
    production: "Two independent signers, such as separate teams or a multisig, and a timelock of days so depositors can exit before a patch lands.",
  },
  {
    key: "Oracle admin",
    demo: "Feed and configuration changes wait out a public 10-minute timelock, and a vault only moves to another router behind its own timelock. The demo build also has a switch its admin uses to force a price for the crash scenario.",
    production: "The router without the demo feature, a timelock of days, and independent signers.",
  },
  {
    key: "Bridge wallet",
    demo: "The CCTP burn on Ethereum Sepolia is signed by a server wallet; the mint and the vault deposit on Stellar are real.",
    production: "The user's EVM wallet signs the burn.",
  },
  {
    key: "Relayer, fee payers, faucet",
    demo: "Pay network fees and send test USDC. A fee payer cannot sign for an account.",
    production: "Fee sponsorship stays; the faucet goes away.",
  },
] as const;

function Keys() {
  return (
    <section id="keys" aria-labelledby="keys-title" className="page-x border-t bg-muted py-20 sm:py-24">
      <SectionIntro
        id="keys-title"
        overline="Keys"
        title={<>Who holds what. <span className="font-editorial text-[1.1em] italic">Demo and production.</span></>}
        lead="The rules are enforced by the contracts, but this testnet demo still runs some keys on the Tsuna server. Here is each one, what it can do today, and who holds it in production."
      />
      <div className="mt-14 overflow-x-auto">
        <table className="w-full min-w-[720px] text-left">
          <thead className="border-b text-caption text-muted-foreground">
            <tr>
              <th scope="col" className="w-52 py-3 pr-6 font-normal">Key</th>
              <th scope="col" className="py-3 pr-6 font-normal">In this demo</th>
              <th scope="col" className="py-3 font-normal">In production</th>
            </tr>
          </thead>
          <tbody className="divide-y border-b">
            {keys.map(row => (
              <tr key={row.key} className="align-top">
                <th scope="row" className="py-5 pr-6 font-medium text-heading">{row.key}</th>
                <td className="py-5 pr-6 leading-relaxed text-muted-foreground">{row.demo}</td>
                <td className="py-5 leading-relaxed text-foreground">{row.production}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export { Keys };
