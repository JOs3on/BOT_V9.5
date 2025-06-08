const {
    Connection,
    PublicKey,
    Transaction,
    sendAndConfirmTransaction,
    ComputeBudgetProgram,
    SystemProgram
} = require('@solana/web3.js');
const {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
    createSyncNativeInstruction,
    createCloseAccountInstruction,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    NATIVE_MINT
} = require('@solana/spl-token');
const raydium = require('@raydium-io/raydium-sdk-v2');
const BN = require('bn.js');
require('dotenv').config();

// Constants
const WSOL_MINT = NATIVE_MINT.toString();
const PRIORITY_FEE_MULTIPLIER = Number(process.env.PRIORITY_FEE_MULTIPLIER) || 1.5;
const BASE_SLIPPAGE_BPS = 50; // 0.5% default slippage
const VOLATILE_SLIPPAGE_BPS = 200; // 2% for new pools

class SwapCreator {
    constructor() {
        this.connection = new Connection(
            process.env.SOLANA_RPC_URL || process.env.SOLANA_WS_URL,
            'confirmed'
        );
        this.raydium = null;
    }

    async initializeRaydium(owner) {
        if (!this.raydium) {
            this.raydium = await raydium.Raydium.load({
                connection: this.connection,
                owner: owner,
            });
            console.log('[SwapCreator] Raydium SDK initialized');
        }
    }

    /**
     * Main swap function - creates and executes swap transaction
     * @param {Object} params
     * @param {Object} params.tokenData - Full token data from sniper
     * @param {string|BN} params.amountSpecified - Amount to swap (in lamports)
     * @param {boolean} params.swapBaseIn - true for base->quote, false for quote->base
     * @param {Keypair} params.owner - Wallet keypair
     */
    async swapTokens({ tokenData, amountSpecified, swapBaseIn, owner }) {
        try {
            console.log(`[SwapCreator] Starting swap - Base->Quote: ${swapBaseIn}, Amount: ${amountSpecified}`);

            // Initialize Raydium SDK
            await this.initializeRaydium(owner.publicKey);

            // Convert amount to BN
            const amount = typeof amountSpecified === 'string' ? new BN(amountSpecified) : amountSpecified;

            // Get pool keys from static tokenData
            const poolKeys = this.createPoolKeysFromTokenData(tokenData);

            // Refresh pool state
            await this.raydium.liquidity.refreshPools([poolKeys.id]);
            const poolState = this.raydium.liquidity.getPool(poolKeys.id);
            if (!poolState) throw new Error('Pool state not found');

            // Determine swap parameters
            const isInputSOL = swapBaseIn ? false : tokenData.isWSOLSwap;
            const isOutputSOL = swapBaseIn ? tokenData.isWSOLSwap : false;

            // Get dynamic slippage (higher for new pools)
            const slippageBps = tokenData.poolAgeMinutes < 5 ? VOLATILE_SLIPPAGE_BPS : BASE_SLIPPAGE_BPS;
            console.log(`[SwapCreator] Using slippage: ${slippageBps/100}%`);

            // Create transaction
            const transaction = new Transaction();

            // 1. Priority fee
            transaction.add(
                ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
                ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: Math.floor(50000 * PRIORITY_FEE_MULTIPLIER)
                })
            );

            // 2. Token account creation
            const tokenAccountInstructions = await this.createTokenAccountInstructions(
                owner.publicKey,
                tokenData,
                swapBaseIn
            );
            transaction.add(...tokenAccountInstructions);

            // 3. WSOL wrapping for input
            let wsolInputAccount = null;
            if (isInputSOL) {
                const wrapInstructions = this.createWrapSOLInstructions(
                    owner.publicKey,
                    tokenData.userBaseTokenAccount,
                    amount
                );
                transaction.add(...wrapInstructions);
                wsolInputAccount = tokenData.userBaseTokenAccount;
            }

            // 4. Swap instruction
            const { transaction: swapTx, signers } = await this.raydium.trade.directSwap({
                poolKeys: poolKeys,
                amountIn: swapBaseIn ? amount : undefined,
                amountOut: swapBaseIn ? undefined : amount,
                fixedSide: swapBaseIn ? 'in' : 'out',
                owner: owner.publicKey,
                slippage: new raydium.Percent(slippageBps, 10000)
            });
            transaction.add(...swapTx.instructions);

            // 5. WSOL unwrapping for output
            if (isOutputSOL) {
                const outputTokenAccount = swapBaseIn
                    ? tokenData.userQuoteTokenAccount
                    : tokenData.userBaseTokenAccount;
                transaction.add(
                    createCloseAccountInstruction(
                        new PublicKey(outputTokenAccount),
                        owner.publicKey,
                        owner.publicKey
                    )
                );
            }

            // Send and confirm transaction
            const signersList = [owner, ...signers];
            const signature = await sendAndConfirmTransaction(
                this.connection,
                transaction,
                signersList,
                {
                    commitment: 'confirmed',
                    maxRetries: 3,
                    skipPreflight: false
                }
            );

