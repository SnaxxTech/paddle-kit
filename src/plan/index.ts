// Plan state: what an account may do, from its age, exemption and subscription.
// Pure and edge-safe (no node: imports, no runtime deps) so tests and servers share it.

export type Plan =
  | { kind: 'free' }
  | { kind: 'paid' }
  | { kind: 'trial'; endsAt: number; daysLeft: number }
  | { kind: 'expired'; endedAt: number };

export interface PlanInput {
  /** Always free (demo or internal accounts). Wins over everything, including a subscription. */
  exempt: boolean;
  /** When the account was created, epoch ms. */
  startedAt: number;
  /**
   * When billing starts, epoch ms. Accounts older than this get their trial from the launch
   * instead of from their own start (launch grace).
   * `null` means "no launch grace": the trial simply counts from `startedAt`. It does NOT
   * mean "billing is off / free" — use `exempt` for free accounts, and gate enforcement in the
   * app (e.g. a BILLING_ENFORCE flag) before acting on an `expired` plan.
   */
  launchAt: number | null;
  /** Trial length in days. 0 (or negative / non-finite) means no trial. */
  trialDays: number;
  /** Has an active paid subscription. */
  subscribed: boolean;
  /** Current time, epoch ms. */
  now: number;
}

const DAY = 86_400_000;

export function planOf(i: PlanInput): Plan {
  if (i.exempt) return { kind: 'free' };
  if (i.subscribed) return { kind: 'paid' };
  const from = i.launchAt === null ? i.startedAt : Math.max(i.startedAt, i.launchAt);
  const days = Number.isFinite(i.trialDays) && i.trialDays > 0 ? i.trialDays : 0;
  if (days === 0) return { kind: 'expired', endedAt: from };
  const endsAt = from + days * DAY;
  if (i.now < endsAt) return { kind: 'trial', endsAt, daysLeft: Math.ceil((endsAt - i.now) / DAY) };
  return { kind: 'expired', endedAt: endsAt };
}
