/** TanStack Query keys of the app screens. */
export const queryKeys = {
  agents: ["agents"] as const,
  vault: (id: string) => ["vault", id] as const,
  activity: (id: string) => ["activity", id] as const,
  holdings: (user: string) => ["holdings", user] as const,
  run: (id: string) => ["run", id] as const,
};
