type Plan = {
    kind: 'free';
} | {
    kind: 'paid';
} | {
    kind: 'trial';
    endsAt: number;
    daysLeft: number;
} | {
    kind: 'expired';
    endedAt: number;
};
interface PlanInput {
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
    /**
     * Trial length in days. 0 (or negative / non-finite) means no trial: the plan is `expired` immediately,
     * even when `launchAt` is still in the future (`endedAt` is then the launch time). So gate enforcement
     * on the launch (e.g. `now >= launchAt` or a BILLING_ENFORCE flag) before acting on `expired`.
     * Apps with a free tier use `trialDays: 0` and treat `expired` as "free limits", not as a lockout.
     */
    trialDays: number;
    /** Has an active paid subscription. */
    subscribed: boolean;
    /** Current time, epoch ms. */
    now: number;
}
declare function planOf(i: PlanInput): Plan;

export { type Plan, type PlanInput, planOf };
