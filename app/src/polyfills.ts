// @solana/web3.js v1 expects Node's Buffer in the browser.
import { Buffer } from "buffer";
(globalThis as any).Buffer ??= Buffer;
