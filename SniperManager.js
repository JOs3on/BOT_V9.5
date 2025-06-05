const Sniper = require('./Sniper');
require('dotenv').config();          // Load BUY_AMOUNT / SELL_TARGET_PRICE

class SniperManager {
    constructor() {
        this.snipers = [];               // simple in‑memory storage
    }

    /**
     * Add and start a sniper.
     * @param {Object} lp  Full LP tokenData object (already decoded & persisted)
     */
    async addSniper(lp) {
        try {
            // ─── Inject trading params from .env ──────────────────────
            const buyAmount       = Number(process.env.BUY_AMOUNT);
            const sellTargetPrice = Number(process.env.SELL_TARGET_PRICE); // % gain

            if (Number.isNaN(buyAmount) || Number.isNaN(sellTargetPrice)) {
                throw new Error(
                    `Invalid BUY_AMOUNT or SELL_TARGET_PRICE in .env (got “${process.env.BUY_AMOUNT}” / “${process.env.SELL_TARGET_PRICE}”)`
                );
            }

            const sniperCfg = {
                ...lp,                     // LP metadata
                buyAmount,                 // 0.02 SOL (example)
                sellTargetPrice            // 100 → +100 %
            };

            // One‑hop: cfg + full LP data
            const sniper = new Sniper(sniperCfg, lp);
            this.snipers.push(sniper);

            console.log(
                '[SniperManager] Sniper added – baseMint:',
                lp.baseMint,
                '| buyAmount:',
                buyAmount,
                '| target%:',
                sellTargetPrice
            );

            // Auto‑buy then subscribe to vault changes
            await sniper.executeBuy();
            console.log('[SniperManager] Buy executed – subscribing to vault …');
            await sniper.subscribeToVault();
        } catch (err) {
            console.error('[SniperManager] addSniper error:', err.message);
        }
    }
    /*  helper mutators  */
    setBuyAmount(index, amount) {
        if (this.snipers[index]) {
            this.snipers[index].setBuyAmount?.(amount);
            console.log(`Buy amount set to ${amount} for sniper at index ${index}`);
        } else {
            console.error('Sniper not found at index:', index);
        }
    }

    setSellTargetPrice(index, price) {
        if (this.snipers[index]) {
            this.snipers[index].setSellTargetPrice?.(price);
            console.log(`Sell target price set to ${price}% for sniper at index ${index}`);
        } else {
            console.error('Sniper not found at index:', index);
        }
    }

    async init() {
        console.log('Sniper Manager initialized');
    }
}

module.exports = new SniperManager();
