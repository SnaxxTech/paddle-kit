import { PriceMap } from '../config/index.js';
import { F as FetchLike } from '../paddle-api-D4F0p5Zv.js';
export { L as LIVE_BASE, P as PaddleError, S as SANDBOX_BASE, r as redactSecrets } from '../paddle-api-D4F0p5Zv.js';

/** Everything paddle-kit's webhook handler understands (AppCare imports this name). */
declare const EVENTS: readonly string[];
type Cycle = 'monthly' | 'yearly' | 'once';
declare const TAX_CATEGORIES: readonly ["digital-goods", "ebooks", "implementation-services", "professional-services", "saas", "software-programming-services", "standard", "training-services", "website-hosting"];
interface CatalogPrice {
    key: string;
    cycle: Cycle;
    name: string;
    /** Lowest currency unit as a string, e.g. "1000" = 10.00 USD. */
    amount: string;
    currency: string;
    description?: string;
    quantity?: {
        min: number;
        max: number;
    };
}
interface Catalog {
    app: string;
    product: {
        name: string;
        taxCategory: (typeof TAX_CATEGORIES)[number];
        description?: string;
    };
    prices: CatalogPrice[];
}

declare class CatalogError extends Error {
    name: string;
}
declare function validateCatalog(input: unknown): Catalog;
/** Reads and validates a catalog JSON file. */
declare function readCatalogFile(file: string): Catalog;
/** Groups prices into the PriceMap the app puts in PADDLE_PRICES. */
declare function toPriceMap(catalog: Catalog, ids: Record<string, string>): PriceMap;
declare function readEnvFile(file: string): Record<string, string>;
declare function writeEnvFile(file: string, updates: Record<string, string | undefined>): string[];
interface SyncOptions {
    apiKey: string;
    catalog: Catalog;
    /** Full https URL Paddle should POST to. Enables the destination and client-token steps (PADDLE_ENV is always written). */
    webhookUrl?: string;
    /** Env file to read/write incrementally (mode 0600). Without it nothing is written and `env` is returned. */
    envFile?: string;
    /** Archive the marked prices and product, deactivate the destination. */
    teardown?: boolean;
    /** Allow a non-sandbox key. Client tokens starting with test_ are then refused. */
    live?: boolean;
    fetch?: FetchLike;
    log?: (line: string) => void;
}
interface SyncResult {
    environment: 'sandbox' | 'production';
    productId: string | null;
    priceIds: Record<string, string>;
    prices: PriceMap;
    rows: string[][];
    /** Names of env variables written to `envFile`. */
    written: string[];
    /** Only when no `envFile` was given: the values that would have been written. Contains secrets. */
    env?: Record<string, string>;
}
declare function describeKey(apiKey: string, live: boolean): 'sandbox' | 'production';
declare function syncCatalog(opts: SyncOptions): Promise<SyncResult>;

export { CatalogError, EVENTS, FetchLike, PriceMap, describeKey, readCatalogFile, readEnvFile, syncCatalog, toPriceMap, validateCatalog, writeEnvFile };
export type { Catalog, CatalogPrice, Cycle, SyncOptions, SyncResult };
