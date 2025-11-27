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
        this.dripAmount = parseInt(process.env.DRIP_AMOUNT) || 1000000000; // 1 SOL in lamports
        this.cooldownHours = parseInt(process.env.COOLDOWN_HOURS) || 1;
        this.cooldownMs = this.cooldownHours * 60 * 60 * 1000;

        // User data storage
        this.userCooldowns = new Map();
        this.userBalances = new Map(); // Track individual user balances
        this.userTasks = new Map(); // Track completed tasks per user

        // Tasks storage
        this.tasks = new Map();

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

    getUserBalance(userId) {
        return this.userBalances.get(userId) || 0;
    }

    addToUserBalance(userId, amount) {
        const currentBalance = this.getUserBalance(userId);
        this.userBalances.set(userId, currentBalance + amount);
        return this.getUserBalance(userId);
    }

    resetUserBalance(userId) {
        this.userBalances.set(userId, 0);
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

    hasCompletedTask(userId, taskId) {
        const userTaskData = this.userTasks.get(userId) || new Set();
        return userTaskData.has(taskId);
    }

    markTaskCompleted(userId, taskId) {
        if (!this.userTasks.has(userId)) {
            this.userTasks.set(userId, new Set());
        }
        this.userTasks.get(userId).add(taskId);
    }

    async sendSol(toAddress, amountLamports = this.dripAmount) {
        try {
            const recipientPubkey = new PublicKey(toAddress);
            const transaction = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: this.faucetKeypair.publicKey,
                    toPubkey: recipientPubkey,
                    lamports: amountLamports
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
                    ],
                    [
                        { text: '👤 My Balance', callback_data: 'my_balance' }
                    ]
                ]
            }
        };
    }

    async sendWelcomeMessage(chatId, userId, username) {
        try {
            const faucetBalance = await this.checkFaucetBalance();
            const userBalance = this.getUserBalance(userId);
            const tasksCount = this.tasks.size;

            const welcomeMessage = `🎉 *Welcome ${username}!*\n\n💎 *Your Balance:* ${userBalance.toFixed(2)} SOL\n💰 *Faucet Balance:* ${faucetBalance.toFixed(2)} SOL\n📋 *Tasks Available:* ${tasksCount}`;

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
                    const userBalance = this.getUserBalance(userId);
                    const faucetBalance = await this.checkFaucetBalance();
                    await this.bot.sendMessage(chatId, 
                        `👤 *Your Balance:* ${userBalance.toFixed(2)} SOL\n💰 *Faucet Balance:* ${faucetBalance.toFixed(2)} SOL`, 
                        { parse_mode: 'Markdown' }
                    );
                } catch (error) {
                    await this.bot.sendMessage(chatId, '❌ Error checking balance');
                }
            }
            else if (text.startsWith('/claim')) {
                await this.handleFaucetRequest(msg);
            }
            else if (text === '/admin_upload' && this.adminIds.includes(userId)) {
                await this.bot.sendMessage(chatId, '📤 Send task in format: /add_task <task_name> <reward_amount>');
            }
            else if (text.startsWith('/add_task') && this.adminIds.includes(userId)) {
                await this.handleAddTask(msg);
            }
            else if (text.startsWith('/complete_task') && this.adminIds.includes(userId)) {
                await this.handleCompleteTask(msg);
            }
            else if (text === '/help') {
                const helpMessage = `💡 Commands:\n/start - Welcome message\n/balance - Check your balance\n/claim <address> - Claim your SOL\n/help - Show this help`;
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
            } else if (query.data === 'my_balance') {
                await this.handleMyBalance(chatId, userId);
            }

            await this.bot.answerCallbackQuery(query.id);
        });
    }

    async handleMyBalance(chatId, userId) {
        try {
            const userBalance = this.getUserBalance(userId);
            await this.bot.sendMessage(chatId, 
                `👤 *Your Balance:* ${userBalance.toFixed(2)} SOL\n\nComplete tasks to earn more SOL!`, 
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('Error showing balance:', error);
            await this.bot.sendMessage(chatId, '❌ Error loading your balance');
        }
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
                const completed = this.hasCompletedTask(userId, taskId) ? '✅' : '⭕';
                tasksMessage += `${taskIndex}. ${completed} *${task.name}* - ${task.reward} SOL\n`;
                taskIndex++;
            });

            const userBalance = this.getUserBalance(userId);
            tasksMessage += `\n💰 *Your Balance:* ${userBalance.toFixed(2)} SOL`;

            await this.bot.sendMessage(chatId, tasksMessage, { 
                parse_mode: 'Markdown',
                ...this.getMainMenu()
            });
        } catch (error) {
            console.error('Error viewing tasks:', error);
            await this.bot.sendMessage(chatId, '❌ Error loading tasks');
        }
    }

    async handleClaimRequest(chatId, userId, username) {
        try {
            const userBalance = this.getUserBalance(userId);
            
            if (userBalance <= 0) {
                await this.bot.sendMessage(chatId, 
                    `❌ You have no SOL to claim!\n\nComplete tasks first to earn SOL.`,
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            await this.bot.sendMessage(chatId, 
                `💰 *Your Balance:* ${userBalance.toFixed(2)} SOL\n\n📨 Send your Solana wallet address to claim:\n\n/claim <your_wallet_address>`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('Error in claim request:', error);
            await this.bot.sendMessage(chatId, '❌ Error processing claim request');
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

        const userBalance = this.getUserBalance(userId);
        if (userBalance <= 0) {
            await this.bot.sendMessage(chatId, '❌ You have no SOL to claim! Complete tasks first.');
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
            const claimAmount = userBalance;
            
            if (faucetBalance < claimAmount) {
                await this.bot.sendMessage(chatId, `❌ Faucet low on balance: ${faucetBalance.toFixed(2)} SOL`);
                return;
            }

            const sendingMsg = await this.bot.sendMessage(chatId, `⏳ Sending ${claimAmount.toFixed(2)} SOL...`);
            
            // Convert SOL to lamports
            const lamportsToSend = Math.floor(claimAmount * LAMPORTS_PER_SOL);
            const txSignature = await this.sendSol(address, lamportsToSend);
            
            // Reset user balance after successful claim
            this.resetUserBalance(userId);
            this.updateCooldown(userId);

            const explorerUrl = `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`;
            const successMessage = `✅ Sent ${claimAmount.toFixed(2)} SOL to \`${address}\`\n[View Transaction](${explorerUrl})`;

            await this.bot.editMessageText(successMessage, {
                chat_id: chatId,
                message_id: sendingMsg.message_id,
                parse_mode: 'Markdown'
            });

            console.log(`✅ Sent ${claimAmount.toFixed(2)} SOL to ${address} for ${username}`);
        } catch (error) {
            console.error(`Error for ${username}:`, error);
            await this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
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

            const taskName = parts.slice(1, -1).join(' ');
            const rewardAmount = parseFloat(parts[parts.length - 1]);

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

    async handleCompleteTask(msg) {
        try {
            const chatId = msg.chat.id;
            const text = msg.text;
            const parts = text.split(' ');

            if (parts.length < 3) {
                await this.bot.sendMessage(chatId, '❌ Format: /complete_task <user_id> <task_id>');
                return;
            }

            const userId = parseInt(parts[1]);
            const taskId = parts[2];

            if (!this.tasks.has(taskId)) {
                await this.bot.sendMessage(chatId, '❌ Task not found');
                return;
            }

            if (this.hasCompletedTask(userId, taskId)) {
                await this.bot.sendMessage(chatId, '❌ User already completed this task');
                return;
            }

            const task = this.tasks.get(taskId);
            this.markTaskCompleted(userId, taskId);
            const newBalance = this.addToUserBalance(userId, task.reward);

            await this.bot.sendMessage(chatId, 
                `✅ Task completed!\n\nUser ${userId} earned *${task.reward} SOL*\nNew balance: *${newBalance.toFixed(2)} SOL*`, 
                { parse_mode: 'Markdown' }
            );

            // Notify the user if they're in a chat with the bot
            try {
                await this.bot.sendMessage(userId, 
                    `🎉 Task Completed!\n\nYou earned *${task.reward} SOL* for completing "${task.name}"!\nYour balance: *${newBalance.toFixed(2)} SOL*`, 
                    { parse_mode: 'Markdown' }
                );
            } catch (error) {
                console.log('Could not notify user, they may not have started chat with bot');
            }

        } catch (error) {
            console.error('Error completing task:', error);
            await this.bot.sendMessage(chatId, '❌ Error completing task');
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