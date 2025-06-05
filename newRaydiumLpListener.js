require("dotenv").config();
const { Connection, PublicKey } = require("@solana/web3.js");
const {
    processRaydiumLpTransaction,
    connectToDatabase,
} = require("./newRaydiumLpService");
const SniperManager = require("./SniperManager");

// ──────────────────────────────────────────────────────────
// Network & program IDs
const WS_URL =
    process.env.SOLANA_WS_URL || "https://api.mainnet-beta.solana.com/";
const connection = new Connection(WS_URL, "confirmed");

const RAYDIUM_AMM_PROGRAM_ID = new PublicKey(
    process.env.RAYDIUM_AMM_PROGRAM_ID
);

// (lower‑case “bkb” ‑‑ intentional)
const JUPITER_AMM_ADDRESS =
    "JUP6bkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

// ──────────────────────────────────────────────────────────
// Handle a single log entry
async function handleLog(log) {
    // Filter for pool‑creation instructions
    if (
        !log.logs.some(
            (l) => l.includes("InitializeInstruction2") || l.includes("CreatePool")
        )
    )
        return;

    const signature = log.signature;

    try {
        /* ——— Skip Jupiter pools ——— */
        const tx = await connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });
        if (tx) {
            const msg = tx.transaction.message;
            const accounts = (msg.staticAccountKeys ?? msg.accountKeys).map((k) =>
                k.toString()
            );
            if (accounts.includes(JUPITER_AMM_ADDRESS)) {
                console.log("Transaction involves Jupiter AMM, skipping.");
                return;
            }
        }

        console.log("New AMM LP transaction found!");

        /* ——— Decode and persist ——— */
        const tokenData = await processRaydiumLpTransaction(connection, signature);
        if (!tokenData) return;

        /* ——— One‑hop hand‑off to the Sniper ——— */
        console.log(
            `Launching sniper for token ${tokenData.baseMint} (buyAmount = ${process
                .env.BUY_AMOUNT || 1})`
        );
        await SniperManager.addSniper(tokenData);
    } catch (err) {
        console.error("Error processing log:", err.message);
    }
}

// ──────────────────────────────────────────────────────────
// Subscribe once DB is ready
function subscribeRaydium() {
    console.log("Listening for new Raydium LP transactions…");
    connection.onLogs(RAYDIUM_AMM_PROGRAM_ID, handleLog, "confirmed");
}

(async () => {
    await connectToDatabase(); // still needed for writes
    subscribeRaydium();
})();
