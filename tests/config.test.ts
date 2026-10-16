import { describe, expect, it } from 'vitest';
import { readBillingEnv, type ReadBillingEnvOptions } from '../src/config';

const SECRET = 'pdl_ntfset_DISTINCTIVE_secret_9f3a';
const OPTS: ReadBillingEnvOptions = { requiredPrices: ['team', 'pack'] };
const nested = { team: { monthly: 'pri_PRICE_team_m_77', yearly: 'pri_PRICE_team_y_78' }, pack: 'pri_PRICE_pack_79' };
const valid = {
  PADDLE_ENV: 'sandbox',
  PADDLE_NOTIFICATION_WEBHOOK_SECRET: SECRET,
  PADDLE_PRICES: JSON.stringify(nested),
  NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: 'test_TOKEN_distinct_55',
  BILLING_LAUNCH_AT: '2026-10-20T00:00:00Z',
};
const problemsOf = (env: Record<string, string | undefined>, opts = OPTS) => readBillingEnv(env, opts).problems.join(' | ');

describe('readBillingEnv', () => {
  it('nothing watched set is silent', () => {
    expect(readBillingEnv({}, OPTS)).toEqual({ config: null, problems: [] });
    expect(readBillingEnv({ PADDLE_HEALTH_TOKEN: 'h', PADDLE_API_KEY: 'pdl_sdbx_apikey_x', UNRELATED: '1' }, OPTS)).toEqual({ config: null, problems: [] });
    expect(readBillingEnv({ PADDLE_ENV: '', PADDLE_PRICES: '' }, OPTS)).toEqual({ config: null, problems: [] });
  });

  it('a full valid environment is configured (nested and flat price maps)', () => {
    const r = readBillingEnv({ ...valid, BILLING_ENFORCE: '1', PADDLE_HEALTH_TOKEN: 'ht' }, OPTS);
    expect(r.problems).toEqual([]);
    expect(r.config).toEqual({
      environment: 'sandbox',
      webhookSecret: SECRET,
      prices: nested,
      clientToken: 'test_TOKEN_distinct_55',
      launchAt: Date.UTC(2026, 9, 20),
      enforce: true,
      healthToken: 'ht',
    });
  });

  it('defaults to sandbox, launchAt null and enforce false when optional variables are unset', () => {
    const { PADDLE_ENV: _e, BILLING_LAUNCH_AT: _l, ...rest } = valid;
    const { config, problems } = readBillingEnv(rest, OPTS);
    expect(problems).toEqual([]);
    expect(config).toMatchObject({ environment: 'sandbox', launchAt: null, enforce: false });
    expect(config).not.toHaveProperty('healthToken');
    expect(config).not.toHaveProperty('apiKey');
  });

  it('BILLING_ENFORCE is on only for exactly "1"', () => {
    for (const v of ['true', 'yes', '0', ' 1', '']) expect(readBillingEnv({ ...valid, BILLING_ENFORCE: v }, OPTS).config?.enforce).toBe(false);
  });

  it('production environment needs live_ token', () => {
    const live = { ...valid, PADDLE_ENV: 'production', NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: 'live_abc' };
    expect(readBillingEnv(live, OPTS).config?.environment).toBe('production');
    expect(problemsOf({ ...live, NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: 'test_abc' })).toContain('NEXT_PUBLIC_PADDLE_CLIENT_TOKEN');
  });

  it('a live client token without PADDLE_ENV=production is named', () => {
    const { config, problems } = readBillingEnv({ ...valid, NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: 'live_abc' }, OPTS);
    expect(config).toBeNull();
    expect(problems.join(';')).toContain('NEXT_PUBLIC_PADDLE_CLIENT_TOKEN');
  });

  it('an invalid PADDLE_ENV is named', () => {
    const { config, problems } = readBillingEnv({ ...valid, PADDLE_ENV: 'prod' }, OPTS);
    expect(config).toBeNull();
    expect(problems.join(';')).toContain('PADDLE_ENV');
  });

  it('each missing variable is named when others are set', () => {
    const only = { PADDLE_ENV: 'sandbox' };
    const p = problemsOf(only);
    for (const name of ['PADDLE_NOTIFICATION_WEBHOOK_SECRET', 'PADDLE_PRICES', 'NEXT_PUBLIC_PADDLE_CLIENT_TOKEN']) expect(p).toContain(name);
    expect(p).not.toContain('BILLING_LAUNCH_AT');
    expect(readBillingEnv(only, OPTS).config).toBeNull();
  });

  it('only the unset secret is named when the rest is valid', () => {
    const { PADDLE_NOTIFICATION_WEBHOOK_SECRET: _s, ...rest } = valid;
    const { problems } = readBillingEnv(rest, OPTS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('PADDLE_NOTIFICATION_WEBHOOK_SECRET');
  });

  describe('PADDLE_PRICES', () => {
    it('invalid JSON, non-object, array and empty-but-required are named', () => {
      for (const bad of ['not json', '"str"', '[]', 'null', '{}']) {
        const { config, problems } = readBillingEnv({ ...valid, PADDLE_PRICES: bad }, OPTS);
        expect(config).toBeNull();
        expect(problems.join(';')).toContain('PADDLE_PRICES');
      }
    });
    it('a missing required price is named', () => {
      const p = problemsOf({ ...valid, PADDLE_PRICES: JSON.stringify({ team: nested.team }) });
      expect(p).toContain('PADDLE_PRICES');
      expect(p).toContain('pack');
      expect(p).not.toContain('team');
    });
    it('empty ids and empty cycle maps are named', () => {
      expect(problemsOf({ ...valid, PADDLE_PRICES: JSON.stringify({ team: nested.team, pack: '' }) })).toContain('pack');
      expect(problemsOf({ ...valid, PADDLE_PRICES: JSON.stringify({ team: { monthly: '' }, pack: 'pri_x' }) })).toContain('team');
      expect(problemsOf({ ...valid, PADDLE_PRICES: JSON.stringify({ team: {}, pack: 'pri_x' }) })).toContain('team');
      expect(problemsOf({ ...valid, PADDLE_PRICES: JSON.stringify({ team: { monthly: 5 }, pack: 'pri_x' }) })).toContain('team');
    });
    it('extra, non-required entries are accepted when well-formed and rejected when not', () => {
      const withExtra = { ...nested, bonus: 'pri_bonus' };
      expect(readBillingEnv({ ...valid, PADDLE_PRICES: JSON.stringify(withExtra) }, OPTS).config?.prices).toEqual(withExtra);
      expect(problemsOf({ ...valid, PADDLE_PRICES: JSON.stringify({ ...nested, bonus: 3 }) })).toContain('PADDLE_PRICES');
    });
    it('with no required prices an empty map is fine', () => {
      expect(readBillingEnv({ ...valid, PADDLE_PRICES: '{}' }, { requiredPrices: [] }).config?.prices).toEqual({});
    });
  });

  describe('BILLING_LAUNCH_AT', () => {
    it('is parsed to epoch ms when it is ISO with a timezone', () => {
      expect(readBillingEnv({ ...valid, BILLING_LAUNCH_AT: '2026-10-20T02:00:00+02:00' }, OPTS).config?.launchAt).toBe(Date.UTC(2026, 9, 20));
    });
    it('a non-date, a date without time or timezone is named', () => {
      for (const bad of ['nope', '2026-10-20', '2026-10-20T00:00:00', '2026-13-45T00:00:00Z']) {
        const { config, problems } = readBillingEnv({ ...valid, BILLING_LAUNCH_AT: bad }, OPTS);
        expect(config, bad).toBeNull();
        expect(problems.join(';'), bad).toContain('BILLING_LAUNCH_AT');
      }
    });
    it('requireLaunchAt makes an unset value a problem', () => {
      const { BILLING_LAUNCH_AT: _l, ...rest } = valid;
      expect(problemsOf(rest, { ...OPTS, requireLaunchAt: true })).toContain('BILLING_LAUNCH_AT');
      expect(readBillingEnv(rest, { ...OPTS, requireLaunchAt: true }).config).toBeNull();
      expect(readBillingEnv(rest, OPTS).config?.launchAt).toBeNull();
    });
  });

  describe('PADDLE_API_KEY', () => {
    it('is passed through when its prefix matches the environment', () => {
      expect(readBillingEnv({ ...valid, PADDLE_API_KEY: 'pdl_sdbx_apikey_abc' }, OPTS).config?.apiKey).toBe('pdl_sdbx_apikey_abc');
      const live = { ...valid, PADDLE_ENV: 'production', NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: 'live_t', PADDLE_API_KEY: 'pdl_live_apikey_abc' };
      expect(readBillingEnv(live, OPTS).config?.apiKey).toBe('pdl_live_apikey_abc');
    });
    it('a mismatched prefix is named', () => {
      const { config, problems } = readBillingEnv({ ...valid, PADDLE_API_KEY: 'pdl_live_apikey_abc' }, OPTS);
      expect(config).toBeNull();
      expect(problems.join(';')).toContain('PADDLE_API_KEY');
      expect(problemsOf({ ...valid, PADDLE_ENV: 'production', NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: 'live_t', PADDLE_API_KEY: 'pdl_sdbx_apikey_abc' })).toContain('PADDLE_API_KEY');
    });
    it('alone does not make the environment "configured"', () => {
      expect(readBillingEnv({ PADDLE_API_KEY: 'pdl_live_apikey_abc' }, OPTS)).toEqual({ config: null, problems: [] });
    });
  });

  it('problem strings never contain any planted secret, token, key or price value', () => {
    const planted = {
      PADDLE_ENV: 'bogus_ENV_VALUE_1',
      PADDLE_NOTIFICATION_WEBHOOK_SECRET: SECRET,
      PADDLE_PRICES: JSON.stringify({ team: { monthly: 'pri_PLANTED_m', yearly: 7 }, pack: 'pri_PLANTED_p', bonus: ['pri_PLANTED_arr'] }),
      NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: 'wrongprefix_TOKEN_PLANTED',
      BILLING_LAUNCH_AT: 'PLANTED_not_a_date',
      PADDLE_API_KEY: 'wrongprefix_APIKEY_PLANTED',
      PADDLE_HEALTH_TOKEN: 'HEALTH_PLANTED',
    };
    const { config, problems } = readBillingEnv(planted, { ...OPTS, requireLaunchAt: true });
    expect(config).toBeNull();
    expect(problems.length).toBeGreaterThanOrEqual(5);
    const all = problems.join('\n');
    for (const value of Object.values(planted)) expect(all).not.toContain(value);
    for (const frag of ['PLANTED', 'DISTINCTIVE', 'bogus_ENV_VALUE_1', 'pri_']) expect(all).not.toContain(frag);
    // invalid JSON must not echo a fragment either
    const bad = readBillingEnv({ ...valid, PADDLE_PRICES: '{"team": PLANTED_FRAG' }, OPTS);
    expect(bad.problems.join('\n')).not.toContain('PLANTED_FRAG');
  });
});
