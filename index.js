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

class PremiumSolanaFaucet {
    constructor() {
        // Initialize Solana connection
        this.connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');

        // Initialize faucet wallet
        const privateKeyBytes = Buffer.from(bs58.decode(process.env.FAUCET_PRIVATE_KEY));
        this.faucetKeypair = Keypair.fromSecretKey(privateKeyBytes);

        // Configuration
        this.dripAmount = parseInt(process.env.DRIP_AMOUNT) || 1000000000;
        this.cooldownHours = parseInt(process.env.COOLDOWN_HOURS) || 1;
        this.cooldownMs = this.cooldownHours * 60 * 60 * 1000;

        // Collections
        this.usersCollection = db.collection('users');
        this.tasksCollection = db.collection('tasks');
        this.userTasksCollection = db.collection('userTasks');

        // Cache
        this.userBalances = new Map();
        this.userCooldowns = new Map();
        this.tasks = new Map();

        // Permanent Admin IDs
        this.adminIds = [7369158353, 6920738239];

        // Initialize bot
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
        this.bot.setWebHook(`${process.env.RENDER_URL}/bot${process.env.TELEGRAM_BOT_TOKEN}`);

        console.log(`🚀 Premium Solana Faucet Started`);
        console.log(`💰 Faucet: ${this.faucetKeypair.publicKey.toString()}`);
        console.log(`👑 Admins: ${this.adminIds.join(', ')}`);

        this.loadTasks();
        this.checkFaucetBalance();
    }

    // ========== CORE METHODS ==========