            console.log(`[SwapCreator] Swap successful! Signature: ${signature}`);
            return signature;

        } catch (error) {
            console.error('[SwapCreator] Swap failed:', error);
            this.debugTokenAccountState(tokenData, owner.publicKey);
            throw error;
        }
    }

    createPoolKeysFromTokenData(tokenData) {
        // Main pool accounts
        const poolKeys = {
            id: new PublicKey(tokenData.ammId),
            baseMint: new PublicKey(tokenData.baseMint),
            quoteMint: new PublicKey(tokenData.quoteMint),
            baseVault: new PublicKey(tokenData.baseVault),
            quoteVault: new PublicKey(tokenData.quoteVault),
            authority: new PublicKey(tokenData.ammAuthority),
            openOrders: new PublicKey(tokenData.ammOpenOrders),
            targetOrders: new PublicKey(tokenData.targetOrders),
            marketId: new PublicKey(tokenData.marketId),
            programId: new PublicKey(tokenData.programId),
            marketProgramId: new PublicKey(tokenData.marketProgramId),
            marketBids: new PublicKey(tokenData.marketBids),
            marketAsks: new PublicKey(tokenData.marketAsks),
            marketEventQueue: new PublicKey(tokenData.marketEventQueue),
            marketBaseVault: new PublicKey(tokenData.marketBaseVault),
            marketQuoteVault: new PublicKey(tokenData.marketQuoteVault),
            marketAuthority: new PublicKey(tokenData.marketAuthority),
            vaultOwner: new PublicKey(tokenData.vaultOwner),
        };

        // Debug: Verify derived addresses match static data
        try {
            const derivedAuthority = raydium.liquidity.getAssociatedAuthority({
                programId: poolKeys.programId
            }).publicKey;

            if (!derivedAuthority.equals(poolKeys.authority)) {
                console.warn('[DEBUG] Authority mismatch!',
                    `Static: ${poolKeys.authority}`,
                    `Derived: ${derivedAuthority}`
                );
            }
        } catch (derivationError) {
            console.warn('[DEBUG] Authority derivation failed:', derivationError);
        }

        return poolKeys;
    }

    createWrapSOLInstructions(owner, wsolAccount, amount) {
        const instructions = [
            SystemProgram.transfer({
                fromPubkey: owner,
                toPubkey: new PublicKey(wsolAccount),
                lamports: amount.toNumber()
            }),
            createSyncNativeInstruction(new PublicKey(wsolAccount))
        ];
        console.log('[SwapCreator] Added WSOL wrap instructions');
        return instructions;
    }

    async createTokenAccountInstructions(owner, tokenData, swapBaseIn) {
        const instructions = [];
        const outputToken = swapBaseIn ? tokenData.quoteMint : tokenData.baseMint;
        const outputTokenAccount = swapBaseIn
            ? tokenData.userQuoteTokenAccount
            : tokenData.userBaseTokenAccount;

        try {
            // Only create output token account if needed
            const accountInfo = await this.connection.getAccountInfo(
                new PublicKey(outputTokenAccount)
            );

            if (!accountInfo) {
                const outputMint = new PublicKey(outputToken);
                instructions.push(
                    createAssociatedTokenAccountInstruction(
                        owner,
                        new PublicKey(outputTokenAccount),
                        owner,
                        outputMint
                    )
                );
                console.log(`[SwapCreator] Creating output token account: ${outputTokenAccount}`);
            }
        } catch (error) {
            console.error('[SwapCreator] Token account check failed - using static address anyway', error);
        }

        return instructions;
    }

    async debugTokenAccountState(tokenData, owner) {
        try {
            console.warn('[DEBUG] Verifying token accounts:');

            // Verify base token account
            const baseAccount = await this.connection.getAccountInfo(
                new PublicKey(tokenData.userBaseTokenAccount)
            );
            console.log(`- Base ATA ${tokenData.userBaseTokenAccount}:`,
                baseAccount ? 'Exists' : 'MISSING');

            // Verify quote token account
            const quoteAccount = await this.connection.getAccountInfo(
                new PublicKey(tokenData.userQuoteTokenAccount)
            );
            console.log(`- Quote ATA ${tokenData.userQuoteTokenAccount}:`,
                quoteAccount ? 'Exists' : 'MISSING');

            // Verify pool accounts
            const baseVault = await this.connection.getAccountInfo(
                new PublicKey(tokenData.baseVault)
            );
            console.log(`- Base Vault ${tokenData.baseVault}:`,
                baseVault ? 'Exists' : 'MISSING');

        } catch (error) {
            console.error('[DEBUG] Account verification failed:', error);
        }
    }
}

// Export singleton instance
module.exports = new SwapCreator();

// Also export the class for testing
module.exports.SwapCreator = SwapCreator;
