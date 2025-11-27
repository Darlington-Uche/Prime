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

        // PERMANENT Admin IDs - Replace these with your actual admin user IDs
        this.adminIds = [7369158353, 6920738239]; // Hardcoded permanent admin IDs

        // Initialize bot for webhook
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
        this.bot.setWebHook(`${process.env.RENDER_URL}/bot${process.env.TELEGRAM_BOT_TOKEN}`);

        console.log(`🤖 Solana Faucet Bot Started`);
        console.log(`💰 Faucet address: ${this.faucetKeypair.publicKey.toString()}`);
        console.log(`👑 Permanent Admin IDs: ${this.adminIds.join(', ')}`);

        // Load initial data
        this.loadTasks();
        this.checkFaucetBalance();
    }

    // ... rest of your class methods remain exactly the same ...

    async handleAddTask(msg) {
        try {
            const chatId = msg.chat.id;
            const userId = msg.from.id;
            
            // Check if user is admin
            if (!this.adminIds.includes(userId)) {
                await this.bot.sendMessage(chatId, '❌ Unauthorized: Admin access required');
                return;
            }

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

            console.log(`📋 New task added by admin ${userId}: ${taskName}`);
        } catch (error) {
            console.error('Error adding task:', error);
            await this.bot.sendMessage(chatId, '❌ Error adding task');
        }
    }

    async handleCompleteTask(msg) {
        try {
            const chatId = msg.chat.id;
            const userId = msg.from.id;
            
            // Check if user is admin
            if (!this.adminIds.includes(userId)) {
                await this.bot.sendMessage(chatId, '❌ Unauthorized: Admin access required');
                return;
            }

            const text = msg.text;
            const parts = text.split(' ');

            if (parts.length < 3) {
                await this.bot.sendMessage(chatId, '❌ Format: /complete_task <user_id> <task_id>');
                return;
            }

            const targetUserId = parseInt(parts[1]);
            const taskId = parts[2];

            if (!this.tasks.has(taskId)) {
                await this.bot.sendMessage(chatId, '❌ Task not found');
                return;
            }

            if (await this.hasCompletedTask(targetUserId, taskId)) {
                await this.bot.sendMessage(chatId, '❌ User already completed this task');
                return;
            }

            const task = this.tasks.get(taskId);

            // Mark task as completed and update balance
            await this.markTaskCompleted(targetUserId, taskId);
            const newBalance = await this.addToUserBalance(targetUserId, task.reward);

            await this.bot.sendMessage(chatId, 
                `✅ Task completed!\n\nUser ${targetUserId} earned *${task.reward} SOL*\nNew balance: *${newBalance.toFixed(2)} SOL*`, 
                { parse_mode: 'Markdown' }
            );

            // Notify the user if they're in a chat with the bot
            try {
                await this.bot.sendMessage(targetUserId, 
                    `🎉 Task Completed!\n\nYou earned *${task.reward} SOL* for completing "${task.name}"!\nYour balance: *${newBalance.toFixed(2)} SOL*`, 
                    { parse_mode: 'Markdown' }
                );
            } catch (error) {
                console.log('Could not notify user, they may not have started chat with bot');
            }

            console.log(`✅ Task ${taskId} manually completed by admin ${userId} for user ${targetUserId}`);
        } catch (error) {
            console.error('Error completing task:', error);
            await this.bot.sendMessage(chatId, '❌ Error completing task');
        }
    }

    async handleDeleteTask(msg) {
        try {
            const chatId = msg.chat.id;
            const userId = msg.from.id;
            
            // Check if user is admin
            if (!this.adminIds.includes(userId)) {
                await this.bot.sendMessage(chatId, '❌ Unauthorized: Admin access required');
                return;
            }

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
            console.log(`🗑️ Task deleted by admin ${userId}: ${taskId}`);
        } catch (error) {
            console.error('Error deleting task:', error);
            await this.bot.sendMessage(chatId, '❌ Error deleting task');
        }
    }

    async handleStats(msg) {
        try {
            const chatId = msg.chat.id;
            const userId = msg.from.id;
            
            // Check if user is admin
            if (!this.adminIds.includes(userId)) {
                await this.bot.sendMessage(chatId, '❌ Unauthorized: Admin access required');
                return;
            }

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