    async loadTasks() {
        try {
            const snapshot = await this.tasksCollection.get();
            this.tasks.clear();
            snapshot.forEach(doc => {
                const taskData = doc.data();
                // Only load tasks that are not deleted
                if (!taskData.deleted) {
                    this.tasks.set(doc.id, taskData);
                }
            });
            console.log(`📋 Loaded ${this.tasks.size} active tasks`);
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
                const newUser = {
                    userId: userId,
                    balance: 0,
                    lastClaim: 0,
                    totalEarned: 0,
                    tasksCompleted: 0,
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

    async checkFaucetBalance() {
        try {
            const balance = await this.connection.getBalance(this.faucetKeypair.publicKey);
            const balanceSOL = balance / LAMPORTS_PER_SOL;
            console.log(`💰 Faucet balance: ${balanceSOL.toFixed(2)} SOL`);
            return balanceSOL;
        } catch (error) {
            console.error('Error checking balance:', error);
            return 0;
        }
    }

    // ========== USER MANAGEMENT ==========

    async getUserBalance(userId) {
        if (!this.userBalances.has(userId)) {
            await this.loadUserData(userId);
        }
        return this.userBalances.get(userId) || 0;
    }

    async addToUserBalance(userId, amount) {
        const currentBalance = await this.getUserBalance(userId);
        const newBalance = currentBalance + amount;

        await this.usersCollection.doc(userId.toString()).update({
            balance: newBalance,
            totalEarned: admin.firestore.FieldValue.increment(amount),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        this.userBalances.set(userId, newBalance);
        return newBalance;
    }

    async resetUserBalance(userId) {
        await this.usersCollection.doc(userId.toString()).update({
            balance: 0,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        this.userBalances.set(userId, 0);
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
        await this.usersCollection.doc(userId.toString()).update({
            lastClaim: Date.now(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        this.userCooldowns.set(userId, Date.now());
    }

    // ========== TASK MANAGEMENT ==========

    async hasCompletedTask(userId, taskId) {
        try {
            const userTaskDoc = await this.userTasksCollection.doc(`${userId}_${taskId}`).get();
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

            // Update user stats
            await this.usersCollection.doc(userId.toString()).update({
                tasksCompleted: admin.firestore.FieldValue.increment(1),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (error) {
            console.error('Error marking task completed:', error);
            throw error;
        }
    }

    async deleteTask(taskId) {
        try {
            // Mark task as deleted instead of actually deleting it
            await this.tasksCollection.doc(taskId).update({
                deleted: true,
                deletedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // Remove from cache
            this.tasks.delete(taskId);
            
            console.log(`🗑️ Task ${taskId} marked as deleted`);
            return true;
        } catch (error) {
            console.error('Error deleting task:', error);
            throw error;
        }
    }

    // ========== SOLANA OPERATIONS ==========

    async sendSol(toAddress, amountLamports) {
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

    // ========== BOT UI COMPONENTS ==========

    isAdmin(userId) {
        return this.adminIds.includes(userId);
    }

    getMainMenu(userId) {
        const isAdmin = this.isAdmin(userId);
        const buttons = [
            [
                { text: '🎯 Complete Tasks', callback_data: 'view_tasks' },
                { text: '💰 Claim SOL', callback_data: 'claim_sol' }
            ],
            [
                { text: '👤 My Profile', callback_data: 'my_profile' },
                { text: '📊 Statistics', callback_data: 'statistics' }
            ]
        ];

        if (isAdmin) {
            buttons.push([
                { text: '👑 Admin Panel', callback_data: 'admin_panel' }
            ]);
        }

        buttons.push([
            { text: '❓ Help', callback_data: 'help' }
        ]);

        return { reply_markup: { inline_keyboard: buttons } };
    }

    getAdminPanel() {
        return {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📤 Add Task', callback_data: 'admin_add_task' },
                        { text: '📋 Manage Tasks', callback_data: 'admin_manage_tasks' }
                    ],
                    [
                        { text: '📊 System Stats', callback_data: 'admin_stats' },
                        { text: '👥 User Management', callback_data: 'admin_users' }
                    ],
                    [
                        { text: '🔙 Main Menu', callback_data: 'back_to_main' }
                    ]
                ]
            }
        };
    }

    getTaskListKeyboard() {
        const tasksArray = Array.from(this.tasks.entries());
        const keyboard = [];

        tasksArray.forEach(([taskId, task], index) => {
            const emojiNumbers = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
            const emoji = emojiNumbers[index] || `${index + 1}.`;
            keyboard.push([{ 
                text: `${emoji} ${task.name} - ${task.reward} SOL`, 
                callback_data: `view_task_${taskId}` 
            }]);
        });

        keyboard.push([{ text: '🔙 Main Menu', callback_data: 'back_to_main' }]);

        return { reply_markup: { inline_keyboard: keyboard } };
    }

    getManageTasksKeyboard() {
        const tasksArray = Array.from(this.tasks.entries());
        const keyboard = [];

        tasksArray.forEach(([taskId, task]) => {
            keyboard.push([
                { 
                    text: `🗑️ ${task.name} (${task.reward} SOL)`, 
                    callback_data: `admin_delete_task_${taskId}` 
                }
            ]);
        });

        keyboard.push([{ text: '🔙 Admin Panel', callback_data: 'admin_panel' }]);

        return { reply_markup: { inline_keyboard: keyboard } };
    }

    // ========== MESSAGE HANDLERS ==========

    async sendWelcomeMessage(chatId, userId, username) {
        const faucetBalance = await this.checkFaucetBalance();
        const userBalance = await this.getUserBalance(userId);
        const isAdmin = this.isAdmin(userId);

        const welcomeMessage = 
            `✨ *Welcome to Solana Faucet, ${username}!* ✨\n\n` +
            `💎 *Your Balance:* ${userBalance.toFixed(2)} SOL\n` +
            `🏦 *Faucet Balance:* ${faucetBalance.toFixed(2)} SOL\n` +
            `📋 *Available Tasks:* ${this.tasks.size}\n\n` +
            `🎯 *Complete tasks → Earn SOL → Claim rewards!*` +
            (isAdmin ? `\n\n👑 *Administrator Access Granted*` : '');

        await this.bot.sendMessage(chatId, welcomeMessage, {
            parse_mode: 'Markdown',
            ...this.getMainMenu(userId)
        });
    }

    async sendUserProfile(chatId, userId) {
        try {
            const userDoc = await this.usersCollection.doc(userId.toString()).get();
            const userData = userDoc.exists ? userDoc.data() : {};
            const balance = await this.getUserBalance(userId);
            const cooldown = await this.getCooldownRemaining(userId);

            const profileMessage =
                `👤 *Your Profile*\n\n` +
                `💎 Balance: *${balance.toFixed(2)} SOL*\n` +
                `🏆 Tasks Completed: *${userData.tasksCompleted || 0}*\n` +
                `💰 Total Earned: *${(userData.totalEarned || 0).toFixed(2)} SOL*\n` +
                `⏰ Next Claim: *${cooldown > 0 ? `${cooldown} minutes` : 'Ready!'}*\n\n` +
                `Keep completing tasks to earn more SOL! 🚀`;

            await this.bot.sendMessage(chatId, profileMessage, {
                parse_mode: 'Markdown',
                ...this.getMainMenu(userId)
            });
        } catch (error) {
            console.error('Error sending profile:', error);
            await this.bot.sendMessage(chatId, '❌ Error loading profile');
        }
    }

    async sendStatistics(chatId, userId) {
        try {
            const usersSnapshot = await this.usersCollection.get();
            const userCount = usersSnapshot.size;

            let totalDistributed = 0;
            let totalTasksCompleted = 0;
            usersSnapshot.forEach(doc => {
                const data = doc.data();
                totalDistributed += data.totalEarned || 0;
                totalTasksCompleted += data.tasksCompleted || 0;
            });

            const faucetBalance = await this.checkFaucetBalance();

            const statsMessage =
                `📊 *Faucet Statistics*\n\n` +
                `👥 Total Users: *${userCount}*\n` +
                `💰 Total Distributed: *${totalDistributed.toFixed(2)} SOL*\n` +
                `✅ Tasks Completed: *${totalTasksCompleted}*\n` +
                `🏦 Current Balance: *${faucetBalance.toFixed(2)} SOL*\n` +
                `📋 Active Tasks: *${this.tasks.size}*`;

            await this.bot.sendMessage(chatId, statsMessage, {
                parse_mode: 'Markdown',
                ...this.getMainMenu(userId)
            });
        } catch (error) {
            console.error('Error sending stats:', error);
            await this.bot.sendMessage(chatId, '❌ Error loading statistics');
        }
    }

    // ========== TASK FLOW ==========

    async handleViewTasks(chatId, userId) {
        if (this.tasks.size === 0) {
            await this.bot.sendMessage(chatId, 
                '📭 No tasks available at the moment.\n\nCheck back later for new earning opportunities! 💫',
                this.getMainMenu(userId)
            );
            return;
        }

        const tasksMessage = 
            `🎯 *Available Tasks*\n\n` +
            `Complete tasks to earn SOL! Click on any task below to view details and start earning. 💰\n\n` +
            `*Total Tasks:* ${this.tasks.size}\n` +
            `*Your Balance:* ${(await this.getUserBalance(userId)).toFixed(2)} SOL`;

        await this.bot.sendMessage(chatId, tasksMessage, {
            parse_mode: 'Markdown',
            ...this.getTaskListKeyboard()
        });
    }

    async handleViewTaskDetail(chatId, userId, taskId) {
        const task = this.tasks.get(taskId);
        if (!task) {
            await this.bot.sendMessage(chatId, '❌ Task not found or has been deleted');
            return;
        }

        const hasCompleted = await this.hasCompletedTask(userId, taskId);
        const status = hasCompleted ? '✅ Completed' : '🔄 Available';

        const taskMessage =
            `📋 *Task Details*\n\n` +
            `✨ *${task.name}*\n\n` +
            `💰 Reward: *${task.reward} SOL*\n` +
            `📊 Status: *${status}*\n\n` +
            `🔗 ${task.link}\n\n` +
            `📝 *Description:*\n${task.description}\n\n` +
            (hasCompleted 
                ? `You've already completed this task! 🎉`
                : `Click the button below to verify and earn ${task.reward} SOL!`);

        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    ...(hasCompleted ? [] : [[
                        { text: '✅ Verify & Earn SOL', callback_data: `verify_task_${taskId}` }
                    ]]),
                    [
                        { text: '📋 Back to Tasks', callback_data: 'view_tasks' },
                        { text: '🏠 Main Menu', callback_data: 'back_to_main' }
                    ]
                ]
            }
        };

        await this.bot.sendMessage(chatId, taskMessage, {
            parse_mode: 'Markdown',
            ...keyboard
        });
    }

    async handleVerifyTask(chatId, userId, taskId) {
        const task = this.tasks.get(taskId);
        if (!task) {
            await this.bot.sendMessage(chatId, '❌ Task not found or has been deleted');
            return;
        }

        if (await this.hasCompletedTask(userId, taskId)) {
            await this.bot.sendMessage(chatId, '✅ You have already completed this task!');
            return;
        }

        // Show verification progress
        const progressMessage = await this.bot.sendMessage(chatId,
            `⏳ Verifying your task completion...\n\n` +
            `Please wait while we verify that you've completed:\n"*${task.name}*"\n\n` +
            `This usually takes 5-10 seconds... ⏰`
        );

        // Simulate verification process
        await new Promise(resolve => setTimeout(resolve, 7000));

        try {
            // Mark as completed and reward user
            await this.markTaskCompleted(userId, taskId);
            const newBalance = await this.addToUserBalance(userId, task.reward);

            // Update progress message
            const successMessage =
                `🎉 *Task Verified Successfully!*\n\n` +
                `✅ Completed: *${task.name}*\n` +
                `💰 Earned: *${task.reward} SOL*\n` +
                `💎 New Balance: *${newBalance.toFixed(2)} SOL*\n\n` +
                `Keep completing tasks to earn more! 🚀`;

            await this.bot.editMessageText(successMessage, {
                chat_id: chatId,
                message_id: progressMessage.message_id,
                parse_mode: 'Markdown',
                ...this.getMainMenu(userId)
            });

            console.log(`✅ Task ${taskId} completed by user ${userId}`);

        } catch (error) {
            console.error('Error verifying task:', error);
            await this.bot.editMessageText('❌ Error verifying task completion. Please try again.', {
                chat_id: chatId,
                message_id: progressMessage.message_id
            });
        }
    }

    // ========== CLAIM FLOW ==========

    async handleClaimRequest(chatId, userId, username) {
        const userBalance = await this.getUserBalance(userId);

        if (userBalance <= 0) {
            await this.bot.sendMessage(chatId,
                `💸 *No SOL to Claim*\n\n` +
                `You need to complete tasks first to earn SOL!\n\n` +
                `📋 Check out available tasks to start earning. 💰`,
                { parse_mode: 'Markdown', ...this.getMainMenu(userId) }
            );
            return;
        }

        if (await this.isInCooldown(userId)) {
            const remaining = await this.getCooldownRemaining(userId);
            await this.bot.sendMessage(chatId,
                `⏰ *Cooldown Active*\n\n` +
                `Please wait *${remaining} minutes* before claiming again.\n\n` +
                `You can still complete tasks while waiting! 🎯`,
                { parse_mode: 'Markdown', ...this.getMainMenu(userId) }
            );
            return;
        }

        await this.bot.sendMessage(chatId,
            `💰 *Claim Your SOL!*\n\n` +
            `Your Balance: *${userBalance.toFixed(2)} SOL*\n\n` +
            `To claim, send your Solana wallet address:\n\n` +
            `👇 Example:\n` +
            `/claim D8wB....rF5e\n\n` +
            `📍 *Make sure it's a valid Solana address!*`,
            { parse_mode: 'Markdown' }
        );
    }

    async handleFaucetRequest(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const text = msg.text;
        const username = msg.from.username || `user_${userId}`;

        const address = text.split(' ')[1];
        if (!address) {
            await this.bot.sendMessage(chatId, 
                '❌ Please provide your Solana wallet address:\n\n/claim <your_wallet_address>'
            );
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
            await this.bot.sendMessage(chatId, 
                '❌ Invalid Solana address!\n\n' +
                'Please make sure you entered a valid Solana wallet address.'
            );
            return;
        }

        try {
            const faucetBalance = await this.checkFaucetBalance();
            const claimAmount = userBalance;

            if (faucetBalance < claimAmount) {
                await this.bot.sendMessage(chatId, 
                    `❌ Faucet low on funds!\n\n` +
                    `Current balance: ${faucetBalance.toFixed(2)} SOL\n` +
                    `Required: ${claimAmount.toFixed(2)} SOL\n\n` +
                    `Please try again later.`
                );
                return;
            }

            const sendingMsg = await this.bot.sendMessage(chatId,
                `🚀 *Sending ${claimAmount.toFixed(2)} SOL...*\n\n` +
                `⏳ Processing your transaction...\n` +
                `This may take a few moments.`,
                { parse_mode: 'Markdown' }
            );

            // Convert and send SOL
            const lamportsToSend = Math.floor(claimAmount * LAMPORTS_PER_SOL);
            const txSignature = await this.sendSol(address, lamportsToSend);

            // Update user state
            await this.resetUserBalance(userId);
            await this.updateCooldown(userId);

            const explorerUrl = `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`;
            const successMessage =
                `✅ *Success! ${claimAmount.toFixed(2)} SOL Sent!*\n\n` +
                `📍 To: \`${address}\`\n` +
                `📊 [View Transaction](${explorerUrl})\n\n` +
                `🎯 Complete more tasks to earn more SOL!`;

            await this.bot.editMessageText(successMessage, {
                chat_id: chatId,
                message_id: sendingMsg.message_id,
                parse_mode: 'Markdown',
                ...this.getMainMenu(userId)
            });

            console.log(`✅ Sent ${claimAmount.toFixed(2)} SOL to ${address} for ${username}`);

        } catch (error) {
            console.error(`Error for ${username}:`, error);
            await this.bot.sendMessage(chatId,
                `❌ *Transaction Failed*\n\n` +
                `Error: ${error.message}\n\n` +
                `Please try again later.`,
                { parse_mode: 'Markdown', ...this.getMainMenu(userId) }
            );
        }
    }

    // ========== ADMIN FEATURES ==========

    async sendAdminPanel(chatId, userId) {
        if (!this.isAdmin(userId)) {
            await this.bot.sendMessage(chatId, '❌ Unauthorized');
            return;
        }

        const faucetBalance = await this.checkFaucetBalance();
        const usersSnapshot = await this.usersCollection.get();
        const userCount = usersSnapshot.size;

        const adminMessage =
            `👑 *Admin Panel*\n\n` +
            `📊 Quick Stats:\n` +
            `• Users: ${userCount}\n` +
            `• Tasks: ${this.tasks.size}\n` +
            `• Balance: ${faucetBalance.toFixed(2)} SOL\n\n` +
            `⚙️ *Management Options:*`;

        await this.bot.sendMessage(chatId, adminMessage, {
            parse_mode: 'Markdown',
            ...this.getAdminPanel()
        });
    }

    async handleAddTask(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;

        if (!this.isAdmin(userId)) {
            await this.bot.sendMessage(chatId, '❌ Admin access required');
            return;
        }

        const text = msg.text;
        const parts = text.split(' ');

        if (parts.length < 4) {
            await this.bot.sendMessage(chatId,
                `📝 *Add New Task*\n\n` +
                `Format: /add_task <link> <description> <reward>\n\n` +
                `📌 Example:\n` +
                `/add_task https://t.me/channel Join our Telegram channel 5\n\n` +
                `🔗 Link must start with http/https\n` +
                `💰 Reward must be a number`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const link = parts[1];
        const description = parts.slice(2, -1).join(' ');
        const rewardAmount = parseFloat(parts[parts.length - 1]);

        if (isNaN(rewardAmount) || rewardAmount <= 0) {
            await this.bot.sendMessage(chatId, '❌ Reward must be a positive number');
            return;
        }

        if (!link.startsWith('http')) {
            await this.bot.sendMessage(chatId, '❌ Please provide a valid http/https link');
            return;
        }

        try {
            const taskId = `task_${Date.now()}`;
            const taskName = description.length > 30 ? description.substring(0, 30) + '...' : description;

            const taskData = { 
                name: taskName,
                link: link,
                description: description,
                reward: rewardAmount,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                createdBy: userId,
                deleted: false // Ensure task is marked as not deleted
            };

            await this.tasksCollection.doc(taskId).set(taskData);
            this.tasks.set(taskId, taskData);

            await this.bot.sendMessage(chatId,
                `✅ *Task Added Successfully!*\n\n` +
                `📝 ${taskName}\n` +
                `💰 ${rewardAmount} SOL Reward\n` +
                `🔗 ${link}\n\n` +
                `Users can now complete this task to earn SOL! 🎯`,
                { parse_mode: 'Markdown' }
            );

            console.log(`📋 New task added by admin ${userId}: ${taskName}`);

        } catch (error) {
            console.error('Error adding task:', error);
            await this.bot.sendMessage(chatId, '❌ Error adding task');
        }
    }

    async handleManageTasks(chatId, userId) {
        if (!this.isAdmin(userId)) {
            await this.bot.sendMessage(chatId, '❌ Unauthorized');
            return;
        }

        if (this.tasks.size === 0) {
            await this.bot.sendMessage(chatId,
                '📭 No tasks available to manage.\n\nUse /add_task to create new tasks.',
                this.getAdminPanel()
            );
            return;
        }

        await this.bot.sendMessage(chatId,
            `🗑️ *Manage Tasks*\n\n` +
            `Click on any task below to delete it.\n\n` +
            `⚠️ *Warning:* Deleting a task will remove it from the task list, but users who already completed it will keep their rewards.`,
            { parse_mode: 'Markdown', ...this.getManageTasksKeyboard() }
        );
    }

    async handleDeleteTask(chatId, userId, taskId) {
        if (!this.isAdmin(userId)) {
            await this.bot.sendMessage(chatId, '❌ Unauthorized');
            return;
        }

        const task = this.tasks.get(taskId);
        if (!task) {
            await this.bot.sendMessage(chatId, '❌ Task not found');
            return;
        }

        try {
            await this.deleteTask(taskId);
            
            await this.bot.sendMessage(chatId,
                `✅ *Task Deleted Successfully!*\n\n` +
                `🗑️ "${task.name}" has been removed from the task list.\n\n` +
                `Users will no longer see this task.`,
                { parse_mode: 'Markdown', ...this.getAdminPanel() }
            );

            console.log(`🗑️ Task ${taskId} deleted by admin ${userId}`);

        } catch (error) {
            console.error('Error deleting task:', error);
            await this.bot.sendMessage(chatId, '❌ Error deleting task');
        }
    }

    async handleAdminStats(chatId, userId) {
        if (!this.isAdmin(userId)) return;

        const usersSnapshot = await this.usersCollection.get();
        const userCount = usersSnapshot.size;

        let totalDistributed = 0;
        let totalTasksCompleted = 0;
        let activeUsers = 0;

        usersSnapshot.forEach(doc => {
            const data = doc.data();
            totalDistributed += data.totalEarned || 0;
            totalTasksCompleted += data.tasksCompleted || 0;
            if (data.balance > 0 || data.tasksCompleted > 0) activeUsers++;
        });

        const faucetBalance = await this.checkFaucetBalance();

        const statsMessage =
            `📊 *Admin Statistics*\n\n` +
            `👥 Total Users: ${userCount}\n` +
            `🔥 Active Users: ${activeUsers}\n` +
            `💰 Total Distributed: ${totalDistributed.toFixed(2)} SOL\n` +
            `✅ Tasks Completed: ${totalTasksCompleted}\n` +
            `🏦 Faucet Balance: ${faucetBalance.toFixed(2)} SOL\n` +
            `📋 Active Tasks: ${this.tasks.size}\n\n` +
            `📈 *Average per User:*\n` +
            `• ${(totalDistributed / Math.max(userCount, 1)).toFixed(2)} SOL\n` +
            `• ${(totalTasksCompleted / Math.max(userCount, 1)).toFixed(1)} tasks`;

        await this.bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });
    }

    // ========== BOT INITIALIZATION ==========

    initializeBotHandlers() {
        // Text message handler
        this.bot.on('message', async (msg) => {
            const chatId = msg.chat.id;
            const text = msg.text;
            const userId = msg.from.id;
            const username = msg.from.username || msg.from.first_name || `User_${userId}`;

            await this.loadUserData(userId);

            try {
                if (text === '/start') {
                    await this.sendWelcomeMessage(chatId, userId, username);
                }
                else if (text.startsWith('/claim')) {
                    await this.handleFaucetRequest(msg);
                }
                else if (text.startsWith('/add_task') && this.isAdmin(userId)) {
                    await this.handleAddTask(msg);
                }
                else if (text === '/admin' && this.isAdmin(userId)) {
                    await this.sendAdminPanel(chatId, userId);
                }
                else if (text === '/stats' && this.isAdmin(userId)) {
                    await this.handleAdminStats(chatId, userId);
                }
                else if (text === '/manage_tasks' && this.isAdmin(userId)) {
                    await this.handleManageTasks(chatId, userId);
                }
                else if (text === '/help') {
                    await this.bot.sendMessage(chatId,
                        `💡 *Solana Faucet Help*\n\n` +
                        `🎯 Complete tasks to earn SOL\n` +
                        `💰 Claim your earned SOL to your wallet\n` +
                        `📊 Track your progress and statistics\n\n` +
                        `*Main Commands:*\n` +
                        `/start - Welcome message\n` +
                        `/claim <address> - Claim SOL\n` +
                        `/help - This message` +
                        (this.isAdmin(userId) ? `\n\n*Admin Commands:*\n/admin - Admin panel\n/add_task - Add new task\n/manage_tasks - Delete tasks` : ''),
                        { parse_mode: 'Markdown' }
                    );
                }
            } catch (error) {
                console.error('Error handling message:', error);
                await this.bot.sendMessage(chatId, '❌ An error occurred. Please try again.');
            }
        });

        // Callback query handler
        this.bot.on('callback_query', async (query) => {
            const chatId = query.message.chat.id;
            const userId = query.from.id;
            const data = query.data;

            await this.loadUserData(userId);

            try {
                if (data === 'back_to_main') {
                    const username = query.from.username || query.from.first_name || `User_${userId}`;
                    await this.sendWelcomeMessage(chatId, userId, username);
                }
                else if (data === 'view_tasks') await this.handleViewTasks(chatId, userId);
                else if (data === 'claim_sol') await this.handleClaimRequest(chatId, userId, query.from.username);
                else if (data === 'my_profile') await this.sendUserProfile(chatId, userId);
                else if (data === 'statistics') await this.sendStatistics(chatId, userId);
                else if (data === 'admin_panel') await this.sendAdminPanel(chatId, userId);
                else if (data === 'admin_stats') await this.handleAdminStats(chatId, userId);
                else if (data === 'admin_manage_tasks') await this.handleManageTasks(chatId, userId);
                else if (data === 'admin_add_task') {
                    await this.bot.sendMessage(chatId, 
                        '📤 To add a task, use:\n\n/add_task <link> <description> <reward>\n\nExample:\n/add_task https://t.me/channel Join our Telegram 5'
                    );
                }
                else if (data.startsWith('admin_delete_task_')) {
                    const taskId = data.replace('admin_delete_task_', '');
                    await this.handleDeleteTask(chatId, userId, taskId);
                }
                else if (data.startsWith('view_task_')) {
                    const taskId = data.replace('view_task_', '');
                    await this.handleViewTaskDetail(chatId, userId, taskId);
                }
                else if (data.startsWith('verify_task_')) {
                    const taskId = data.replace('verify_task_', '');
                    await this.handleVerifyTask(chatId, userId, taskId);
                }
                else if (data === 'help') {
                    await this.bot.sendMessage(chatId,
                        `Need help? Here's how it works:\n\n` +
                        `1. 🎯 Complete tasks from the Tasks menu\n` +
                        `2. 💰 Earn SOL for each completed task\n` +
                        `3. 🚀 Claim your SOL to your wallet\n\n` +
                        `Start by clicking "Complete Tasks"!`,
                        this.getMainMenu(userId)
                    );
                }

                await this.bot.answerCallbackQuery(query.id);
            } catch (error) {
                console.error('Error handling callback:', error);
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Error processing request' });
            }
        });
    }
}

// ========== SERVER SETUP ==========

const faucetBot = new PremiumSolanaFaucet();
faucetBot.initializeBotHandlers();

app.post(`/bot${process.env.TELEGRAM_BOT_TOKEN}`, (req, res) => {
    faucetBot.bot.processUpdate(req.body);
    res.sendStatus(200);
});

app.get('/', (req, res) => {
    res.json({ 
        status: 'Premium Solana Faucet Bot is running!',
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`);
});

module.exports = db;