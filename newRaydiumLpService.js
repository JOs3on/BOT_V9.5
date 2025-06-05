/*****************************************************************
 newRaydiumLpService.js – BOT 9.35  (K & V scaling fixed)
 *****************************************************************/
const { Connection, PublicKey } = require('@solana/web3.js');
const { MongoClient } = require('mongodb');
const { liquidityStateV4Layout } = require('@raydium-io/raydium-sdk-v2');
require('dotenv').config();

/* ── constants & singletons ───────────────────────────────────*/
const connection = new Connection(process.env.SOLANA_WS_URL, 'confirmed');
const RAYDIUM_AMM = new PublicKey(process.env.RAYDIUM_AMM_PROGRAM_ID);
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

let db;
async function connectDB() {
    if (db) return db;
    db = (await new MongoClient(process.env.MONGO_URI).connect()).db('bot');
    return db;
}

function parseInit2(buf) {
    return {
        initPcAmount: buf.readBigUInt64LE(10).toString(),
        initCoinAmount: buf.readBigUInt64LE(18).toString()
    };
}

/* ── Helper Functions ─────────────────────────────────────────*/
function getAssociatedTokenAddress(owner, mint) {
    return PublicKey.findProgramAddressSync(
        [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
}

/* ── MAIN ─────────────────────────────────────────────────────*/
async function processRaydiumLpTransaction(conn, sig) {
    if (!process.env.USER_SOLANA_ADDRESS) {
        throw new Error('USER_SOLANA_ADDRESS not found in .env');
    }
    const USER_ADDRESS = new PublicKey(process.env.USER_SOLANA_ADDRESS);

    const tx = await conn.getTransaction(sig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
    });
    if (!tx) return null;

    const msg = tx.transaction.message;
    const accounts = (msg.staticAccountKeys ?? msg.accountKeys).map(k => k.toString());
    const ixs = msg.compiledInstructions || msg.instructions;

    for (const ix of ixs) {
        if (accounts[ix.programIdIndex] !== RAYDIUM_AMM.toString()) continue;

        const idx = ix.accounts || ix.accountKeyIndexes;
        const params = parseInit2(Buffer.from(ix.data, 'base64'));

        /* variant‑aware account mapping */
        const ammId = accounts[idx[4]];
        const lpMint = accounts[idx[7]];
        let authority = accounts[idx[5]];
        let openOrders = accounts[idx[6]];
        if (authority === 'SysvarC1ock11111111111111111111111111111111') {
            authority = accounts[idx[6]];
            openOrders = accounts[idx[7]];
        }

        /* pair fields */
        let baseMint = accounts[idx[8]];
        let quoteMint = accounts[idx[9]];
        let baseVault = accounts[idx[10]];
        let quoteVault = accounts[idx[11]];
        let initBase = params.initCoinAmount;  // coin side
        let initQuote = params.initPcAmount;    // pc   side

        /* flip if WSOL was coin side */
        if (baseMint === WSOL_MINT) {
            [baseMint, quoteMint] = [quoteMint, baseMint];
            [baseVault, quoteVault] = [quoteVault, baseVault];
            [initBase, initQuote] = [initQuote, initBase];
        }

        const td = {
            programId: RAYDIUM_AMM.toString(),
            ammId, lpMint,
            ammAuthority: authority,
            ammOpenOrders: openOrders,
            baseMint, quoteMint,
            baseVault, quoteVault,
            targetOrders: accounts[idx[13]],
            marketProgramId: accounts[idx[15]],
            marketId: accounts[idx[16]],
            marketBaseVault: accounts[idx[18]],
            marketQuoteVault: accounts[idx[19]],
            marketAuthority: accounts[idx[20]],
            initPcAmount: initQuote,
            initCoinAmount: initBase,
            fee: '0.003',
            version: 'V2',
            marketVersion: 'V2'
        };

        /* pool account fields */
        const poolAcc = await conn.getAccountInfo(new PublicKey(ammId));
        if (!poolAcc) return null;
        const poolData = liquidityStateV4Layout.decode(poolAcc.data);
        Object.assign(td, {
            withdrawQueue: new PublicKey(poolData.withdrawQueue).toString(),
            lpVault: new PublicKey(poolData.lpVault).toString(),
            lpDecimals: poolData.lpDecimals !== undefined
                ? Number(poolData.lpDecimals)
                : (await conn.getTokenSupply(new PublicKey(lpMint))).value.decimals,
            nonce: Number(poolData.nonce),
            openTime: poolData.poolOpenTime
                ? poolData.poolOpenTime.toString()
                : poolData.openTime?.toString()
        });

        /* serum side‑accounts */
        const mAcc = await conn.getAccountInfo(new PublicKey(td.marketId));
        if (!mAcc || mAcc.data.length < 341) return null;
        const d = mAcc.data;
        Object.assign(td, {
            marketEventQueue: new PublicKey(d.subarray(245, 277)).toString(),
            marketBids: new PublicKey(d.subarray(277, 309)).toString(),
            marketAsks: new PublicKey(d.subarray(309, 341)).toString()
        });

        /* true decimals */
        const [baseDec, quoteDec] = await Promise.all([
            conn.getTokenSupply(new PublicKey(baseMint)),
            conn.getTokenSupply(new PublicKey(quoteMint))
        ]);
        td.baseDecimals = baseDec.value.decimals;
        td.quoteDecimals = quoteDec.value.decimals;

        /* -------- human‑unit constant product ------------- */
        const Khuman = (
            BigInt(initQuote) * BigInt(initBase)
        ) / (10n ** BigInt(td.quoteDecimals + td.baseDecimals));
        td.K = Khuman.toString();

        /* launch price V in SOL */
        td.V = (
            (Number(initQuote) / 10 ** td.quoteDecimals) /
            (Number(initBase) / 10 ** td.baseDecimals)
        ).toString();

        td.isWSOLSwap = td.quoteMint === WSOL_MINT;
        if (td.isWSOLSwap) td.wrappedSOLAmount = initQuote;

        /* ─── ADDED FOR SWAP SUPPORT ──────────────────────── */
        // Token program ID (constant)
        td.tokenProgramId = TOKEN_PROGRAM_ID.toString();

        // Vault owner PDA
        const [vaultOwner] = PublicKey.findProgramAddressSync(
            [new PublicKey(td.marketId).toBuffer()],
            new PublicKey(td.marketProgramId)
        );
        td.vaultOwner = vaultOwner.toString();

        // User token accounts
        td.userBaseTokenAccount = getAssociatedTokenAddress(
            USER_ADDRESS,
            new PublicKey(td.baseMint)
        ).toString();

        td.userQuoteTokenAccount = getAssociatedTokenAddress(
            USER_ADDRESS,
            new PublicKey(td.quoteMint)
        ).toString();

        // User SOL address from .env
        td.userSolAddress = USER_ADDRESS.toString();

        /* ────────────────────────────────────────────────── */

        const { insertedId } = await (await connectDB())
            .collection('raydium_lp_transactionsV3')
            .insertOne(td);

        return { ...td, tokenId: insertedId };
    }
    return null;
}

module.exports = {
    connectToDatabase: connectDB,
    processRaydiumLpTransaction
};
