const TelegramBot = require('node-telegram-bot-api');
const { Connection, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const express = require('express');
const admin = require('firebase-admin');
require('dotenv').config();

// Firebase initialization
const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
  universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

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

        // Collections
        this.usersCollection = db.collection('users');
        this.tasksCollection = db.collection('tasks');
        this.userTasksCollection = db.collection('userTasks');

        // In-memory cache for performance
        this.userBalances = new Map();
        this.userCooldowns = new Map();
        this.tasks = new Map();

        // Admin IDs
        this.adminIds = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim()));

        // Initialize bot for webhook
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
        this.bot.setWebHook(`${process.env.RENDER_URL}/bot${process.env.TELEGRAM_BOT_TOKEN}`);

        console.log(`🤖 Solana Faucet Bot Started`);
        console.log(`💰 Faucet address: ${this.faucetKeypair.publicKey.toString()}`);
        
        // Load initial data
        this.loadTasks();
        this.checkFaucetBalance();
    }

    async loadTasks() {
        try {
            const snapshot = await this.tasksCollection.get();
            this.tasks.clear();
            snapshot.forEach(doc => {
                this.tasks.set(doc.id, doc.data());
            });
            console.log(`📋 Loaded ${this.tasks.size} tasks from Firebase`);
        } catch (error) {
            console.error('Error loading tasks:', error);
        }
    }

    async loadUserData(userId) {
        try {
            const userDoc = await this.usersCollection.doc(userId.toString()).get();
            if (userDoc.exists) {
                const userData = userDoc.data();
                this.userBalances.set(userId, userData.balance || 0);
                this.userCooldowns.set(userId, userData.lastClaim || 0);
                return userData;
            } else {
                // Create new user
                const newUser = {
                    userId: userId,
                    balance: 0,
                    lastClaim: 0,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                };
                await this.usersCollection.doc(userId.toString()).set(newUser);
                this.userBalances.set(userId, 0);
                this.userCooldowns.set(userId, 0);
                return newUser;
            }
        } catch (error) {
            console.error('Error loading user data:', error);
            return { balance: 0, lastClaim: 0 };
        }
    }

    async saveUserData(userId, updateData) {
        try {
            await this.usersCollection.doc(userId.toString()).update({
                ...updateData,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // Update cache
            if (updateData.balance !== undefined) {
                this.userBalances.set(userId, updateData.balance);
            }
            if (updateData.lastClaim !== undefined) {
                this.userCooldowns.set(userId, updateData.lastClaim);
            }
        } catch (error) {
            console.error('Error saving user data:', error);
        }
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

    async getUserBalance(userId) {
        if (!this.userBalances.has(userId)) {
            await this.loadUserData(userId);
        }
        return this.userBalances.get(userId) || 0;
    }

    async addToUserBalance(userId, amount) {
        const currentBalance = await this.getUserBalance(userId);
        const newBalance = currentBalance + amount;
        await this.saveUserData(userId, { balance: newBalance });
        return newBalance;
    }

    async resetUserBalance(userId) {
        await this.saveUserData(userId, { balance: 0 });
    }

    async isInCooldown(userId) {
        if (!this.userCooldowns.has(userId)) {
            await this.loadUserData(userId);
        }
        const lastRequest = this.userCooldowns.get(userId) || 0;
        return (Date.now() - lastRequest) < this.cooldownMs;
    }

    async getCooldownRemaining(userId) {
        if (!this.userCooldowns.has(userId)) {
            await this.loadUserData(userId);
        }
        const lastRequest = this.userCooldowns.get(userId) || 0;
        const remaining = Math.ceil((this.cooldownMs - (Date.now() - lastRequest)) / (60 * 1000));
        return Math.max(0, remaining);
    }

    async updateCooldown(userId) {
        await this.saveUserData(userId, { lastClaim: Date.now() });
    }

    async hasCompletedTask(userId, taskId) {
        try {
            const userTaskDoc = await this.userTasksCollection
                .doc(`${userId}_${taskId}`)
                .get();
            return userTaskDoc.exists;
        } catch (error) {
            console.error('Error checking task completion:', error);
            return false;
        }
    }

    async markTaskCompleted(userId, taskId) {
        try {
            await this.userTasksCollection.doc(`${userId}_${taskId}`).set({
                userId: userId,
                taskId: taskId,
                completedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (error) {
            console.error('Error marking task completed:', error);
            throw error;
        }
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

    getTaskListKeyboard() {
        const tasksArray = Array.from(this.tasks.entries());
        const keyboard = [];
        
        // Create buttons for each task with emoji numbers
        tasksArray.forEach(([taskId, task], index) => {
            const emojiNumbers = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
            const emoji = emojiNumbers[index] || `${index + 1}.`;
            const buttonText = `${emoji} ${task.name} - ${task.reward} SOL`;
            keyboard.push([{ text: buttonText, callback_data: `view_task_${taskId}` }]);
        });

        // Add back button
        keyboard.push([{ text: '🔙 Back', callback_data: 'back_to_main' }]);

        return {
            reply_markup: {
                inline_keyboard: keyboard
            }
        };
    }

    getTaskDetailKeyboard(taskId, userId) {
        return {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Verify Task', callback_data: `verify_task_${taskId}` }
                    ],
                    [
                        { text: '🔙 Back to Tasks', callback_data: 'view_tasks' }
                    ]
                ]
            }
        };
    }

    async sendWelcomeMessage(chatId, userId, username) {
        try {
            const faucetBalance = await this.checkFaucetBalance();
            const userBalance = await this.getUserBalance(userId);
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

            // Ensure user data is loaded
            await this.loadUserData(userId);

            if (text === '/start') {
                await this.sendWelcomeMessage(chatId, userId, username);
            }
            else if (text === '/balance') {
                try {
                    const userBalance = await this.getUserBalance(userId);
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
                await this.bot.sendMessage(chatId, '📤 Send task in format:\n\n/add_task <link> <description> <reward_amount>\n\nExample:\n/add_task https://t.me/channel Join our Telegram channel 5');
            }
            else if (text.startsWith('/add_task') && this.adminIds.includes(userId)) {
                await this.handleAddTask(msg);
            }
            else if (text.startsWith('/complete_task') && this.adminIds.includes(userId)) {
                await this.handleCompleteTask(msg);
            }
            else if (text.startsWith('/delete_task') && this.adminIds.includes(userId)) {
                await this.handleDeleteTask(msg);
            }
            else if (text === '/stats' && this.adminIds.includes(userId)) {
                await this.handleStats(msg);
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
            const data = query.data;

            // Ensure user data is loaded
            await this.loadUserData(userId);

            if (data === 'view_tasks') {
                await this.handleViewTasks(chatId, userId);
            } else if (data === 'claim_sol') {
                await this.handleClaimRequest(chatId, userId, username);
            } else if (data === 'my_balance') {
                await this.handleMyBalance(chatId, userId);
            } else if (data === 'back_to_main') {
                await this.sendWelcomeMessage(chatId, userId, username);
            } else if (data.startsWith('view_task_')) {
                const taskId = data.replace('view_task_', '');
                await this.handleViewTaskDetail(chatId, userId, taskId);
            } else if (data.startsWith('verify_task_')) {
                const taskId = data.replace('verify_task_', '');
                await this.handleVerifyTask(chatId, userId, taskId, query.message.message_id);
            }

            await this.bot.answerCallbackQuery(query.id);
        });
    }

    async handleMyBalance(chatId, userId) {
        try {
            const userBalance = await this.getUserBalance(userId);
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
                await this.bot.sendMessage(chatId, '📋 No tasks available at the moment.', {
                    ...this.getMainMenu()
                });
                return;
            }

            let tasksMessage = '📋 *Available Tasks:*\n\n';
            const tasksArray = Array.from(this.tasks.entries());

            tasksArray.forEach(([taskId, task], index) {
                const emojiNumbers = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
                const emoji = emojiNumbers[index] || `${index + 1}.`;
                tasksMessage += `${emoji} *${task.name}* - ${task.reward} SOL\n`;
            });

            const userBalance = await this.getUserBalance(userId);
            tasksMessage += `\n💰 *Your Balance:* ${userBalance.toFixed(2)} SOL\n\nClick on any task to view details and complete it!`;

            await this.bot.sendMessage(chatId, tasksMessage, { 
                parse_mode: 'Markdown',
                ...this.getTaskListKeyboard()
            });
        } catch (error) {
            console.error('Error viewing tasks:', error);
            await this.bot.sendMessage(chatId, '❌ Error loading tasks');
        }
    }

    async handleViewTaskDetail(chatId, userId, taskId) {
        try {
            const task = this.tasks.get(taskId);
            if (!task) {
                await this.bot.sendMessage(chatId, '❌ Task not found');
                return;
            }

            const hasCompleted = await this.hasCompletedTask(userId, taskId);
            const status = hasCompleted ? '✅ COMPLETED' : '⭕ NOT COMPLETED';

            const taskMessage = `📋 *Task Details*\n\n` +
                               `🔹 *Name:* ${task.name}\n` +
                               `🔹 *Reward:* ${task.reward} SOL\n` +
                               `🔹 *Status:* ${status}\n\n` +
                               `🔗 *Link:* ${task.link}\n\n` +
                               `📝 *Description:*\n${task.description}\n\n` +
                               `Click the button below to verify and complete this task!`;

            await this.bot.sendMessage(chatId, taskMessage, {
                parse_mode: 'Markdown',
                ...this.getTaskDetailKeyboard(taskId, userId)
            });
        } catch (error) {
            console.error('Error viewing task detail:', error);
            await this.bot.sendMessage(chatId, '❌ Error loading task details');
        }
    }

    async handleVerifyTask(chatId, userId, taskId, messageId) {
        try {
            const task = this.tasks.get(taskId);
            if (!task) {
                await this.bot.sendMessage(chatId, '❌ Task not found');
                return;
            }

            // Check if already completed
            if (await this.hasCompletedTask(userId, taskId)) {
                await this.bot.sendMessage(chatId, '✅ You have already completed this task!');
                return;
            }

            // Show loading message
            const loadingMessage = await this.bot.sendMessage(chatId, 
                `⏳ Verifying task completion...\n\nPlease wait while we verify your task.\nThis may take a few seconds...`
            );

            // Simulate verification process (7 seconds)
            await new Promise(resolve => setTimeout(resolve, 7000));

            // Mark task as completed and update balance
            await this.markTaskCompleted(userId, taskId);
            const newBalance = await this.addToUserBalance(userId, task.reward);

            // Delete loading message
            await this.bot.deleteMessage(chatId, loadingMessage.message_id);

            // Send success message
            const successMessage = `🎉 *Task Completed Successfully!*\n\n` +
                                 `✅ You have completed: *${task.name}*\n` +
                                 `💰 Reward earned: *${task.reward} SOL*\n` +
                                 `💎 Your new balance: *${newBalance.toFixed(2)} SOL*\n\n` +
                                 `You can now claim your SOL or complete more tasks!`;

            await this.bot.sendMessage(chatId, successMessage, {
                parse_mode: 'Markdown',
                ...this.getMainMenu()
            });

            console.log(`✅ Task ${taskId} completed by user ${userId}`);

        } catch (error) {
            console.error('Error verifying task:', error);
            await this.bot.sendMessage(chatId, '❌ Error verifying task completion');
        }
    }

    async handleClaimRequest(chatId, userId, username) {
        try {
            const userBalance = await this.getUserBalance(userId);
            
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

        const userBalance = await this.getUserBalance(userId);
        if (userBalance <= 0) {
            await this.bot.sendMessage(chatId, '❌ You have no SOL to claim! Complete tasks first.');
            return;
        }

        if (await this.isInCooldown(userId)) {
            const remaining = await this.getCooldownRemaining(userId);
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
            await this.resetUserBalance(userId);
            await this.updateCooldown(userId);

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

            if (parts.length < 4) {
                await this.bot.sendMessage(chatId, 
                    '❌ Format: /add_task <link> <description> <reward_amount>\n\n' +
                    'Example:\n' +
                    '/add_task https://t.me/channel Join our Telegram channel 5'
                );
                return;
            }

            const link = parts[1];
            // Description is everything between link and reward
            const description = parts.slice(2, -1).join(' ');
            const rewardAmount = parseFloat(parts[parts.length - 1]);

            if (isNaN(rewardAmount)) {
                await this.bot.sendMessage(chatId, '❌ Reward amount must be a number');
                return;
            }

            if (!link.startsWith('http')) {
                await this.bot.sendMessage(chatId, '❌ Please provide a valid link starting with http/https');
                return;
            }

            const taskId = `task_${Date.now()}`;
            const taskName = description.length > 30 ? description.substring(0, 30) + '...' : description;
            
            const taskData = { 
                name: taskName,
                link: link,
                description: description,
                reward: rewardAmount,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            };

            // Save to Firebase
            await this.tasksCollection.doc(taskId).set(taskData);
            
            // Update cache
            this.tasks.set(taskId, taskData);

            await this.bot.sendMessage(chatId, 
                `✅ *New Task Added!*\n\n` +
                `🔹 *Name:* ${taskName}\n` +
                `🔹 *Reward:* ${rewardAmount} SOL\n` +
                `🔹 *Link:* ${link}\n` +
                `🔹 *Description:* ${description}`,
                { parse_mode: 'Markdown' }
            );
            
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

            if (await this.hasCompletedTask(userId, taskId)) {
                await this.bot.sendMessage(chatId, '❌ User already completed this task');
                return;
            }

            const task = this.tasks.get(taskId);
            
            // Mark task as completed and update balance
            await this.markTaskCompleted(userId, taskId);
            const newBalance = await this.addToUserBalance(userId, task.reward);

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

    async handleDeleteTask(msg) {
        try {
            const chatId = msg.chat.id;
            const text = msg.text;
            const parts = text.split(' ');

            if (parts.length < 2) {
                await this.bot.sendMessage(chatId, '❌ Format: /delete_task <task_id>');
                return;
            }

            const taskId = parts[1];
            
            if (!this.tasks.has(taskId)) {
                await this.bot.sendMessage(chatId, '❌ Task not found');
                return;
            }

            // Delete from Firebase
            await this.tasksCollection.doc(taskId).delete();
            
            // Update cache
            this.tasks.delete(taskId);

            await this.bot.sendMessage(chatId, `✅ Task deleted successfully`);
            console.log(`🗑️ Task deleted: ${taskId}`);
        } catch (error) {
            console.error('Error deleting task:', error);
            await this.bot.sendMessage(chatId, '❌ Error deleting task');
        }
    }

    async handleStats(msg) {
        try {
            const chatId = msg.chat.id;
            
            // Get user count
            const usersSnapshot = await this.usersCollection.get();
            const userCount = usersSnapshot.size;
            
            // Get total SOL distributed
            let totalDistributed = 0;
            usersSnapshot.forEach(doc => {
                totalDistributed += doc.data().balance || 0;
            });

            const faucetBalance = await this.checkFaucetBalance();
            const tasksCount = this.tasks.size;

            const statsMessage = `📊 *Bot Statistics*\n\n👥 Total Users: ${userCount}\n💰 Total SOL Distributed: ${totalDistributed.toFixed(2)}\n📋 Active Tasks: ${tasksCount}\n🏦 Faucet Balance: ${faucetBalance.toFixed(2)} SOL`;

            await this.bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Error getting stats:', error);
            await this.bot.sendMessage(chatId, '❌ Error getting statistics');
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

module.exports = db;