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
        
        // Tasks storage
        this.tasks = new Map();
        this.userTasks = new Map();
        
        // Admin IDs
        this.adminIds = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim()));
         
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

    getMainMenu() {
        return {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📋 Tasks', callback_data: 'view_tasks' },
                        { text: '💰 Claim', callback_data: 'claim_sol' }
                    ]
                ]
            }
        };
    }

    async sendWelcomeMessage(chatId, userId, username) {
        try {
            const balance = await this.checkFaucetBalance();
            const tasksCount = this.tasks.size;
            
            const welcomeMessage = `🎉 *Welcome ${username}!*\n\n💰 *Balance:* ${balance.toFixed(2)} SOL\n📋 *Tasks Available:* ${tasksCount}`;
            
            await this.bot.sendMessage(chatId, welcomeMessage, {
                parse_mode: 'Markdown',
                ...this.getMainMenu()
            });
        } catch (error) {
            console.error('Error sending welcome message:', error);
        }
    }

    initializeBotHandlers() {
        this.bot.on('message', async (msg) => {
            const chatId = msg.chat.id;
            const text = msg.text;
            const userId = msg.from.id;
            const username = msg.from.username || msg.from.first_name || `user_${userId}`;

            if (text === '/start') {
                await this.sendWelcomeMessage(chatId, userId, username);
            }
            else if (text === '/balance') {
                try {
                    const balance = await this.checkFaucetBalance();
                    await this.bot.sendMessage(chatId, `💰 Balance: *${balance.toFixed(2)} SOL*`, { parse_mode: 'Markdown' });
                } catch (error) {
                    await this.bot.sendMessage(chatId, '❌ Error checking balance');
                }
            }
            else if (text === '/admin_upload' && this.adminIds.includes(userId)) {
                await this.bot.sendMessage(chatId, '📤 Send task in format: /add_task <task_name> <reward_amount>');
            }
            else if (text.startsWith('/add_task') && this.adminIds.includes(userId)) {
                await this.handleAddTask(msg);
            }
            else if (text === '/help') {
                const helpMessage = `💡 Commands:\n/start - Welcome message\n/balance - Check faucet balance\n/help - Show this help`;
                await this.bot.sendMessage(chatId, helpMessage);
            }
        });

        // Handle callback queries (button clicks)
        this.bot.on('callback_query', async (query) => {
            const chatId = query.message.chat.id;
            const userId = query.from.id;
            const username = query.from.username || query.from.first_name || `user_${userId}`;

            if (query.data === 'view_tasks') {
                await this.handleViewTasks(chatId, userId);
            } else if (query.data === 'claim_sol') {
                await this.handleClaimRequest(chatId, userId, username);
            }

            await this.bot.answerCallbackQuery(query.id);
        });
    }

    async handleViewTasks(chatId, userId) {
        try {
            if (this.tasks.size === 0) {
                await this.bot.sendMessage(chatId, '📋 No tasks available at the moment.');
                return;
            }

            let tasksMessage = '📋 *Available Tasks:*\n\n';
            let taskIndex = 1;
            
            this.tasks.forEach((task, taskId) => {
                tasksMessage += `${taskIndex}. *${task.name}* - ${task.reward} SOL\n`;
                taskIndex++;
            });

            await this.bot.sendMessage(chatId, tasksMessage, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Error viewing tasks:', error);
            await this.bot.sendMessage(chatId, '❌ Error loading tasks');
        }
    }

    async handleClaimRequest(chatId, userId, username) {
        try {
            await this.bot.sendMessage(chatId, '📨 Please send your Solana wallet address to claim SOL:\n\n/claim <address>');
        } catch (error) {
            console.error('Error in claim request:', error);
        }
    }

    async handleAddTask(msg) {
        try {
            const chatId = msg.chat.id;
            const text = msg.text;
            const parts = text.split(' ');

            if (parts.length < 3) {
                await this.bot.sendMessage(chatId, '❌ Format: /add_task <task_name> <reward_amount>');
                return;
            }

            const taskName = parts[1];
            const rewardAmount = parseFloat(parts[2]);

            if (isNaN(rewardAmount)) {
                await this.bot.sendMessage(chatId, '❌ Reward amount must be a number');
                return;
            }

            const taskId = `task_${Date.now()}`;
            this.tasks.set(taskId, { name: taskName, reward: rewardAmount });

            await this.bot.sendMessage(chatId, `✅ Task "*${taskName}*" added with reward *${rewardAmount} SOL*`, { parse_mode: 'Markdown' });
            console.log(`📋 New task added: ${taskName}`);
        } catch (error) {
            console.error('Error adding task:', error);
            await this.bot.sendMessage(chatId, '❌ Error adding task');
        }
    }

    async handleFaucetRequest(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const text = msg.text;
        const username = msg.from.username || `user_${userId}`;

        const address = text.split(' ')[1];
        if (!address) {
            await this.bot.sendMessage(chatId, '❌ Please provide wallet address: /claim <address>');
            return;
        }

        if (this.isInCooldown(userId)) {
            const remaining = this.getCooldownRemaining(userId);
            await this.bot.sendMessage(chatId, `⏳ Wait ${remaining} minutes before claiming again`);
            return;
        }

        if (!this.isValidSolanaAddress(address)) {
            await this.bot.sendMessage(chatId, '❌ Invalid Solana address');
            return;
        }

        try {
            const faucetBalance = await this.checkFaucetBalance();
            if (faucetBalance < 1) {
                await this.bot.sendMessage(chatId, `❌ Low balance: ${faucetBalance.toFixed(2)} SOL`);
                return;
            }

            const sendingMsg = await this.bot.sendMessage(chatId, '⏳ Sending SOL...');
            const txSignature = await this.sendSol(address);
            this.updateCooldown(userId);

            const explorerUrl = `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`;
            const successMessage = `✅ Sent 5 SOL to \`${address}\`\n[View Transaction](${explorerUrl})`;
            
            await this.bot.editMessageText(successMessage, {
                chat_id: chatId,
                message_id: sendingMsg.message_id,
                parse_mode: 'Markdown'
            });

            console.log(`✅ Sent 5 SOL to ${address} for ${username}`);
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