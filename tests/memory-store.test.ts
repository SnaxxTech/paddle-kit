import { memoryStore } from '../src/memory';
import { runStoreContract } from './helpers/store-contract';

runStoreContract('memory', async () => memoryStore());
