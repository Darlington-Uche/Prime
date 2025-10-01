const TelegramBot = require('node-telegram-bot-api');
const { Connection, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const express = require('express');
require('dotenv').config();

const app = express();
app.use(express.json());

class SolanaFaucetBot {
    constructor() {
        // Initialize Solana connection
        this.connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
        
        // Initialize faucet wallet
        const privateKeyBytes = Buffer.from(bs58.decode(process.env.FAUCET_PRIVATE_KEY));
        this.faucetKeypair = Keypair.fromSecretKey(privateKeyBytes);
        
        // Configuration
        this.dripAmount = parseInt(process.env.DRIP_AMOUNT) || 1000000000;
        this.cooldownHours = parseInt(process.env.COOLDOWN_HOURS) || 1;
        this.cooldownMs = this.cooldownHours * 60 * 60 * 1000;
        
        // User cooldown tracking
        this.userCooldowns = new Map();
        
        // Initialize bot for webhook
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
        this.bot.setWebHook(`${process.env.RENDER_URL}/bot${process.env.TELEGRAM_BOT_TOKEN}`);
        
        console.log(`🤖 Solana Faucet Bot Started`);
        console.log(`💰 Faucet address: ${this.faucetKeypair.publicKey.toString()}`);
        this.checkFaucetBalance();
    }

    async checkFaucetBalance() {
        try {
            const balance = await this.connection.getBalance(this.faucetKeypair.publicKey);
            const balanceSOL = balance / LAMPORTS_PER_SOL;
            console.log(`💰 Faucet balance: ${balanceSOL} SOL`);
            return balanceSOL;
        } catch (error) {
            console.error('Error checking balance:', error);
            return 0;
        }
    }

    isInCooldown(userId) {
        if (!this.userCooldowns.has(userId)) return false;
        const lastRequest = this.userCooldowns.get(userId);
        return (Date.now() - lastRequest) < this.cooldownMs;
    }

    getCooldownRemaining(userId) {
        if (!this.userCooldowns.has(userId)) return 0;
        const lastRequest = this.userCooldowns.get(userId);
        const remaining = Math.ceil((this.cooldownMs - (Date.now() - lastRequest)) / (60 * 1000));
        return Math.max(0, remaining);
    }

    updateCooldown(userId) {
        this.userCooldowns.set(userId, Date.now());
    }

    async sendSol(toAddress) {
        try {
            const recipientPubkey = new PublicKey(toAddress);
            const transaction = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: this.faucetKeypair.publicKey,
                    toPubkey: recipientPubkey,
                    lamports: this.dripAmount
                })
            );

            const { blockhash } = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = this.faucetKeypair.publicKey;

            const signature = await sendAndConfirmTransaction(
                this.connection,
                transaction,
                [this.faucetKeypair]
            );

            return signature;
        } catch (error) {
            console.error('Error sending SOL:', error);
            throw error;
        }
    }

    isValidSolanaAddress(address) {
        try {
            new PublicKey(address);
            return true;
        } catch {
            return false;
        }
    }

    initializeBotHandlers() {
        this.bot.on('message', async (msg) => {
            const chatId = msg.chat.id;
            const text = msg.text;
            const userId = msg.from.id;

            if (text === '/start') {
                const welcomeMessage = `🤖 *Solana Faucet Bot*\n\nUse /faucet <address> to get testnet SOL`;
                await this.bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
            }
            else if (text === '/balance') {
                try {
                    const balance = await this.checkFaucetBalance();
                    await this.bot.sendMessage(chatId, `💰 Balance: *${balance} SOL*`, { parse_mode: 'Markdown' });
                } catch (error) {
                    await this.bot.sendMessage(chatId, '❌ Error checking balance');
                }
            }
            else if (text.startsWith('/faucet')) {
                await this.handleFaucetRequest(msg);
            }
            else if (text === '/help') {
                const helpMessage = `💡 Send /faucet <your_wallet_address> to receive testnet SOL`;
                await this.bot.sendMessage(chatId, helpMessage);
            }
        });
    }

    async handleFaucetRequest(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const text = msg.text;
        const username = msg.from.username || `user_${userId}`;

        const address = text.split(' ')[1];
        if (!address) {
            await this.bot.sendMessage(chatId, '❌ Please provide wallet address: /faucet <address>');
            return;
        }

        if (this.isInCooldown(userId)) {
            const remaining = this.getCooldownRemaining(userId);
            await this.bot.sendMessage(chatId, `⏳ Wait ${remaining} minutes`);
            return;
        }

        if (!this.isValidSolanaAddress(address)) {
            await this.bot.sendMessage(chatId, '❌ Invalid address');
            return;
        }

        try {
            const faucetBalance = await this.checkFaucetBalance();
            if (faucetBalance < 1) {
                await this.bot.sendMessage(chatId, `❌ Low balance: ${faucetBalance} SOL`);
                return;
            }

            const sendingMsg = await this.bot.sendMessage(chatId, '⏳ Sending SOL...');
            const txSignature = await this.sendSol(address);
            this.updateCooldown(userId);

            const explorerUrl = `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`;
            const successMessage = `✅ Sent 1 SOL to \`${address}\`\n[View TX](${explorerUrl})`;
            
            await this.bot.editMessageText(successMessage, {
                chat_id: chatId,
                message_id: sendingMsg.message_id,
                parse_mode: 'Markdown'
            });

            console.log(`✅ Sent 1 SOL to ${address} for ${username}`);
        } catch (error) {
            console.error(`Error for ${username}:`, error);
            await this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
        }
    }
}

// Initialize bot
const faucetBot = new SolanaFaucetBot();
faucetBot.initializeBotHandlers();

// Webhook route
app.post(`/bot${process.env.TELEGRAM_BOT_TOKEN}`, (req, res) => {
    faucetBot.bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Health check route
app.get('/', (req, res) => {
    res.json({ status: 'Solana Faucet Bot is running!' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});